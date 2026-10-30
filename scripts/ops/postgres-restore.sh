#!/usr/bin/env bash
# M24: restore a logical backup into a clean, isolated PostgreSQL 16 Compose project.
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${RESTORE_COMPOSE_FILE:-$ROOT_DIR/scripts/ops/docker-compose.restore.yml}"
PROJECT_NAME="${RESTORE_PROJECT_NAME:-m24-restore}"
TARGET_USER="${RESTORE_POSTGRES_USER:-restore_admin}"
TARGET_DB="${RESTORE_POSTGRES_DB:-privacy_restore}"
KEEP_TARGET="${RESTORE_KEEP:-0}"
BACKUP_FILE=""
ROLES_FILE=""
MANIFEST_FILE=""

usage() {
  cat <<'EOF'
Usage: bash scripts/ops/postgres-restore.sh --backup FILE [--roles FILE] [--manifest FILE]
Required environment: RESTORE_CONFIRM=RESTORE, RESTORE_POSTGRES_PASSWORD,
RESTORE_APP_ROLE_PASSWORD, RESTORE_BG_ROLE_PASSWORD, RESTORE_JWT_SECRET (>=32),
RESTORE_SOURCE_ENCRYPTION_KEY (>=32).
Optional: RESTORE_PROJECT_NAME, RESTORE_POSTGRES_USER, RESTORE_POSTGRES_DB,
RESTORE_API_PORT, RESTORE_KEEP=1, RESTORE_API_IMAGE, RESTORE_MIGRATE_IMAGE.
EOF
}
fail() { echo "restore: $*" >&2; exit 1; }
# Keep container-local POSIX paths intact when invoked from Git Bash/MSYS.
docker_exec() { MSYS_NO_PATHCONV=1 docker exec "$@"; }
# ---------------------------------------------------------------------------
# F-P4 -- offline PITR branch (ADR-005). OFFLINE ONLY.
#
# Verifies a WAL segment chain against a published physical set and emits an
# isolated-trial recovery config. It NEVER touches Docker, PostgreSQL, the
# network, or production state, and it NEVER declares PITR operational:
# success here proves chain INTEGRITY only (the F-P5 real trial still has to
# prove replay, pg_verifybackup and the time->LSN mapping).
#
# Reachable ONLY via `--pitr` (dispatched below, before any Docke
# prerequisite is evaluated). The logical restore path below is unchanged.
# Fail-closed: any doubt (gap, .partial, label mismatch, unexpected file,
# oversized range) exits non-zero and NEVER prints a success signal. The emitted
# signal is 'pitr=prepared … target=unverified' (H-02, M31.6): reaching a temporal
# goal is NOT proven offline, only the WAL window by LSN is.
# ---------------------------------------------------------------------------
PITR_SEGSIZE_DEFAULT=16777216
PITR_MAX_SEGMENTS=1024
PITR_BASE=""; PITR_WALDIR=""; PITR_UNTIL=""; PITR_UNTIL_LSN=""; PITR_OUT=""; PITR_SEGSIZE=""; PITR_WALCHAIN=""
PITR_MANIFEST=""
pitr_fail() { echo "restore-pitr: $*" >&2; exit 1; }
pitr_usage() {
  cat <<'EOF'
Usage: bash scripts/ops/postgres-restore.sh --pitr --base SET.pmanifest --wal-dir DIR --until 2026-01-02T03:04:05Z --until-lsn 0/3000000 --out DIR [--wal-segsize BYTES] [--wal-chain FILE]
  --wal-chain FILE  complementary WAL chain manifest (M31.4 / F-P6). When omitted,
                    <base>.walchain is used if it exists. It authorises a target
                    beyond the base's own WAL-Ranges using the VERIFIED archived
                    chain, and is always re-verified against --wal-dir first.
  --until-lsn LSN   upper bound of the WAL window that is verified (required). It
                    is an OPERATOR ASSERTION that this LSN corresponds to --until:
                    the emitter cannot prove that relation offline, so it never
                    reports a temporal target as validated (H-02, M31.6).
EOF
}
pitr_mget() {
  printf '%s' "$PITR_MANIFEST" | awk -F= -v k="$1" '$1==k {sub(/^[^=]*=/,""); print; exit}'
}
pitr_val() { strip_cr "$(pitr_mget "$1")"; }
# M31.4/F-P6: same getter for the complementary chain manifest, which is read
# from a file instead of from PITR_MANIFEST.
pitr_chain_get() {
  printf '%s' "$2" | awk -F= -v k="$1" '$1==k {sub(/^[^=]*=/,""); print; exit}'
}
# Print the decimal value of an LSN, or fail closed. Guards the bash int64
# range (8 hex digits per half could overflow it) so arithmetic below is safe.
pitr_parse_lsn() {
  local lsn="$1" hi lo hiv lov
  if [[ "$lsn" =~ ^[0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8}$ ]]; then :; else
    pitr_fail "invalid LSN '$lsn' (expected HEX/HEX, up to 8 digits each)"
  fi
  hi="${lsn%%/*}"; lo="${lsn##*/}"
  hiv=$((16#$hi)); lov=$((16#$lo))
  if (( hiv > 0x7FFFFFFF )); then pitr_fail "LSN '$lsn' exceeds the offline int64 range"; fi
  printf '%s' "$(( hiv * 4294967296 + lov ))"
}
# Canonical PG16 segment name: %08X%08X%08X of (timeline, logid, segno).
pitr_seg_name() { printf '%08X%08X%08X' "$1" "$2" "$3"; }
pitr_parse_args() {
  while (($#)); do
    case "$1" in
      --pitr) shift ;;
      --base) if (($# >= 2)); then PITR_BASE="$2"; shift 2; else pitr_fail "--base needs a file"; fi ;;
      --wal-dir) if (($# >= 2)); then PITR_WALDIR="$2"; shift 2; else pitr_fail "--wal-dir needs a directory"; fi ;;
      --until) if (($# >= 2)); then PITR_UNTIL="$2"; shift 2; else pitr_fail "--until needs a UTC timestamp"; fi ;;
      --until-lsn) if (($# >= 2)); then PITR_UNTIL_LSN="$2"; shift 2; else pitr_fail "--until-lsn needs an LSN"; fi ;;
      --out) if (($# >= 2)); then PITR_OUT="$2"; shift 2; else pitr_fail "--out needs a directory"; fi ;;
      --wal-segsize) if (($# >= 2)); then PITR_SEGSIZE="$2"; shift 2; else pitr_fail "--wal-segsize needs a byte count"; fi ;;
      --wal-chain) if (($# >= 2)); then PITR_WALCHAIN="$2"; shift 2; else pitr_fail "--wal-chain needs a file"; fi ;;
      -h|--help) pitr_usage; exit 0 ;;
      *) pitr_usage >&2; pitr_fail "unknown --pitr argument: $1" ;;
    esac
  done
  if [[ -z "$PITR_BASE" ]]; then pitr_fail "--base is required"; fi
  if [[ -z "$PITR_WALDIR" ]]; then pitr_fail "--wal-dir is required"; fi
  if [[ -z "$PITR_UNTIL" ]]; then pitr_fail "--until is required"; fi
  if [[ -z "$PITR_UNTIL_LSN" ]]; then pitr_fail "--until-lsn is required"; fi
  if [[ -z "$PITR_OUT" ]]; then pitr_fail "--out is required"; fi
}
pitr_run() {
  local man set_id status fmt base_lsn base_tl segsz
  local base_dec until_dec segno0 segno1 logid0 logid1 i span
  local wd_abs out_abs f expected seg tl_hex
  local cnt=0 names=""
  local label label_lsn label_tl base_file base_path
  local per_seg log actual_bytes actual_sha
  local targets=""
  local seg_log_hex="" seg_seg_hex="" seg_log=0 seg_seg=0
  # ---------------------------------------------------------------------------
  # OFFLINE PURITY: the --pitr path must never consult Docker, the network,
  # PostgreSQL, or any secret. Checked structurally by test-ops-pitr-branch.sh.
  # ---------------------------------------------------------------------------
  pitr_parse_args "$@"
  # Sourcing common.sh provides sha256_of / strip_cr / is_sha256 / is_positive_int.
  # shellcheck source=scripts/ops/common.sh
  source "$ROOT_DIR/scripts/ops/common.sh"
  [[ -f "$PITR_BASE" ]] || pitr_fail "--base manifest not found: $PITR_BASE"
  [[ ! -L "$PITR_BASE" ]] || pitr_fail "--base manifest is a symlink; refusing: $PITR_BASE"
  PITR_MANIFEST="$(cat "$PITR_BASE")"
  man="$PITR_BASE"
  # (a) Reuse --verify: the set must be a consumable complete set first.
  bash "$ROOT_DIR/scripts/ops/postgres-physbackup.sh" --verify "$man" >/dev/null 2>&1 \
    || pitr_fail "--verify rejected the base set; refusing PITR"
  # (b) Single supported offline format.
  fmt="$(pitr_val format)"
  [[ "$fmt" == "pg-base-tar-set" ]] \
    || pitr_fail "unsupported base format '$fmt' (offline supports only pg-base-tar-set)"
  set_id="$(pitr_val set_id)"
  status="$(pitr_val status)"
  # (c) Cross-check backup_label inside base.tar: START WAL LOCATION / START
  # TIMELINE must equal the manifest's base_lsn / base_timeline. Read to
  # stdout only (never to disk), mirroring the publisher.
  base_lsn="$(pitr_val base_lsn)"
  base_tl="$(pitr_val base_timeline)"
  base_file="$(pitr_val base_tar_file)"
  [[ "$base_file" == "${set_id}.base.tar" ]] \
    || pitr_fail "base_tar_file '$base_file' is not the expected set member '${set_id}.base.tar'"
  base_path="$(cd "$(dirname "$man")" && pwd -P)/${base_file}"
  [[ -f "$base_path" && ! -L "$base_path" ]] \
    || pitr_fail "base member missing or is a symlink: $base_file"
  label="$(tar -xOf "$base_path" backup_label 2>/dev/null || true)"
  [[ -n "$label" ]] || pitr_fail "base.tar has no backup_label; cannot establish base_lsn/base_timeline"
  label_lsn="$(printf '%s\n' "$label" | awk '/^START WAL LOCATION:/ {print $4; exit}')"
  label_tl="$(printf '%s\n' "$label" | awk '/^START TIMELINE:/ {print $3; exit}')"
  [[ "$label_lsn" == "$base_lsn" ]] \
    || pitr_fail "backup_label START WAL LOCATION '$label_lsn' != manifest base_lsn '$base_lsn'"
  [[ "$label_tl" == "$base_tl" ]] \
    || pitr_fail "backup_label START TIMELINE '$label_tl' != manifest base_timeline '$base_tl'"
  # (d) wal-segsize S: explicit --wal-segsize wins; else the manifest's
  # wal_segsize when present and sane; else the PG default 16MiB. Anything
  # non-positive fails closed (a wrong S silently shifts every segment name).
  if [[ -n "$PITR_SEGSIZE" ]]; then
    segsz="$PITR_SEGSIZE"
  else
    segsz="$(pitr_val wal_segsize)"
    if [[ -z "$segsz" ]]; then segsz="$PITR_SEGSIZE_DEFAULT"; fi
  fi
  is_positive_int "$segsz" \
    || pitr_fail "wal segment size is not a positive integer (got '${segsz:-<empty>}')"
  # (e) Verified LSN math. PG16: segno = LSN / S (XLByteToSeg), and
  # XLogSegmentsPerXLogId = 0x100000000 / S gives segments per logid.
  # XLogFileName = %08X%08X%08X(TLI, logid, segno-within-log). The offline
  # branch covers the common case only: the [base_lsn, until_lsn] range must
  # stay inside ONE logid (no wraparound); anything else fails closed.
  base_dec="$(pitr_parse_lsn "$base_lsn")"
  until_dec="$(pitr_parse_lsn "$PITR_UNTIL_LSN")"
  (( until_dec >= base_dec )) \
    || pitr_fail "--until-lsn $PITR_UNTIL_LSN is before base_lsn $base_lsn"
  per_seg=$(( 4294967296 / segsz ))
  (( 4294967296 % segsz == 0 )) \
    || pitr_fail "wal segment size $segsz does not divide 4GiB; refusing offline math"
  logid0=$(( base_dec / 4294967296 ))
  logid1=$(( until_dec / 4294967296 ))
  (( logid0 == logid1 )) \
    || pitr_fail "LSN range crosses a logid boundary (offline supports one logid only)"
  log="$logid0"
  segno0=$(( (base_dec % 4294967296) / segsz ))
  segno1=$(( (until_dec % 4294967296) / segsz ))
  span=$(( segno1 - segno0 + 1 ))
  (( span >= 1 && span <= PITR_MAX_SEGMENTS )) \
    || pitr_fail "WAL span $span segments exceeds the offline cap ($PITR_MAX_SEGMENTS)"
  # (f1) Coverage authorisation. Two mutually exclusive sources:
  #   * the COMPLEMENTARY WAL chain manifest (M31.4 / F-P6), when supplied with
  #     --wal-chain or found as <base>.walchain: it is re-verified against
  #     --wal-dir (presence, size, SHA-256 and contiguity from the segment that
  #     contains base_lsn) and authorises any target inside the coverage the
  #     artefacts can actually prove. This fixes defect R1: the .pmanifest alone
  #     declares only the ranges pg_basebackup itself streamed, so a target
  #     beyond them was refused even when the archived chain covered it.
  #   * otherwise, the legacy WAL-Ranges walk below, unchanged.
  local chain_file chain_used=0
  chain_file="$PITR_WALCHAIN"
  if [[ -z "$chain_file" ]]; then
    chain_file="${PITR_BASE%.pmanifest}.walchain"
    [[ -f "$chain_file" ]] || chain_file=""
  fi
  if [[ -n "$chain_file" ]]; then
    [[ -f "$chain_file" ]] || pitr_fail "--wal-chain not found: $chain_file"
    [[ ! -L "$chain_file" ]] || pitr_fail "--wal-chain is a symlink; refusing: $chain_file"
    bash "$ROOT_DIR/scripts/ops/wal-chain-manifest.sh" --verify --chain "$chain_file" \
      --wal-dir "$PITR_WALDIR" --set-dir "$(dirname "$PITR_BASE")" >/dev/null 2>&1 \
      || pitr_fail "the WAL chain manifest does not verify against --wal-dir and the physical set: $chain_file"
    local cman c_set c_lsn c_tl c_start c_end
    cman="$(cat "$chain_file")"
    c_set="$(strip_cr "$(pitr_chain_get base_set "$cman")")"
    [[ "$c_set" == "$set_id" ]] || pitr_fail "chain base_set '$c_set' does not match base set_id '$set_id'"
    c_lsn="$(strip_cr "$(pitr_chain_get base_lsn "$cman")")"
    [[ "$(pitr_parse_lsn "$c_lsn")" == "$base_dec" ]] \
      || pitr_fail "chain base_lsn '$c_lsn' does not match the base manifest base_lsn '$base_lsn'"
    c_tl="$(strip_cr "$(pitr_chain_get base_timeline "$cman")")"
    [[ "$c_tl" == "$base_tl" ]] || pitr_fail "chain base_timeline '$c_tl' does not match base_timeline '$base_tl'"
    c_start="$(strip_cr "$(pitr_chain_get coverage_start_lsn "$cman")")"
    c_end="$(strip_cr "$(pitr_chain_get coverage_end_lsn "$cman")")"
    [[ "$(pitr_parse_lsn "$c_start")" -le "$base_dec" ]] \
      || pitr_fail "chain coverage does not start at or before base_lsn ($c_start > $base_lsn)"
    [[ "$until_dec" -le "$(pitr_parse_lsn "$c_end")" ]] \
      || pitr_fail "recovery window [$base_lsn..$PITR_UNTIL_LSN] is not covered by the verified WAL chain (coverage ends at $c_end)"
    chain_used=1
    echo "restore-pitr: coverage authorised by the verified WAL chain ($chain_file; coverage $c_start..$c_end)" >&2
  fi

  # (f2) Legacy coverage: read and validate WAL-Ranges from the base manifest.
  #      Declared ranges must sit on the base timeline (offline timeline='current'
  #      does not support timeline switching), and the recovery window
  #      [base_lsn, until_lsn] must be fully covered by their union. Skipped
  #      entirely when the verified chain above already authorised the window.
  if (( chain_used == 0 )); then
  wal_range_count="$(strip_cr "$(pitr_mget wal_range_count)")"
  [[ -n "$wal_range_count" ]] || pitr_fail "manifest is missing wal_range_count"
  [[ "$wal_range_count" =~ ^[0-9]+$ ]] || pitr_fail "manifest wal_range_count is not a non-negative integer (got '$wal_range_count')"
  [[ "$wal_range_count" -gt 0 ]] || pitr_fail "manifest wal_range_count is 0; PITR requires WAL-Ranges to validate recovery coverage"
  n=0
  local -a range_starts=()
  local -a range_ends=()
  while true; do
    n=$((n + 1))
    wl_tl="$(strip_cr "$(pitr_mget "wal_range_${n}_timeline")")"
    wl_st="$(strip_cr "$(pitr_mget "wal_range_${n}_start_lsn")")"
    wl_en="$(strip_cr "$(pitr_mget "wal_range_${n}_end_lsn")")"
    if [[ -z "$wl_tl" && -z "$wl_st" && -z "$wl_en" ]]; then
      break
    fi
    if (( n > wal_range_count )); then
      pitr_fail "manifest has wal_range_${n}_* but wal_range_count=$wal_range_count"
    fi
    [[ -n "$wl_tl" && -n "$wl_st" && -n "$wl_en" ]] || pitr_fail "manifest wal_range_${n}_* is incomplete"
    [[ "$wl_tl" =~ ^[0-9]+$ ]] || pitr_fail "manifest wal_range_${n}_timeline is not a positive integer (got '$wl_tl')"
    [[ "$wl_tl" -gt 0 ]] || pitr_fail "manifest wal_range_${n}_timeline must be positive (got '$wl_tl')"
    [[ "$wl_tl" == "$base_tl" ]] || pitr_fail "manifest wal_range_${n}_timeline $wl_tl != base_timeline $base_tl (offline timeline='current' does not support timeline switching)"
    [[ "$wl_st" =~ ^[0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8}$ ]] || pitr_fail "manifest wal_range_${n}_start_lsn is not HEX/HEX (got '$wl_st')"
    [[ "$wl_en" =~ ^[0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8}$ ]] || pitr_fail "manifest wal_range_${n}_end_lsn is not HEX/HEX (got '$wl_en')"
    wl_st_dec="$(pitr_parse_lsn "$wl_st")"
    wl_en_dec="$(pitr_parse_lsn "$wl_en")"
    if (( wl_st_dec > wl_en_dec )); then
      pitr_fail "manifest wal_range_${n} Start-LSN $wl_st > End-LSN $wl_en"
    fi
    range_starts+=("$wl_st_dec")
    range_ends+=("$wl_en_dec")
  done
  [[ ${#range_starts[@]} -eq $wal_range_count ]] || pitr_fail "manifest wal_range_count=$wal_range_count but found ${#range_starts[@]} range entries"
  # Coverage walk: starting from base_dec, extend through overlapping/contiguous
  # declared ranges until reaching or exceeding until_dec. Any gap fails closed.
  cursor="$base_dec"
  end_reached=0
  for (( pass=0; pass < wal_range_count; pass++ )); do
    best_end="$cursor"
    for (( r=0; r < wal_range_count; r++ )); do
      if [[ ${range_starts[$r]} -le $cursor && ${range_ends[$r]} -ge $cursor ]]; then
        if [[ ${range_ends[$r]} -gt $best_end ]]; then
          best_end="${range_ends[$r]}"
        fi
      fi
    done
    if [[ $best_end -eq $cursor ]]; then
      break
    fi
    cursor=$(( best_end + 1 ))
    if [[ $cursor -gt $until_dec ]]; then
      end_reached=1
      break
    fi
  done
  [[ $end_reached -eq 1 ]] || pitr_fail "recovery window [$base_lsn..$PITR_UNTIL_LSN] is not fully covered by the declared WAL-Ranges"
  fi
  # (f) Fail-closed directory scan. Every REQUIRED name must exist as a
  # regular non-symlink file; .partial is rejected outright; timeline check is
  # scoped to the replay set (foreign-timeline strays outside it are listed,
  # never consumed); gaps, dups, wrong sizes and unknown strays all fail.
  [[ -d "$PITR_WALDIR" ]] || pitr_fail "--wal-dir is not a directory: $PITR_WALDIR"
  wd_abs="$(cd "$PITR_WALDIR" && pwd -P)"
  [[ -n "$PITR_OUT" ]] || pitr_fail "--out is required"
  mkdir -p "$PITR_OUT" || pitr_fail "cannot create --out directory: $PITR_OUT"
  out_abs="$(cd "$PITR_OUT" && pwd -P)"
  [[ "$out_abs" != "$wd_abs" ]] || pitr_fail "--out must differ from --wal-dir"
  tl_hex="$(printf '%08X' "$base_tl")"
  for (( i = segno0; i <= segno1; i++ )); do
    expected="$(pitr_seg_name "$base_tl" "$log" "$i")"
    [[ -e "$wd_abs/$expected" ]] || pitr_fail "missing required WAL segment: $expected"
    [[ ! -L "$wd_abs/$expected" ]] || pitr_fail "WAL segment is a symlink; refusing: $expected"
    [[ -f "$wd_abs/$expected" ]] || pitr_fail "WAL segment is not a regular file: $expected"
    actual_bytes="$(wc -c < "$wd_abs/$expected" | tr -d ' \r\n')"
    [[ "$actual_bytes" == "$segsz" ]] \
      || pitr_fail "WAL segment $expected has size $actual_bytes, expected $segsz"
    actual_sha="$(sha256_of "$wd_abs/$expected")"
    is_sha256 "$actual_sha" \
      || pitr_fail "could not compute a valid SHA-256 for $expected"
    echo "restore-pitr: verified segment $expected (sha256=$actual_sha)" >&2
    names="${names}${expected}
"
    cnt=$((cnt + 1))
  done
  # Replay-scoped timeline check + stray classification. Canonical 24-uppercase-
  # hex files whose (log,segno) falls inside the replay window but carry a
  # DIFFERENT timeline make the replay source ambiguous -> fail. Canonical
  # files outside the window are listed (warning) and never consumed.
  # *.history files are listed and ignored (timeline history, not WAL data).
  # *.backup files (<segment>.<tli>.backup, left in the source pg_wal by
  # pg_basebackup) are likewise archived by PostgreSQL but are NOT replayable WAL
  # data; refusing them aborted the documented PITR flow end-to-end (M31.3).
  # Anything else (including *.partial, caught first) fails closed.
  for f in "$wd_abs"/*; do
    [[ -e "$f" ]] || continue
    seg="$(basename "$f")"
    case "$seg" in
      *.partial) pitr_fail "partial WAL file present; refusing: $seg" ;;
      *.history)
        echo "restore-pitr: note timeline history file ignored (never replayed): $seg" >&2
        continue
        ;;
      *.backup)
        echo "restore-pitr: note backup history file ignored (never replayed): $seg" >&2
        continue
        ;;
    esac
    if [[ "$seg" =~ ^[0-9A-F]{24}$ ]]; then
      seg_log_hex="${seg:8:8}"; seg_seg_hex="${seg:16:8}"
      seg_log=$((16#$seg_log_hex)); seg_seg=$((16#$seg_seg_hex))
      # Bash treats the arithmetic above as decimal-safe: hex digits carry no
      # leading-zero octal trap under the 16# prefix.
      if (( seg_log == log && seg_seg >= segno0 && seg_seg <= segno1 )); then
        [[ "${seg:0:8}" == "$tl_hex" ]] \
          || pitr_fail "ambiguous replay source in window: $seg (expected timeline $tl_hex)"
      else
        echo "restore-pitr: note out-of-window segment listed, not consumed: $seg" >&2
      fi
      continue
    fi
    pitr_fail "unexpected file in --wal-dir; refusing: $seg"
  done
  # (g) Emit the isolated-trial recovery config. Exactly ONE primary target
  # (F-P4 single-target criterion): recovery_target_time + inclusive=on +
  # action=promote (isolated trial ONLY) + timeline=current. No
  # recovery_target_{lsn,xid,name} line may exist alongside it.
  #
  # recovery_target_timeline = 'current' se elige porque el escenario F-P4 es
  # recuperación en la MISMA timeline del backup físico (PITR isolado sin
  # cambio de bifurcación). 'latest' implicaría seguir .history a través de
  # bifurcaciones de timeline (requiere análisis de archivos de histórico no
  # implementado en esta fase); un ID concreto apuntaría a una bifurcación
  # específica. Ninguna de esas dos alternativas aplica al escenario de este
  # trial aislado; se documenta aquí para que cualquier cambio a 'latest' o a
  # un ID requiera justificación de escenario antes de tocar este valor.
  [[ "$PITR_UNTIL" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || pitr_fail "--until must be UTC 'YYYY-MM-DDTHH:MM:SSZ' (got '$PITR_UNTIL')"
  {
    printf '# F-P4 offline PITR proposal for an ISOLATED trial (ADR-005).\n'
    printf '# NOT production config. Single recovery target by construction.\n'
    printf '# recovery_target_time is a TEMPORAL GOAL: this script proves the WAL window\n'
    printf '# by LSN, but reaching the requested instant is NOT proven offline (H-02).\n'
    printf 'restore_command = %s\n' "'cp \"$wd_abs/%f\" \"%p\"'"
    # PG16 rejects the ISO 'Z' suffix for this GUC value (verified on 16.15:
    # LOG "invalid value for parameter \"recovery_target_time\": \"...Z\"" followed
    # by FATAL "configuration file contains errors"), so the SAME instant is emitted
    # with an explicit +00 UTC offset, which PostgreSQL accepts. The CLI contract is
    # unchanged: --until still requires strict 'YYYY-MM-DDTHH:MM:SSZ'.
    printf 'recovery_target_time = %s\n' "'${PITR_UNTIL%Z}+00'"
    printf 'recovery_target_inclusive = on\n'
    printf 'recovery_target_timeline = %s\n' "'current'"
    printf 'recovery_target_action = promote\n'
  } > "$out_abs/postgresql.pitr.conf"
  : > "$out_abs/recovery.signal"
  printf '%s' "$names" > "$out_abs/segment-list.txt"
  targets="$(grep -cE '^recovery_target_(time|lsn|xid|name) =' "$out_abs/postgresql.pitr.conf")"
  (( targets == 1 )) || pitr_fail "emitted config must hold exactly one primary target (found $targets)"
  echo "restore-pitr: base=$set_id segments=$cnt window=[$(pitr_seg_name "$base_tl" "$log" "$segno0")..$(pitr_seg_name "$base_tl" "$log" "$segno1")] (offline; integrity only)" >&2
  echo "restore-pitr: recovery config written to $out_abs (isolated trial proposal; PITR NOT operational)" >&2
  # H-02 (M31.6): the WAL WINDOW is verified by LSN, but the time->LSN relation is
  # an OPERATOR ASSERTION that cannot be proven offline (no timestamp-to-LSN map
  # exists in the artefacts, and a pg_current_wal_lsn() read at some other moment
  # is not proof). The signal is therefore 'prepared', never a success: PostgreSQL
  # confirms the target during recovery (that is the F-P5 gate).
  echo "restore-pitr: NOTE --until=$PITR_UNTIL is a temporal GOAL, not a verified target; the time->LSN relation is an external assertion" >&2
  echo "pitr=prepared base=$set_id segments=$cnt until=$PITR_UNTIL until_lsn=$PITR_UNTIL_LSN chain=$chain_used target=unverified out=$out_abs"
}
##F-P4-REST##
# --pitr dispatch: scanned BEFORE any Docker prerequisite so the offline branch
# stays reachable (and provably offline) on hosts without a daemon. The scan
# is literal: only an exact `--pitr` token dispatches; nothing is executed yet.
# Mixed with logical flags (--backup/--roles/--manifest) it refuses: the two
# restore modes never share one invocation.
for _a in "$@"; do
  if [[ "$_a" == "--pitr" ]]; then
    for _b in "$@"; do
      case "$_b" in
        --backup|--roles|--manifest)
          pitr_usage >&2
          pitr_fail "--pitr cannot be combined with $_b (logical and PITR modes are exclusive)"
          ;;
      esac
    done
    unset _b
    pitr_run "$@"; exit $?
  fi
done
unset _a
command -v docker >/dev/null 2>&1 || fail "docker is required"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
while (($#)); do
  case "$1" in
    --backup) [[ $# -ge 2 ]] || fail "--backup needs a file"; BACKUP_FILE="$2"; shift 2 ;;
    --roles) [[ $# -ge 2 ]] || fail "--roles needs a file"; ROLES_FILE="$2"; shift 2 ;;
    --manifest) [[ $# -ge 2 ]] || fail "--manifest needs a file"; MANIFEST_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done
[[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]] || fail "--backup must point to an existing dump"
[[ "$KEEP_TARGET" == 0 || "$KEEP_TARGET" == 1 ]] || fail "RESTORE_KEEP must be 0 or 1"
[[ "${RESTORE_CONFIRM:-}" == RESTORE ]] || fail "set RESTORE_CONFIRM=RESTORE after reviewing the target project"
for name in RESTORE_POSTGRES_PASSWORD RESTORE_APP_ROLE_PASSWORD RESTORE_BG_ROLE_PASSWORD RESTORE_JWT_SECRET RESTORE_SOURCE_ENCRYPTION_KEY; do
  [[ -n "${!name-}" ]] || fail "$name is required"
done
[[ ${#RESTORE_JWT_SECRET} -ge 32 ]] || fail "RESTORE_JWT_SECRET must be at least 32 characters"
# M25.5: this is the earliest structural check. It cannot tell whether the key
# belongs to this backup, because that comparison needs sha256(sha256(key)) and
# so runs inside the migrate container later, where it aborts before anything is
# declared usable. Failing here instead just avoids wasting an image build.
[[ ${#RESTORE_SOURCE_ENCRYPTION_KEY} -ge 32 ]] || fail "RESTORE_SOURCE_ENCRYPTION_KEY must be at least 32 characters and must be the key that encrypted this backup (M25.3 verifies it before the restore is declared usable)"

BACKUP_FILE="$(cd "$(dirname "$BACKUP_FILE")" && pwd -P)/$(basename "$BACKUP_FILE")"
# M27.0: `base` carries the directory here, unlike in offhost-upload.sh where it
# is an object key component and an absolute path would escape the credential's
# namePrefix. Here the expansion is only used to reach sibling files, so an
# absolute sibling path was always correct. It is normalised anyway so the same
# variable means the same thing in both scripts, and so a caller that late
# reuses `base` for anything other than a local path does not inherit a
# surprise. Deriving the siblings from the captured directory keeps them
# absolute and identical to the previous behaviour.
backup_dir="$(dirname "$BACKUP_FILE")"
base="$(basename "${BACKUP_FILE%.dump}")"
ROLES_FILE="${ROLES_FILE:-$backup_dir/${base}.roles.sql}"
MANIFEST_FILE="${MANIFEST_FILE:-$backup_dir/${base}.manifest}"
[[ -f "$ROLES_FILE" ]] || fail "roles export not found: $ROLES_FILE"
[[ -f "$MANIFEST_FILE" ]] || fail "manifest not found: $MANIFEST_FILE"
ROLES_SQL_FILE="${RESTORE_ROLES_SQL:-$ROOT_DIR/scripts/ops/restore-roles.sql}"
[[ -f "$ROLES_SQL_FILE" ]] || fail "safe role bootstrap not found: $ROLES_SQL_FILE"
cd "$ROOT_DIR"
if [[ "$COMPOSE_FILE" != /* ]]; then COMPOSE_FILE="$ROOT_DIR/$COMPOSE_FILE"; fi
# shellcheck source=scripts/ops/common.sh
source "$ROOT_DIR/scripts/ops/common.sh"

sha256() { sha256_of "$1"; }
# M25.5: trailing CR is stripped by strip_cr so a manifest edited on Windows and
# restored on Linux behaves identically. MSYS awk already discards it, but Linux
# awk does not, and the same manifest would otherwise be accepted on one host
# and rejected on the other.
manifest_value() { strip_cr "$(awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$MANIFEST_FILE")"; }
# M25.5: read a manifest hash, drop the historical leading backslash and require a
# well-formed digest. Comparing a malformed value would otherwise be reported as
# a plain "checksum mismatch", hiding the real cause.
read_manifest_sha() {
  local raw normalized
  raw="$(manifest_value "$1")"
  [[ -n "$raw" ]] || fail "manifest lacks $1"
  normalized="$(strip_sha_prefix "$raw")"
  is_sha256 "$normalized" || fail "manifest $1 is not a valid 64-character SHA-256"
  printf '%s' "$normalized"
}
verify_sha() {
  local file="$1" key="$2" expected actual
  expected="$(read_manifest_sha "$key")"
  actual="$(sha256 "$file")"
  is_sha256 "$actual" || fail "computed checksum for $file is not a valid SHA-256"
  [[ "$actual" == "$expected" ]] || fail "checksum mismatch for $file"
}
verify_sha "$BACKUP_FILE" dump_sha256
verify_sha "$ROLES_FILE" roles_sha256
# The roles export is retained as a checksum-protected inventory artifact.
# It is NOT executed: it contains cluster-level role definitions. Runtime
# roles are created by the reviewed, least-privilege bootstrap below.

export RESTORE_POSTGRES_USER="$TARGET_USER" RESTORE_POSTGRES_DB="$TARGET_DB"
COMPOSE_ARGS=(-p "$PROJECT_NAME" -f "$COMPOSE_FILE")
restore_compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }
wait_for_postgres() {
  local attempt
  for attempt in $(seq 1 60); do
    if docker_exec "$db_id" psql -U "$TARGET_USER" -d "$TARGET_DB" -Atqc 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

existing_containers="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT_NAME")"
existing_volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT_NAME")"
if [[ -n "$existing_containers" || -n "$existing_volumes" ]]; then
  [[ "${RESTORE_REPLACE:-0}" == 1 ]] || fail "restore project/volume already exists; use a new project or explicitly set RESTORE_REPLACE=1"
  echo "restore: replacing existing project resources because RESTORE_REPLACE=1" >&2
  restore_compose down --volumes --remove-orphans >/dev/null 2>&1 || true
fi
db_id=""
cleanup() {
  if [[ -n "$db_id" ]]; then
    docker_exec "$db_id" rm -f "/tmp/$(basename "$BACKUP_FILE")" >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP_TARGET" != 1 ]]; then
    restore_compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "restore: starting isolated PostgreSQL project $PROJECT_NAME"
restore_compose up -d db
db_id="$(restore_compose ps -q db)"
[[ -n "$db_id" ]] || fail "restore database container did not start"
wait_for_postgres || fail "restore PostgreSQL did not become ready"
nonempty="$(docker_exec "$db_id" psql -U "$TARGET_USER" -d "$TARGET_DB" -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND c.relkind IN ('r','p');")"
[[ "$nonempty" == 0 ]] || fail "target database is not empty; use a new volume/project for a safe restore"

# The exported role file is inventory only; create least-privilege runtime roles.
docker_exec -i "$db_id" psql -v ON_ERROR_STOP=1 -U "$TARGET_USER" -d "$TARGET_DB" < "$ROLES_SQL_FILE" >/dev/null
remote="/tmp/$(basename "$BACKUP_FILE")"
docker cp "$BACKUP_FILE" "$db_id:$remote" >/dev/null
docker_exec "$db_id" pg_restore --list "$remote" >/dev/null
echo "restore: applying database archive"
docker_exec "$db_id" pg_restore --exit-on-error --single-transaction --no-owner --username="$TARGET_USER" --dbname="$TARGET_DB" "$remote"
docker_exec "$db_id" rm -f "$remote"

# --- M25.5: integridad del journal, ANTES de migrar ------------------------
#
# Se compara aqui, y no despues, a proposito. Si el restore migra hacia adelante
# un dump antiguo, el journal crece y la comparacion siempre fallaria, rompiendo
# justamente la recuperacion de backups viejos, que es el proposito del DR.
# Tras migrar se conserva la comprobacion de migration_count como garantia
# adicional de completitud.
verify_migration_journal() {
  local expected actual
  expected="$(strip_sha_prefix "$(manifest_value migration_journal_sha256 || true)")"
  if [[ -z "$expected" ]]; then
    echo "restore: WARNING manifest has no migration_journal_sha256 (backup predates M25.5);" >&2
    echo "restore: WARNING only the migration count will be verified" >&2
    return 0
  fi
  is_sha256 "$expected" || fail "manifest migration_journal_sha256 is not a valid 64-character SHA-256"
  actual="$(journal_sha256_of "$db_id" "$TARGET_USER" "$TARGET_DB")"
  [[ "$actual" == "$expected" ]] \
    || fail "migration journal mismatch: the restored database does not match this backup (expected $expected, got $actual)"
  echo "verified migration journal sha256=$actual"
}

# Deteccion de deriva codigo <-> datos. Solo aviso: restaurar un backup antiguo
# es precisamente lo que debe permitir el DR, asi que una divergencia con los
# .sql actuales informa, pero nunca bloquea la recuperacion. Drizzle decide
# "ya aplicada" por created_at y nunca compara el hash, de modo que una
# migracion editada se omite en silencio: este aviso es la unica señal.
warn_on_migration_drift() {
  local dir="$ROOT_DIR/lib/db/drizzle"
  [[ -d "$dir" ]] || return 0
  local journal_hashes file_hashes missing
  journal_hashes="$(docker_exec "$db_id" psql -U "$TARGET_USER" -d "$TARGET_DB" -Atc \
    "SELECT DISTINCT hash FROM drizzle.__drizzle_migrations ORDER BY hash;" 2>/dev/null || true)"
  [[ -n "$journal_hashes" ]] || return 0
  file_hashes="$(for f in "$dir"/*.sql; do [[ -f "$f" ]] && sha256_of "$f"; done | sort)"
  missing="$(comm -23 <(printf '%s\n' "$journal_hashes" | sort) <(printf '%s\n' "$file_hashes" | sort) | head -n 5)"
  if [[ -n "$missing" ]]; then
    echo "restore: WARNING the restored migration journal does not match the current .sql files." >&2
    echo "restore: WARNING drizzle skips already-applied migrations by timestamp, so an edited" >&2
    echo "restore: WARNING migration leaves the restored schema divergent from the code. Affected:" >&2
    printf 'restore: WARNING   %s\n' "$missing" >&2
    echo "restore: WARNING this is informational: the restore continues." >&2
  fi
}
verify_migration_journal
warn_on_migration_drift

echo "restore: running migrations and starting API"
# Build sequentially: parallel API/migrate builds can contend on Docker BuildKit's
# shared pnpm store on constrained runners. Operators may provide already-built
# images for a local drill; CI and normal restores leave these unset and build.
if [[ -n "${RESTORE_MIGRATE_IMAGE:-}" ]]; then
  echo "restore: using prebuilt migrate image $RESTORE_MIGRATE_IMAGE"
else
  restore_compose build migrate
fi
if [[ -n "${RESTORE_API_IMAGE:-}" ]]; then
  echo "restore: using prebuilt API image $RESTORE_API_IMAGE"
else
  restore_compose build api
fi
restore_compose up -d --wait --no-build api
api_id="$(restore_compose ps -q api)"
[[ -n "$api_id" ]] || fail "API did not start after restore"
docker_exec "$api_id" node -e "fetch('http://127.0.0.1:5000/api/livez').then(async r=>{if(!r.ok)process.exit(1); console.log(await r.text())}).catch(()=>process.exit(1))"
docker_exec "$api_id" node -e "fetch('http://127.0.0.1:5000/api/readyz').then(async r=>{if(!r.ok)process.exit(1); console.log(await r.text())}).catch(()=>process.exit(1))"

verified=0
while IFS='=' read -r key expected; do
  # Same mechanism as manifest_value: this loop reads the manifest directly with
  # grep, so without strip_cr a CRLF manifest would fail the count comparison on
  # Linux while passing on Git Bash, where read discards the CR by itself.
  expected="$(strip_cr "$expected")"
  case "$key" in
    count_*)
      table="${key#count_}"
      actual="$(docker_exec "$db_id" psql -U "$TARGET_USER" -d "$TARGET_DB" -Atc "SELECT count(*) FROM \"$table\";")"
      [[ "$actual" == "$expected" ]] || fail "row-count mismatch for $table: expected $expected, got $actual"
      echo "verified $table=$actual"
      verified=1
      ;;
  esac
done < <(grep '^count_' "$MANIFEST_FILE" || true)
[[ "$verified" == 1 ]] || fail "manifest contains no row-count checks"
# RLS coverage must match migration 0018 exactly: every protected table keeps both
# ENABLE and FORCE ROW LEVEL SECURITY. Verifying only one table would let a restore
# finish green with the rest of the tenant tables unprotected.
rls_tables=(sources findings reports activity scans scan_schedules masking_jobs)
rls_report="$(
  docker_exec "$db_id" psql -U "$TARGET_USER" -d "$TARGET_DB" -At -F '|' -c "
    SELECT t.name, c.relrowsecurity, c.relforcerowsecurity
    FROM unnest(ARRAY['sources','findings','reports','activity','scans','scan_schedules','masking_jobs']) AS t(name)
    LEFT JOIN pg_class c
      ON c.relname = t.name AND c.relnamespace = 'public'::regnamespace
    ORDER BY t.name;"
)"
rls_seen=0
rls_broken=0
while IFS='|' read -r table enabled forced; do
  [[ -n "$table" ]] || continue
  rls_seen=$((rls_seen + 1))
  if [[ "$enabled" == "t" && "$forced" == "t" ]]; then
    echo "verified rls $table enable+force"
  else
    echo "restore: $table missing RLS (enabled=${enabled:-absent} forced=${forced:-absent})" >&2
    rls_broken=$((rls_broken + 1))
  fi
done <<< "$rls_report"
if [[ "$rls_seen" != "${#rls_tables[@]}" ]]; then
  missing="$(comm -23 <(printf '%s\n' "${rls_tables[@]}" | sort) <(printf '%s\n' "$rls_report" | cut -d'|' -f1 | sort) | tr '\n' ' ')"
  fail "RLS verification covered $rls_seen of ${#rls_tables[@]} protected tables; missing: $missing"
fi
[[ "$rls_broken" == 0 ]] || fail "$rls_broken of ${#rls_tables[@]} RLS-protected tables lost ENABLE/FORCE ROW LEVEL SECURITY"

# Runtime roles must keep the attributes restore-roles.sql grants them: app_role is
# the tenant-scoped runtime role and must NOT bypass RLS; bg_role is the background
# worker role and is expected to bypass it. A dump that resurrects app_role as a
# BYPASSRLS role silently voids tenant isolation.
assert_role_bypassrls() {
  local role="$1" expected="$2" actual
  actual="$(docker_exec "$db_id" psql -U "$TARGET_USER" -d "$TARGET_DB" -Atc \
    "SELECT rolbypassrls FROM pg_roles WHERE rolname = '$role';")"
  [[ -n "$actual" ]] || fail "role $role does not exist after restore"
  [[ "$actual" == "$expected" ]] \
    || fail "role $role has rolbypassrls=$actual but $expected was required"
  echo "verified role $role bypassrls=$actual"
}
assert_role_bypassrls app_role f
assert_role_bypassrls bg_role t


expected_migrations="$(manifest_value migration_count)"
actual_migrations="$(docker_exec "$db_id" psql -U "$TARGET_USER" -d "$TARGET_DB" -Atc 'SELECT count(*) FROM drizzle.__drizzle_migrations;')"
[[ "$actual_migrations" == "$expected_migrations" ]] || fail "migration-count mismatch: expected $expected_migrations, got $actual_migrations"

# --- M25.3: verificacion de SOURCE_ENCRYPTION_KEY ----------------------------
#
# M24 validaba checksums, conteos, RLS y roles, pero NUNCA descifraba. Un restore
# hecho con la clave equivocada pasaba todos esos criterios y aun asi dejaba
# todas las fuentes sin conectar. Aqui se comprueba la clave de verdad.
#
# El check corre en el contenedor `migrate` porque es el unico del stack con node
# y `pg` resoluble (`pg` solo resuelve desde /repo/lib/db). La clave se inyecta
# solo en ese `run` one-shot con `-e`, sin tocar docker-compose.restore.yml, y el
# script se pasa por stdin para no dejar ficheros en la imagen.
# The key_check one-shot needs the real SOURCE_ENCRYPTION_KEY, but that
# value must never appear in host argv (ps / /proc/*/cmdline), the same
# class fixed for PGPASSWORD in run_real_basebackup (M-2). The private
# env-file below is the equivalent mechanism for `docker compose run`,
# which reads container env from --env-from-file (NOT the interpolation
# --env-file). Only the file PATH reaches argv; the two VALUES travel
# inside the file, are consumed client-side by Compose, and the file is
# removed on success, on error and through the EXIT trap on signals.
# This narrows exposure to local argv/process inspection; it does NOT
# protect against a host administrator, privileged host inspection, any
# process able to read our 600-mode temp files, or anything able to read
# the Docker API traffic or the resulting in-container environment.
RESTORE_KEY_FILE=""
cleanup_restore_keyfile() {
  if [[ -n "${RESTORE_KEY_FILE:-}" && -f "$RESTORE_KEY_FILE" && ! -L "$RESTORE_KEY_FILE" ]]; then
    rm -f "$RESTORE_KEY_FILE" 2>/dev/null || true
  fi
}
# The EXIT trap must ALSO run the original `cleanup` (compose down + in-containe
# temp removal) that line 135 installed; replacing it here would leave the
# isolated project/volume orphaned on exit. Both functions are defined by the
# time this fires. Keyfile first (shortest secret lifetime), then teardown.
trap 'cleanup_restore_keyfile; cleanup' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# is_single_line_value <value>: accept only values the Compose env-file
# format can carry on one KEY=VALUE line. The value is split on the FIRST
# '=' so embedded '=' (base64 padding) is preserved, but a newline, CR o
# NUL would corrupt the file or leak across lines, so they are refused
# closed (fail) before anything is written.
is_single_line_value() {
  local v="$1"
  [[ -n "$v" ]] || return 1
  [[ "$v" != *$'\n'* && "$v" != *$'\r'* ]] || return 1
  return 0
}

key_check() {
  local check_file="$ROOT_DIR/scripts/ops/verify-source-key.cjs"
  local expected_fp status=0 output="" keyfile keydir keypath
  expected_fp="$(manifest_value source_key_fingerprint)"
  [[ -f "$check_file" ]] || fail "missing $check_file"
  is_single_line_value "${RESTORE_SOURCE_ENCRYPTION_KEY:?RESTORE_SOURCE_ENCRYPTION_KEY is required}" \
    || fail "RESTORE_SOURCE_ENCRYPTION_KEY contains characters incompatible with the private env-file (must be a single line)"
  is_single_line_value "$expected_fp" \
    || fail "source_key_fingerprint contains characters incompatible with the private env-file (must be a single line)"
  echo "restore: verifying SOURCE_ENCRYPTION_KEY against the restored database"
  # Private key file. mktemp creates it empty; tighten to 600 BEFORE any
  # secret is written. RESTORE_KEY_FILE is set here so the EXIT trap
  # removes it if a signal or an early fail() lands while the one-shot is
  # still running.
  keyfile="$(mktemp)" || fail "could not create a private key file"
  chmod 600 "$keyfile"
  RESTORE_KEY_FILE="$keyfile"
  # Explicit mapping RESTORE_* -> names consumed by the in-container check.
  # Exactly these two lines, written verbatim; nothing else is stored here.
  printf 'SOURCE_ENCRYPTION_KEY=%s\n' "$RESTORE_SOURCE_ENCRYPTION_KEY" > "$keyfile"
  printf 'EXPECTED_KEY_FINGERPRINT=%s\n' "$expected_fp" >> "$keyfile"
  # Resolve the path for the native Docker CLIENT process. Compose reads
  # --env-from-file host-side, and under Git Bash it is docker.exe, so the
  # POSIX /tmp/... path must be translated with pwd -W (unavailable on
  # Linux, where the POSIX path is correct). The explicit
  # { pwd -W || pwd } grouping yields EXACTLY ONE path on both platforms
  # (a bare `a && b || c && d` chain would emit two lines under Git Bash).
  keydir="$(cd "$(dirname "$keyfile")" && { pwd -W 2>/dev/null || pwd; })"
  keypath="$keydir/$(basename "$keyfile")"
  output="$(restore_compose run --rm -T \
      --env-from-file "$keypath" \
      --entrypoint sh migrate \
      -c "cat > /repo/lib/db/m25-key-check.cjs && cd /repo/lib/db && node m25-key-check.cjs" \
      < "$check_file" 2>&1)" || status=$?
  # Remove the key file on BOTH success and failure immediately after the
  # client returns, so the secret is not left on disk until process exit.
  # The EXIT trap stays as the safety net for signals and early failures.
  rm -f "$keyfile" 2>/dev/null || true
  RESTORE_KEY_FILE=""
  printf '%s\n' "$output" | grep -E '^key_check_' || true
  case "$status" in
    0) return 0 ;;
    3) fail "SOURCE_ENCRYPTION_KEY does not match this backup (fingerprint mismatch); refusing to declare the restore usable" ;;
    4) fail "SOURCE_ENCRYPTION_KEY cannot decrypt the restored source credentials; refusing to declare the restore usable" ;;
    5)
      echo "restore: WARNING no encrypted source configs in this backup, so the key could not be verified"
      return 0
      ;;
    *) fail "source-key verification could not run (exit $status); refusing to declare the restore usable" ;;
  esac
}
key_check

echo "restore=ok project=$PROJECT_NAME database=$TARGET_DB keep=$KEEP_TARGET"
if [[ "$KEEP_TARGET" == 1 ]]; then echo "restore: target left running for operator cutover"; fi


