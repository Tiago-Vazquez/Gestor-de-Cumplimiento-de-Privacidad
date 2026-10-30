#!/usr/bin/env bash
# M31.4 / F-P6 -- complementary WAL chain manifest for a physical base set.
#
# WHY THIS EXISTS (defect R1, M31.3):
#   The .pmanifest published by postgres-physbackup.sh declares only the
#   WAL-Ranges that pg_basebackup itself streamed (base_lsn .. stop_lsn). That is
#   enough to prove the base is self-consistent, but it does NOT describe the
#   archived WAL chain a point-in-time recovery needs, so the offline emitter
#   (postgres-restore.sh --pitr) refused every target beyond the base's own
#   window even when the archived segments did cover it.
#
# This script builds a COMPLEMENTARY manifest that links the base set to the
# archived segments actually present in a WAL store, with per-artefact integrity
# and a coverage window that is DEMONSTRABLE. It never modifies the base set and
# never claims coverage it cannot prove:
#   * only segments whose SHA-256 and byte size match what is recorded count;
#   * the chain must be CONTIGUOUS from the segment that contains base_lsn;
#   * coverage_end is the START LSN of the last contiguous segment: a segment
#     archived by archive_timeout may be partially filled, so its real end LSN
#     cannot be derived offline. A target inside the last segment therefore
#     requires archiving one more segment first (FP5-3 discipline).
#   * segments on a different timeline are only accepted when the corresponding
#     <tli>.history file is present, and they never extend the coverage.
#
# The original pg_basebackup manifest is NOT reinterpreted: it only supplies
# base_lsn/base_timeline through the .pmanifest, and its own sha256 is carried
# over so a consumer can still verify the PostgreSQL artefact independently.
#
# Modes:
#   wal-chain-manifest.sh --emit   --base SET.pmanifest --wal-dir DIR --out FILE
#   wal-chain-manifest.sh --verify --chain FILE --wal-dir DIR
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/ops/common.sh
source "$ROOT_DIR/scripts/ops/common.sh"

# H-04 (M31.6): ONLY 16 MiB segments are supported. seg_of_lsn/seg_start_dec below
# derive logid as lsn / 2^32, which is correct only for the 16 MiB default; any
# other size would compute a wrong base segment and a wrong coverage. The limit is
# enforced up front (see the check after argument parsing), never silently accepted.
WAL_SEGSIZE_SUPPORTED=16777216
SEGSZ="${WAL_CHAIN_SEGSIZE:-$WAL_SEGSIZE_SUPPORTED}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/ops/wal-chain-manifest.sh --emit   --base SET.pmanifest --wal-dir DIR --out FILE
  bash scripts/ops/wal-chain-manifest.sh --verify --chain FILE --wal-dir DIR --set-dir DIR

Builds (--emit) or re-verifies (--verify) the complementary WAL chain manifest
that links a published physical base set to the archived WAL segments.

--verify REQUIRES --set-dir: the directory holding the physical set
(<set_id>.pmanifest + <set_id>.backup_manifest + the tars). The verification is
only reported as complete when the PostgreSQL manifest referenced by the chain is
present there and matches the recorded digest; without --set-dir the check fails
instead of claiming success (H-01, M31.6).

Optional environment:
  WAL_CHAIN_SEGSIZE   WAL segment size in bytes. Only 16777216 (16 MiB) is
                      supported; any other value is rejected (H-04, M31.6).

Exit codes:
  0  chain emitted and self-verified / chain verified against the artefacts AND
     against the physical set manifest
  1  validation failure (missing, corrupt, divergent, gapped, non-contiguous,
     wrong timeline without history, unlinked/substituted PostgreSQL manifest,
     unsupported segment size, or declared coverage that cannot be proven)
EOF
}

fail() { echo "wal-chain: $*" >&2; exit 1; }

MODE=""; BASE=""; WALDIR=""; OUT=""; CHAIN=""; SETDIR=""
while (($#)); do
  case "$1" in
    --emit)    MODE=emit; shift ;;
    --verify)  MODE=verify; shift ;;
    --base)    [[ $# -ge 2 ]] || fail "--base needs a file"; BASE="$2"; shift 2 ;;
    --wal-dir) [[ $# -ge 2 ]] || fail "--wal-dir needs a directory"; WALDIR="$2"; shift 2 ;;
    --out)     [[ $# -ge 2 ]] || fail "--out needs a file"; OUT="$2"; shift 2 ;;
    --chain)   [[ $# -ge 2 ]] || fail "--chain needs a file"; CHAIN="$2"; shift 2 ;;
    --set-dir) [[ $# -ge 2 ]] || fail "--set-dir needs a directory"; SETDIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

is_positive_int "$SEGSZ" || fail "WAL_CHAIN_SEGSIZE must be a positive integer (got: $SEGSZ)"
[[ "$SEGSZ" == "$WAL_SEGSIZE_SUPPORTED" ]] \
  || fail "WAL_CHAIN_SEGSIZE=$SEGSZ is not supported: only 16 MiB segments ($WAL_SEGSIZE_SUPPORTED bytes) are implemented (H-04)"
[[ -n "$MODE" ]] || { usage >&2; fail "one of --emit or --verify is required"; }
[[ -n "$WALDIR" ]] || fail "--wal-dir is required"
[[ -d "$WALDIR" ]] || fail "--wal-dir is not a directory: $WALDIR"
WALDIR="$(cd "$WALDIR" && pwd -P)"

mget() { printf '%s' "$2" | awk -F= -v k="$1" '$1==k {sub(/^[^=]*=/,"",$0); print; exit}'; }
val() { strip_cr "$(mget "$1" "$2")"; }

# --- LSN helpers ------------------------------------------------------------
# H-03 (M31.6): syntax, length and RANGE are validated before any arithmetic, and
# the int64 range is guarded exactly as pitr_parse_lsn does in postgres-restore.sh.
# Without this, a crafted manifest (hi >= 2^31) would overflow signed 64-bit bash
# arithmetic and silently produce a wrong comparison in the monotone-extension
# decision. No truncation, no octal trap (16# forces base 16).
LSN_MAX_HI=0x7FFFFFFF
lsn_dec() {
  local lsn="$1" hi lo
  [[ "$lsn" =~ ^[0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8}$ ]] \
    || fail "invalid LSN (expected HEX/HEX, up to 8 digits each): '$lsn'"
  hi="${lsn%%/*}"; lo="${lsn##*/}"
  (( 16#$hi <= LSN_MAX_HI )) \
    || fail "LSN '$lsn' exceeds the supported int64 range (high half must be <= 7FFFFFFF)"
  printf '%s' "$(( 16#$hi * 4294967296 + 16#$lo ))"
}
lsn_fmt() { printf '%X/%X' "$(( $1 / 4294967296 ))" "$(( $1 % 4294967296 ))"; }
seg_of_lsn() {  # decimal lsn -> "logid segno"
  printf '%s %s' "$(( $1 / 4294967296 ))" "$(( ($1 % 4294967296) / SEGSZ ))"
}
seg_start_dec() { printf '%s' "$(( $1 * 4294967296 + $2 * SEGSZ ))"; }
seg_name() { printf '%08X%08X%08X' "$1" "$2" "$3"; }

# --- artefact classification ------------------------------------------------
# Accepted names, all uppercase hex and dots only (no '/', no '..'):
#   <24 hex>                 WAL segment
#   <24 hex>.<8 hex>.backup  backup history file written by pg_basebackup
#   <8 hex>.history          timeline history file
is_segment_name() { [[ "$1" =~ ^[0-9A-F]{24}$ ]]; }
is_backup_name()  { [[ "$1" =~ ^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$ ]]; }
is_history_name() { [[ "$1" =~ ^[0-9A-F]{8}\.history$ ]]; }

seg_timeline() { printf '%s' "$(( 16#${1:0:8} ))"; }
seg_logid()    { printf '%s' "$(( 16#${1:8:8} ))"; }
seg_segno()    { printf '%s' "$(( 16#${1:16:8} ))"; }

sha_of() { sha256_of "$1"; }
bytes_of() { wc -c < "$1" | tr -d ' \r\n'; }

# ---------------------------------------------------------------------------
# Shared: scan the WAL directory and classify artefacts (fail closed).
# ---------------------------------------------------------------------------
scan_dir() {
  local f n
  SEG_FILES=(); AUX_FILES=()
  [[ -d "$WALDIR" ]] || fail "--wal-dir is not a directory: $WALDIR"
  for f in "$WALDIR"/*; do
    [[ -e "$f" ]] || continue
    [[ -L "$f" ]] && fail "symlink in --wal-dir; refusing: $(basename "$f")"
    n="$(basename "$f")"
    if is_segment_name "$n"; then
      SEG_FILES+=("$n")
    elif is_backup_name "$n" || is_history_name "$n"; then
      AUX_FILES+=("$n")
    else
      fail "unexpected file in --wal-dir (not a WAL segment, <seg>.<tli>.backup or <tli>.history): $n"
    fi
  done
  [[ ${#SEG_FILES[@]} -gt 0 ]] || fail "no WAL segments found in --wal-dir: $WALDIR"
}

# ---------------------------------------------------------------------------
# EMIT: build the chain manifest from the base manifest + the artefacts.
# Scalars are passed to write_chain through CH_* globals and RUN/AUX/FOREIGN.
# ---------------------------------------------------------------------------
emit() {
  [[ -n "$BASE" ]] || fail "--base is required with --emit"
  [[ -n "$OUT" ]] || fail "--out is required with --emit"
  [[ -f "$BASE" ]] || fail "--base not found: $BASE"
  [[ ! -L "$BASE" ]] || fail "--base is a symlink; refusing: $BASE"
  # In emit mode the set directory is derived from --base, so the self-verification
  # performed by write_chain can also check the link to the PostgreSQL manifest
  # (H-01). A caller-supplied --set-dir still wins if given.
  [[ -n "$SETDIR" ]] || SETDIR="$(cd "$(dirname "$BASE")" && pwd -P)"

  local man; man="$(cat "$BASE")"
  local fmt schema
  fmt="$(val format "$man")"
  [[ "$fmt" == "pg-base-tar-set" ]] || fail "unsupported base format '$fmt' (expected pg-base-tar-set)"
  schema="$(val schema_version "$man")"
  [[ "$schema" == "1" ]] || fail "unsupported base schema_version '${schema:-<missing>}'"
  CH_SET_ID="$(val set_id "$man")"
  [[ -n "$CH_SET_ID" ]] || fail "base manifest is missing set_id"
  CH_BASE_LSN="$(val base_lsn "$man")"
  CH_BASE_TL="$(val base_timeline "$man")"
  CH_MAN_FILE="$(val manifest_file "$man")"
  CH_MAN_SHA="$(val manifest_sha256 "$man")"
  is_sha256 "$CH_MAN_SHA" || fail "base manifest does not carry a valid manifest_sha256"

  # H-01 (M31.6): the PostgreSQL manifest referenced by the base set must exist
  # next to it and match the recorded digest. Otherwise a chain could be emitted
  # for a set whose pg_basebackup manifest was removed or swapped, and a consumer
  # verifying only the chain would never notice.
  local set_dir
  set_dir="$(cd "$(dirname "$BASE")" && pwd -P)"
  [[ "$CH_MAN_FILE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || fail "base manifest_file is not a safe single path token: '${CH_MAN_FILE:-<empty>}'"
  [[ "$CH_MAN_FILE" == "${CH_SET_ID}.backup_manifest" ]] \
    || fail "base manifest_file '$CH_MAN_FILE' is not the expected '${CH_SET_ID}.backup_manifest'"
  [[ -f "$set_dir/$CH_MAN_FILE" && ! -L "$set_dir/$CH_MAN_FILE" ]] \
    || fail "the PostgreSQL manifest linked by the base set is missing or a symlink: $set_dir/$CH_MAN_FILE"
  [[ "$(sha_of "$set_dir/$CH_MAN_FILE")" == "$CH_MAN_SHA" ]] \
    || fail "the PostgreSQL manifest $CH_MAN_FILE does not match the digest recorded in the base set"

  local base_dec b_log b_seg
  base_dec="$(lsn_dec "$CH_BASE_LSN")"
  read -r b_log b_seg <<<"$(seg_of_lsn "$base_dec")"

  scan_dir

  local -a chain=()
  RUN=(); FOREIGN=()
  local n t l s
  local -a sorted
  sorted=($(printf '%s\n' "${SEG_FILES[@]}" | sort))
  for n in "${sorted[@]}"; do
    t="$(seg_timeline "$n")"
    if [[ "$t" == "$CH_BASE_TL" ]]; then chain+=("$n"); else FOREIGN+=("$n"); fi
  done

  local base_name; base_name="$(seg_name "$CH_BASE_TL" "$b_log" "$b_seg")"
  local found=0
  for n in "${chain[@]}"; do [[ "$n" == "$base_name" ]] && found=1; done
  (( found == 1 )) || fail "the segment containing base_lsn ($CH_BASE_LSN) is not in --wal-dir: expected $base_name"

  local exp_log="$b_log" exp_seg="$b_seg" cur hit
  while :; do
    cur="$(seg_name "$CH_BASE_TL" "$exp_log" "$exp_seg")"
    hit=0
    for n in "${chain[@]}"; do [[ "$n" == "$cur" ]] && hit=1; done
    (( hit == 1 )) || break
    RUN+=("$cur")
    if (( exp_seg == 255 )); then exp_log=$(( exp_log + 1 )); exp_seg=0; else exp_seg=$(( exp_seg + 1 )); fi
  done

  # A segment beyond the end of the contiguous run means there is a HOLE: report
  # it, never claim coverage across it.
  CH_GAP_FREE=yes
  local last_log last_seg
  last_log="$(seg_logid "${RUN[-1]}")"; last_seg="$(seg_segno "${RUN[-1]}")"
  for n in "${chain[@]}"; do
    l="$(seg_logid "$n")"; s="$(seg_segno "$n")"
    if (( l > last_log )) || (( l == last_log && s > last_seg )); then CH_GAP_FREE=no; fi
  done

  # Conservative coverage: up to the START of the last contiguous segment.
  if (( ${#RUN[@]} >= 2 )); then
    CH_COV_END="$(lsn_fmt "$(seg_start_dec "$(seg_logid "${RUN[-1]}")" "$(seg_segno "${RUN[-1]}")")")"
  else
    CH_COV_END="$CH_BASE_LSN"
  fi

  # Foreign timelines require their history file.
  local ftl hist have
  for n in "${FOREIGN[@]}"; do
    ftl="$(seg_timeline "$n")"
    hist="$(printf '%08X.history' "$ftl")"
    have=0
    for cur in "${AUX_FILES[@]}"; do [[ "$cur" == "$hist" ]] && have=1; done
    (( have == 1 )) || fail "segment $n is on timeline $ftl but $hist is not in --wal-dir (incomplete history)"
  done

  # A hole means the chain is INCOMPLETE: refuse to publish it at all, so no
  # consumer can mistake a gapped store for a usable chain.
  if [[ "$CH_GAP_FREE" != "yes" ]]; then
    local beyond=""
    for n in "${chain[@]}"; do
      l="$(seg_logid "$n")"; s="$(seg_segno "$n")"
      if (( l > last_log )) || (( l == last_log && s > last_seg )); then beyond="$n"; fi
    done
    fail "WAL chain has a hole: $beyond is present beyond the end of the contiguous run ending at ${RUN[-1]}"
  fi

  write_chain
}

# ---------------------------------------------------------------------------
# WRITE: materialise the manifest, self-verify it, then publish it atomically.
# ---------------------------------------------------------------------------
write_chain() {
  local tmp i n kind
  tmp="$(mktemp)" || fail "could not create a temporary manifest"
  {
    printf 'format=pg-wal-chain\n'
    printf 'schema_version=1\n'
    printf 'base_set=%s\n' "$CH_SET_ID"
    printf 'base_lsn=%s\n' "$CH_BASE_LSN"
    printf 'base_timeline=%s\n' "$CH_BASE_TL"
    printf 'base_manifest_file=%s\n' "$CH_MAN_FILE"
    printf 'base_manifest_sha256=%s\n' "$CH_MAN_SHA"
    printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'wal_segsize=%s\n' "$SEGSZ"
    printf 'segment_count=%s\n' "${#RUN[@]}"
    i=1
    for n in "${RUN[@]}"; do
      printf 'segment_%s_name=%s\n'     "$i" "$n"
      printf 'segment_%s_timeline=%s\n' "$i" "$(seg_timeline "$n")"
      printf 'segment_%s_bytes=%s\n'    "$i" "$(bytes_of "$WALDIR/$n")"
      printf 'segment_%s_sha256=%s\n'   "$i" "$(sha_of "$WALDIR/$n")"
      i=$(( i + 1 ))
    done
    printf 'aux_count=%s\n' "${#AUX_FILES[@]}"
    i=1
    for n in "${AUX_FILES[@]}"; do
      if is_backup_name "$n"; then kind=backup; else kind=history; fi
      printf 'aux_%s_kind=%s\n'   "$i" "$kind"
      printf 'aux_%s_name=%s\n'   "$i" "$n"
      printf 'aux_%s_bytes=%s\n'  "$i" "$(bytes_of "$WALDIR/$n")"
      printf 'aux_%s_sha256=%s\n' "$i" "$(sha_of "$WALDIR/$n")"
      i=$(( i + 1 ))
    done
    printf 'foreign_segment_count=%s\n' "${#FOREIGN[@]}"
    i=1
    for n in "${FOREIGN[@]}"; do
      printf 'foreign_segment_%s_name=%s\n'     "$i" "$n"
      printf 'foreign_segment_%s_timeline=%s\n' "$i" "$(seg_timeline "$n")"
      printf 'foreign_segment_%s_bytes=%s\n'    "$i" "$(bytes_of "$WALDIR/$n")"
      printf 'foreign_segment_%s_sha256=%s\n'   "$i" "$(sha_of "$WALDIR/$n")"
      i=$(( i + 1 ))
    done
    printf 'coverage_timeline=%s\n' "$CH_BASE_TL"
    printf 'coverage_start_lsn=%s\n' "$CH_BASE_LSN"
    printf 'coverage_end_lsn=%s\n' "$CH_COV_END"
    printf 'gap_free=%s\n' "$CH_GAP_FREE"
    printf 'status=complete\n'
  } > "$tmp"

  verify_chain "$tmp" || { rm -f "$tmp"; fail "the emitted chain does not verify against the artefacts"; }

  if [[ -e "$OUT" ]]; then
    # Idempotency must not depend on the clock: created_at is the only field that
    # legitimately changes between two emissions of the same artefacts, so it is
    # excluded from the comparison. Everything else (segments, sizes, digests,
    # coverage, linkage) must match exactly, or the existing manifest is kept and
    # the divergence reported.
    if cmp -s <(grep -v '^created_at=' "$tmp") <(grep -v '^created_at=' "$OUT"); then
      rm -f "$tmp"
      echo "walchain=ok base=$CH_SET_ID segments=${#RUN[@]} coverage=$CH_BASE_LSN..$CH_COV_END out=$OUT (unchanged)"
      return 0
    fi
    # A refresh is legitimate ONLY as a monotone extension of the SAME base set:
    # identical linkage (base_set/base_lsn/base_timeline), the old segment list as
    # a prefix of the new one, and coverage that only grows. That is what happens
    # when PostgreSQL archives more WAL. Anything else is a divergent manifest and
    # is refused (and reported, never replaced silently).
    local oman o_set o_lsn o_tl o_cov o_n o_seg ok=1 o_cov_dec new_cov_dec
    oman="$(cat "$OUT")"
    o_set="$(val base_set "$oman")"; o_lsn="$(val base_lsn "$oman")"; o_tl="$(val base_timeline "$oman")"
    o_cov="$(val coverage_end_lsn "$oman")"; o_n="$(val segment_count "$oman")"
    if [[ "$o_set" != "$CH_SET_ID" || "$o_lsn" != "$CH_BASE_LSN" || "$o_tl" != "$CH_BASE_TL" ]]; then ok=0; fi
    if [[ "$o_n" =~ ^[1-9][0-9]*$ ]]; then
      # H-03: both LSNs are parsed into variables so an out-of-range or malformed
      # value in the EXISTING manifest aborts (set -e) instead of being swallowed by
      # the comparison — otherwise a bogus old coverage could authorise an update.
      o_cov_dec="$(lsn_dec "$o_cov")"
      new_cov_dec="$(lsn_dec "$CH_COV_END")"
      (( o_cov_dec <= new_cov_dec )) || ok=0
      for (( i = 1; i <= o_n; i++ )); do
        o_seg="$(val "segment_${i}_name" "$oman")"
        [[ "$o_seg" == "${RUN[$((i - 1))]:-}" ]] || ok=0
      done
    else
      ok=0
    fi
    if (( ok == 1 )); then
      mv "$tmp" "$OUT"
      echo "walchain=ok base=$CH_SET_ID segments=${#RUN[@]} coverage=$CH_BASE_LSN..$CH_COV_END out=$OUT (updated from $o_n segments)"
      return 0
    fi
    rm -f "$tmp"
    fail "refusing to overwrite an existing divergent chain manifest: $OUT"
  fi
  mv "$tmp" "$OUT"
  echo "walchain=ok base=$CH_SET_ID segments=${#RUN[@]} coverage=$CH_BASE_LSN..$CH_COV_END gap_free=$CH_GAP_FREE out=$OUT"
}

# ---------------------------------------------------------------------------
# VERIFY: re-prove the chain from the artefacts. Everything is recomputed from
# the files on disk; a manifest that declares anything the artefacts cannot
# support fails here.
# ---------------------------------------------------------------------------
verify_chain() {
  local cf="$1" man
  [[ -f "$cf" ]] || fail "chain manifest not found: $cf"
  [[ ! -L "$cf" ]] || fail "chain manifest is a symlink; refusing: $cf"
  man="$(cat "$cf")"
  [[ "$(val format "$man")" == "pg-wal-chain" ]] || fail "not a chain manifest: $cf"
  [[ "$(val schema_version "$man")" == "1" ]] || fail "unsupported chain schema_version in $cf"
  [[ "$(val status "$man")" == "complete" ]] || fail "chain status is not complete in $cf"

  local segsz; segsz="$(val wal_segsize "$man")"
  is_positive_int "$segsz" || fail "chain wal_segsize is invalid (got: '$segsz')"
  SEGSZ="$segsz"

  local b_lsn b_tl base_dec b_log b_seg
  b_lsn="$(val base_lsn "$man")"; b_tl="$(val base_timeline "$man")"
  base_dec="$(lsn_dec "$b_lsn")"
  read -r b_log b_seg <<<"$(seg_of_lsn "$base_dec")"

  # H-01 (M31.6): --set-dir is REQUIRED, and the chain must be provably linked to
  # the physical set: <set_id>.pmanifest in that directory must agree with the
  # chain, and the PostgreSQL manifest it references must exist there with the
  # recorded digest. Without this the verification FAILS instead of reporting a
  # verified chain (a chain alone cannot prove which base set it belongs to).
  [[ -n "$SETDIR" ]] \
    || fail "--set-dir is required with --verify (directory holding <set_id>.pmanifest)"
  [[ -d "$SETDIR" ]] || fail "--set-dir is not a directory: $SETDIR"
  local sd set_id pm pm_set pm_lsn pm_tl pm_file pm_sha ch_file ch_sha
  sd="$(cd "$SETDIR" && pwd -P)"
  set_id="$(val base_set "$man")"
  [[ "$set_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || fail "chain base_set is not a safe single path token: '${set_id:-<empty>}'"
  pm="$sd/$set_id.pmanifest"
  [[ -f "$pm" && ! -L "$pm" ]] || fail "base set manifest not found in --set-dir: $pm"
  pm_set="$(val set_id "$(cat "$pm")")"
  [[ "$pm_set" == "$set_id" ]] \
    || fail "set manifest set_id '$pm_set' does not match the chain base_set '$set_id'"
  pm_lsn="$(val base_lsn "$(cat "$pm")")"
  [[ "$(lsn_dec "$pm_lsn")" == "$base_dec" ]] \
    || fail "set manifest base_lsn '$pm_lsn' does not match the chain base_lsn '$b_lsn'"
  pm_tl="$(val base_timeline "$(cat "$pm")")"
  [[ "$pm_tl" == "$b_tl" ]] \
    || fail "set manifest base_timeline '$pm_tl' does not match the chain base_timeline '$b_tl'"
  pm_file="$(val manifest_file "$(cat "$pm")")"
  pm_sha="$(val manifest_sha256 "$(cat "$pm")")"
  [[ "$pm_file" == "$set_id.backup_manifest" ]] \
    || fail "set manifest manifest_file '$pm_file' is not the expected '$set_id.backup_manifest'"
  ch_file="$(val base_manifest_file "$man")"
  ch_sha="$(val base_manifest_sha256 "$man")"
  [[ "$ch_file" == "$pm_file" ]] \
    || fail "chain base_manifest_file '$ch_file' does not match the set manifest '$pm_file'"
  is_sha256 "$ch_sha" || fail "chain base_manifest_sha256 is not a digest"
  [[ "$ch_sha" == "$pm_sha" ]] \
    || fail "chain base_manifest_sha256 does not match the set manifest digest (substituted manifest?)"
  [[ -f "$sd/$ch_file" && ! -L "$sd/$ch_file" ]] \
    || fail "PostgreSQL manifest missing or a symlink in --set-dir: $sd/$ch_file"
  [[ "$(sha_of "$sd/$ch_file")" == "$ch_sha" ]] \
    || fail "the PostgreSQL manifest $ch_file does not match the recorded digest (H-01)"

  local cnt; cnt="$(val segment_count "$man")"
  is_positive_int "$cnt" || fail "chain segment_count is invalid (got: '$cnt')"

  local i n exp_bytes exp_sha act_bytes act_sha
  local -a names=()
  for (( i = 1; i <= cnt; i++ )); do
    n="$(val "segment_${i}_name" "$man")"
    is_segment_name "$n" || fail "segment_${i}_name is not a canonical 24-hex name: '$n'"
    [[ "$(val "segment_${i}_timeline" "$man")" == "$b_tl" ]] \
      || fail "segment $n is declared on a timeline other than base_timeline $b_tl"
    [[ -f "$WALDIR/$n" ]] || fail "required segment missing from --wal-dir: $n"
    exp_bytes="$(val "segment_${i}_bytes" "$man")"
    exp_sha="$(val "segment_${i}_sha256" "$man")"
    act_bytes="$(bytes_of "$WALDIR/$n")"
    act_sha="$(sha_of "$WALDIR/$n")"
    [[ "$exp_bytes" == "$act_bytes" ]] || fail "segment $n size diverges (manifest=$exp_bytes actual=$act_bytes)"
    [[ "$exp_sha" == "$act_sha" ]] || fail "segment $n sha256 diverges (manifest=$exp_sha actual=$act_sha)"
    names+=("$n")
  done

  # Contiguity recomputed from the names themselves: consecutive segments from
  # the one that contains base_lsn, with the real 255 -> next-log wrap.
  local exp_log="$b_log" exp_seg="$b_seg" cur
  for (( i = 0; i < cnt; i++ )); do
    cur="$(seg_name "$b_tl" "$exp_log" "$exp_seg")"
    [[ "${names[$i]}" == "$cur" ]] \
      || fail "chain is not contiguous: expected $cur at position $((i + 1)), found ${names[$i]}"
    if (( exp_seg == 255 )); then exp_log=$(( exp_log + 1 )); exp_seg=0; else exp_seg=$(( exp_seg + 1 )); fi
  done

  # The declared coverage must be exactly what the artefacts can support. The LSNs
  # are parsed into variables FIRST so an out-of-range or malformed value aborts
  # with its own diagnostic (H-03) instead of being swallowed by a comparison.
  local cov_start cov_end want_end cov_start_dec cov_end_dec want_end_dec
  cov_start="$(val coverage_start_lsn "$man")"
  cov_end="$(val coverage_end_lsn "$man")"
  cov_start_dec="$(lsn_dec "$cov_start")"
  cov_end_dec="$(lsn_dec "$cov_end")"
  [[ "$cov_start_dec" == "$base_dec" ]] || fail "coverage_start_lsn ($cov_start) does not match base_lsn ($b_lsn)"
  if (( cnt >= 2 )); then
    want_end="$(lsn_fmt "$(seg_start_dec "$(seg_logid "${names[-1]}")" "$(seg_segno "${names[-1]}")")")"
  else
    want_end="$b_lsn"
  fi
  want_end_dec="$(lsn_dec "$want_end")"
  [[ "$cov_end_dec" == "$want_end_dec" ]] \
    || fail "declared coverage_end_lsn $cov_end cannot be proven from the artefacts (recomputed: $want_end)"

  # Auxiliary artefacts (.backup / .history) must be present and identical.
  local acnt kind
  acnt="$(val aux_count "$man")"
  [[ "$acnt" =~ ^[0-9]+$ ]] || fail "chain aux_count is invalid (got: '$acnt')"
  for (( i = 1; i <= acnt; i++ )); do
    n="$(val "aux_${i}_name" "$man")"
    kind="$(val "aux_${i}_kind" "$man")"
    if [[ "$kind" == "backup" ]]; then
      is_backup_name "$n" || fail "aux_${i} is declared kind=backup but the name is not <seg>.<tli>.backup: '$n'"
    elif [[ "$kind" == "history" ]]; then
      is_history_name "$n" || fail "aux_${i} is declared kind=history but the name is not <tli>.history: '$n'"
    else
      fail "aux_${i}_kind is neither backup nor history (got: '$kind')"
    fi
    [[ -f "$WALDIR/$n" ]] || fail "auxiliary artefact missing from --wal-dir: $n"
    exp_bytes="$(val "aux_${i}_bytes" "$man")"
    exp_sha="$(val "aux_${i}_sha256" "$man")"
    act_bytes="$(bytes_of "$WALDIR/$n")"
    act_sha="$(sha_of "$WALDIR/$n")"
    [[ "$exp_bytes" == "$act_bytes" && "$exp_sha" == "$act_sha" ]] \
      || fail "auxiliary artefact $n diverges (manifest=$exp_bytes/$exp_sha actual=$act_bytes/$act_sha)"
  done

  # Foreign-timeline segments: present, identical, and their history required.
  local fcnt ftl hist have
  fcnt="$(val foreign_segment_count "$man")"
  [[ "$fcnt" =~ ^[0-9]+$ ]] || fail "chain foreign_segment_count is invalid (got: '$fcnt')"
  for (( i = 1; i <= fcnt; i++ )); do
    n="$(val "foreign_segment_${i}_name" "$man")"
    is_segment_name "$n" || fail "foreign_segment_${i}_name is not canonical: '$n'"
    [[ -f "$WALDIR/$n" ]] || fail "foreign-timeline segment missing from --wal-dir: $n"
    exp_sha="$(val "foreign_segment_${i}_sha256" "$man")"
    [[ "$(sha_of "$WALDIR/$n")" == "$exp_sha" ]] || fail "foreign-timeline segment $n sha256 diverges"
    ftl="$(seg_timeline "$n")"
    hist="$(printf '%08X.history' "$ftl")"
    have=0
    for cur in "${AUX_FILES[@]:-}"; do [[ "$cur" == "$hist" ]] && have=1; done
    if (( have == 0 )); then
      [[ -f "$WALDIR/$hist" ]] || fail "timeline $ftl history is missing from --wal-dir (needed by segment $n)"
    fi
  done
  return 0
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
case "$MODE" in
  emit)   emit ;;
  verify)
    [[ -n "$CHAIN" ]] || fail "--chain is required with --verify"
    # AUX_FILES is used by verify_chain for the history check; populate it.
    scan_dir
    verify_chain "$CHAIN"
    echo "walchain=verify-ok base_set=$(val base_set "$(cat "$CHAIN")") segments=$(val segment_count "$(cat "$CHAIN")") coverage=$(val coverage_start_lsn "$(cat "$CHAIN")")..$(val coverage_end_lsn "$(cat "$CHAIN")")"
    ;;
esac




