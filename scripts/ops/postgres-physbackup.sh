#!/usr/bin/env bash
# F-P3.2 -- physical PostgreSQL backup (pg_basebackup) for the Compose deployment.
#
# Produces the coordinated physical set agreed in F-P3.1.x:
#   base.tar + pg_wal.tar + backup_manifest   (pg_basebackup -Ft -X stream)
# plus our own .pmanifest, published LAST, after every member is validated.
#
# WHAT THIS IS NOT:
#   - It does NOT enable archive_mode / archive_command.
#   - It does NOT run a real pg_basebackup in the offline/test path.
#   - It does NOT prove that PITR restores; restorability and pg_verifybackup
#     remain F-P5. Enumerating tars and checking SHA-256 proves INTEGRITY only.
#
# The transport is injectable via PHYS_BASEBACKUP_CMD (same seam as
# OFFHOST_S3_CMD / WAL_ARCHIVE_TRANSPORT / BACKUP_CMD) so the whole contract is
# tested with no Docker, no network, no credentials and no real PostgreSQL.
# The real invocation (an ephemeral postgres:16-alpine container over the
# Compose network) lives in run_real_basebackup() and is GATED behind
# PHYS_ALLOW_REAL=1: it is never reached by the tests and never runs by default.
#
# Contract preserved from F-P3.1.x:
#   - base_lsn / base_timeline come from backup_label (START WAL LOCATION /
#     START TIMELINE), never from a live server reading.
#   - SHA-256 + byte size recorded per member.
#   - .pmanifest published last; a consumer accepts a set only if the manifest
#     exists with status=complete and every member's size+SHA-256 match.
#   - No retention, no auto-purge of finals, no physical retention figures.
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
BACKUP_DIR="${BACKUP_DIR:-}"

# Exit codes (mirror postgres-backup.sh): 75 = lock held elsewhere.
EXIT_LOCKED=75

fail() { echo "physbackup: $*" >&2; exit 1; }

docker_exec() { MSYS_NO_PATHCONV=1 docker exec "$@"; }

# shellcheck source=scripts/ops/common.sh
source "$ROOT_DIR/scripts/ops/common.sh"

# ---------------------------------------------------------------------------
# Consumer / verify mode: `postgres-physbackup.sh --verify <set.pmanifest>`.
# Accepts a published set ONLY if the .pmanifest exists, status=complete, every
# referenced member is present, and each member's size and SHA-256 match. This
# is the gate a consumer (and the tests) use: a set published without a complete
# manifest, or with a tampered/missing member, is rejected. Proves INTEGRITY
# only; restorability (and pg_verifybackup) remain F-P5. Runs WITHOUT the lock.
# ---------------------------------------------------------------------------
mget() { printf '%s' "$2" | awk -F= -v k="$1" '$1==k {sub(/^[^=]*=/,""); print; exit}'; }

# A single safe path token for a set id or a member filename. It must contain no
# path separator ('/' or '\'), must not be '.'/'..', must not start with '.' o
# '-', and must match a conservative charset. Because such a token has no
# separator, "$dir/$token" is a direct child of the (already physical) "$dir" and
# therefore cannot traverse outside it; combined with the symlink guard in
# verify_set this proves every verified member stays inside the set directory.
is_safe_token() {
  local t="$1"
  if [[ -z "$t" ]]; then return 1; fi
  if [[ "$t" == */* || "$t" == *'\'* ]]; then return 1; fi
  if [[ "$t" == . || "$t" == .. ]]; then return 1; fi
  if [[ "$t" == .* || "$t" == -* ]]; then return 1; fi
  if [[ ! "$t" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then return 1; fi
  return 0
}

verify_set() {
  local man="$1" dir status set_id prefix f sha bytes asha abytes expected
  # The manifest itself must be a regular file and not a symlink.
  [[ -f "$man" ]] || fail "manifest not found: $man"
  [[ ! -L "$man" ]] || fail "manifest is a symlink; refusing to verify: $man"
  dir="$(cd "$(dirname "$man")" && pwd -P)"

  # set_id anchors every member name: the publisher names members
  # "<set_id>.<member>", so a forged/absolute/relative member name can neve
  # match. Validate set_id and the manifest filename against it up front.
  set_id="$(strip_cr "$(mget set_id "$(cat "$man")")")"
  [[ -n "$set_id" ]] || fail "manifest is missing set_id"
  is_safe_token "$set_id" || fail "manifest set_id is not a valid set identifier: '$set_id'"
  [[ "$(basename "$man")" == "${set_id}.pmanifest" ]] \
    || fail "manifest filename does not match its set_id (expected '${set_id}.pmanifest', got '$(basename "$man")')"

  status="$(strip_cr "$(mget status "$(cat "$man")")")"
  [[ "$status" == "complete" ]] \
    || fail "manifest status is not complete (got '${status:-<empty>}'): set is not consumable"

  # schema_version es obligatorio y fail-closed: versión desconocida o ausente
  # rechaza el conjunto sin intentar consumirlo.
  schema_version="$(strip_cr "$(mget schema_version "$(cat "$man")")")"
  [[ "$schema_version" == "1" ]] \
    || fail "unknown or missing schema_version in manifest (got '${schema_version:-<missing>}'); refusing set"

  # wal_range_count must be a non-negative integer, and every declared
  # wal_range_N_timeline / _start_lsn / _end_lsn triple must be present,
  # well-formed, and match wal_range_count exactly.
  wal_range_count="$(strip_cr "$(mget wal_range_count "$(cat "$man")")")"
  [[ -n "$wal_range_count" ]] || fail "manifest is missing wal_range_count"
  [[ "$wal_range_count" =~ ^[0-9]+$ ]] || fail "manifest wal_range_count is not a non-negative integer (got '$wal_range_count')"
  n=0
  while true; do
    n=$((n + 1))
    wl_tl="$(strip_cr "$(mget "wal_range_${n}_timeline" "$(cat "$man")")")"
    wl_st="$(strip_cr "$(mget "wal_range_${n}_start_lsn" "$(cat "$man")")")"
    wl_en="$(strip_cr "$(mget "wal_range_${n}_end_lsn" "$(cat "$man")")")"
    if [[ -z "$wl_tl" && -z "$wl_st" && -z "$wl_en" ]]; then
      break
    fi
    if (( n > wal_range_count )); then
      fail "manifest has wal_range_${n}_* but wal_range_count=$wal_range_count"
    fi
    [[ -n "$wl_tl" && -n "$wl_st" && -n "$wl_en" ]] || fail "manifest wal_range_${n}_* is incomplete"
    [[ "$wl_tl" =~ ^[0-9]+$ ]] || fail "manifest wal_range_${n}_timeline is not a positive integer (got '$wl_tl')"
    [[ "$wl_tl" -gt 0 ]] || fail "manifest wal_range_${n}_timeline must be positive (got '$wl_tl')"
    [[ "$wl_st" =~ ^[0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8}$ ]] || fail "manifest wal_range_${n}_start_lsn is not HEX/HEX (got '$wl_st')"
    [[ "$wl_en" =~ ^[0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8}$ ]] || fail "manifest wal_range_${n}_end_lsn is not HEX/HEX (got '$wl_en')"
    # Component-wise LSN comparison: compare hi halves, then lo halves if equal.
    # Avoids bash int64 overflow on full 64-bit LSN decimal conversion.
    wl_st_hi="$((16#${wl_st%%/*}))"; wl_st_lo="$((16#${wl_st##*/}))"
    wl_en_hi="$((16#${wl_en%%/*}))"; wl_en_lo="$((16#${wl_en##*/}))"
    if (( wl_st_hi > wl_en_hi )) || (( wl_st_hi == wl_en_hi && wl_st_lo > wl_en_lo )); then
      fail "manifest wal_range_${n} Start-LSN $wl_st > End-LSN $wl_en"
    fi
  done
  found_count=$((n - 1))
  [[ "$found_count" -eq "$wal_range_count" ]] || fail "manifest wal_range_count=$wal_range_count but found $found_count range entries"

  for prefix in base_tar pgwal_tar manifest; do
    f="$(strip_cr "$(mget "${prefix}_file" "$(cat "$man")")")"
    sha="$(strip_cr "$(mget "${prefix}_sha256" "$(cat "$man")")")"
    bytes="$(strip_cr "$(mget "${prefix}_bytes" "$(cat "$man")")")"
    [[ -n "$f" ]] || fail "manifest is missing ${prefix}_file"

    # The member name must be a safe single token. This rejects absolute paths,
    # '/' or '\' separators, '..' and leading dot/dash BEFORE any path is built,
    # so a forged reference to an external file can never be resolved.
    is_safe_token "$f" || fail "manifest ${prefix}_file is not a valid filename: '$f'"

    # The member must also be EXACTLY the name the physical contract derives
    # from set_id ("<set_id>.<member>"). A safe-but-wrong name is rejected here.
    case "$prefix" in
      base_tar)  expected="${set_id}.base.tar" ;;
      pgwal_tar) expected="${set_id}.pg_wal.tar" ;;
      manifest)  expected="${set_id}.backup_manifest" ;;
    esac
    [[ "$f" == "$expected" ]] \
      || fail "manifest ${prefix}_file is not the expected set member (expected '$expected', got '$f')"

    is_sha256 "$sha" || fail "manifest ${prefix}_sha256 is not a valid SHA-256"

    # Presence, regular file, and no symlink escape (a symlink member is refused
    # so it cannot redirect verification outside the set directory).
    [[ -e "$dir/$f" ]] || fail "member referenced by the manifest is missing: $f"
    [[ ! -L "$dir/$f" ]] || fail "member is a symlink; refusing to verify: $f"
    [[ -f "$dir/$f" ]] || fail "member referenced by the manifest is not a regular file: $f"

    asha="$(sha256_of "$dir/$f")"
    abytes="$(wc -c < "$dir/$f" | tr -d ' \r\n')"
    [[ "$asha" == "$sha" ]] || fail "SHA-256 mismatch for $f (manifest=$sha actual=$asha)"
    [[ "$abytes" == "$bytes" ]] || fail "size mismatch for $f (manifest=$bytes actual=$abytes)"
  done
  echo "physbackup: verified set $(basename "$man" .pmanifest): all members present; sizes and SHA-256 match" >&2
  echo "physbackup: NOTE integrity only; restorability is still unproven (F-P5)" >&2
  return 0
}

if [[ "${1:-}" == "--verify" ]]; then
  [[ $# -ge 2 ]] || fail "usage: postgres-physbackup.sh --verify <set.pmanifest>"
  verify_set "$2"
  exit $?
fi

# ---------------------------------------------------------------------------
# Config validation (backup path only; --verify already exited above).
# ---------------------------------------------------------------------------
LOCK_GRACE_SECONDS="${BACKUP_LOCK_GRACE_SECONDS:-120}"
LOCK_DIR="${BACKUP_LOCK_DIR:-}"
[[ "$LOCK_GRACE_SECONDS" =~ ^[0-9]+$ ]] || fail "BACKUP_LOCK_GRACE_SECONDS must be a non-negative integer (got: $LOCK_GRACE_SECONDS)"
[[ -n "$BACKUP_DIR" ]] || fail "set BACKUP_DIR to an external/protected directory"

mkdir -p "$BACKUP_DIR"
BACKUP_DIR_ABS="$(cd "$BACKUP_DIR" && pwd -P)"
ROOT_ABS="$(cd "$ROOT_DIR" && pwd -P)"
if [[ "${ALLOW_LOCAL_BACKUP:-0}" != "1" && ( "$BACKUP_DIR_ABS" == "$ROOT_ABS" || "$BACKUP_DIR_ABS" == "$ROOT_ABS/"* ) ]]; then
  fail "BACKUP_DIR must be outside the repository (or explicitly opt in for a drill)"
fi

[[ -n "$LOCK_DIR" ]] || LOCK_DIR="$BACKUP_DIR_ABS/.m24-backup.lock"

# ---------------------------------------------------------------------------
# Concurrency guard -- IDENTICAL to postgres-backup.sh so a physical and a
# logical backup mutually exclude each other through the same lock directory
# (.m24-backup.lock). Kept verbatim on purpose: the two must never run at once
# against the same database. This does not alter the logical backup behaviour.
# ---------------------------------------------------------------------------
lock_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
lock_holder_pid() { [[ -f "$LOCK_DIR/pid" ]] || return 0; tr -dc '0-9' < "$LOCK_DIR/pid" 2>/dev/null || true; }
write_lock_files() { printf '%s\n' "$$" > "$LOCK_DIR/pid"; printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK_DIR/acquired_at"; }
LOCK_HELD=""
release_lock() { [[ "$LOCK_HELD" == "1" ]] || return 0; rm -rf "$LOCK_DIR"; LOCK_HELD=""; return 0; }
acquire_lock() {
  local holder dir_age
  if mkdir "$LOCK_DIR" 2>/dev/null; then write_lock_files; LOCK_HELD=1; return 0; fi
  holder="$(lock_holder_pid)"
  if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then return 1; fi
  if [[ -z "$holder" ]]; then
    dir_age=$(( $(date +%s) - $(lock_mtime "$LOCK_DIR") ))
    [[ "$dir_age" -ge "$LOCK_GRACE_SECONDS" ]] || return 1
  fi
  echo "physbackup: reclaiming stale lock (holder pid=${holder:-unknown}, age=${dir_age:-0}s)" >&2
  rm -rf "$LOCK_DIR"; mkdir "$LOCK_DIR" 2>/dev/null || return 1
  write_lock_files; LOCK_HELD=1; return 0
}

if ! acquire_lock; then
  echo "physbackup: another backup already holds $LOCK_DIR (pid $(lock_holder_pid || true)); not starting" >&2
  echo "physbackup: if no backup is actually running, remove $LOCK_DIR and retry" >&2
  exit "$EXIT_LOCKED"
fi

# Reclaim only OUR abandoned staging prefix under the held lock. Never touches
# finals and never the logical .m24-tmp.* prefix.
reclaim_orphan_phys_temp_dirs() {
  local dir age
  while IFS= read -r dir; do
    [[ -d "$dir" ]] || continue
    age=$(( $(date +%s) - $(lock_mtime "$dir") ))
    if [[ "$age" -ge 86400 ]]; then
      echo "physbackup: removing orphaned temporary directory $(basename "$dir") (age ${age}s)" >&2
      rm -rf "$dir"
    fi
  done < <(find "$BACKUP_DIR_ABS" -maxdepth 1 -type d -name '.m24-phys-tmp.*' 2>/dev/null || true)
}
reclaim_orphan_phys_temp_dirs

# Installed before any work. Removes ONLY this run's staging directory and neve
# a final artefact or a pre-existing orphan; the prefix guard prevents removing a
# path that is not one of ours. A cleanup failure never turns a failed backup
# into a success (the real exit status is preserved by the EXIT trap).
STAGE=""
PHYS_PW_FILE=""
cleanup() {
  local s="${STAGE:-}"
  if [[ -n "$s" && -d "$s" && "$s" == "$BACKUP_DIR_ABS/.m24-phys-tmp."* ]]; then
    rm -rf "$s" || true
  fi
  # M2: remove the private credentials file if one is still outstanding (a caught
  # INT/TERM lands here through the EXIT trap). Only the exact regular file this
  # process created (tracked in PHYS_PW_FILE) is ever removed, and a symlink is
  # never followed or deleted; anything else is left untouched.
  if [[ -n "${PHYS_PW_FILE:-}" && -f "$PHYS_PW_FILE" && ! -L "$PHYS_PW_FILE" ]]; then
    rm -f "$PHYS_PW_FILE" 2>/dev/null || true
  fi
  release_lock
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------------------
# Transport seam. In production this runs pg_basebackup inside an ephemeral
# postgres:16-alpine container on the Compose network, bind-mounting $STAGE.
# That real invocation is gated behind PHYS_ALLOW_REAL=1 and is NOT part of the
# offline contract. For tests, PHYS_BASEBACKUP_CMD is a double that writes the
# expected members into $STAGE and can be told to fail in controlled ways.
#
# The transport receives the staging dir as $1 and must create, on success:
#   base.tar  pg_wal.tar  backup_manifest
# It returns the transport exit status; it MUST NOT delete %p, pg_wal or any
# remote object.
# ---------------------------------------------------------------------------
run_transport() {
  local stage="$1"
  if [[ -n "${PHYS_BASEBACKUP_CMD:-}" ]]; then
    "$PHYS_BASEBACKUP_CMD" "$stage"
    return $?
  fi
  [[ "${PHYS_ALLOW_REAL:-0}" == "1" ]] \
    || fail "no transport configured: set PHYS_BASEBACKUP_CMD (tests) or PHYS_ALLOW_REAL=1 for the real pg_basebackup path"
  run_real_basebackup "$stage"
}

# GATED real invocation (never executed by tests, never by default). Reproducible
# because it reuses the pinned image the db service already runs (postgres:16-alpine)
# and needs no image pull beyond what Compose already uses.
#
# Credentials (M2): PGPASSWORD is handed to the container through a private
# env-file, NOT via `docker run` argv, so the value is absent from `ps`,
# /proc/*/cmdline and shell traces of the client process. The file is created
# with mode 600 BEFORE any secret is written (mktemp on Git Bash defaults to
# 644), holds exactly one variable (PGPASSWORD, written verbatim), is referenced
# only by a path that is itself passed to --env-file, and is removed on success,
# on error and through the EXIT trap when a signal is caught. This narrows
# exposure to local argv/process inspection; it does NOT protect against a host
# administrator, privileged host inspection, any process able to read ou
# 600-mode temp files, or anything able to read the Docker API traffic or the
# resulting in-container environment.
#
# REPLICATION privilege, wal_level=replica and max_wal_senders>=2 are UNVERIFIED
# prerequisites; this function documents them and does not assume they hold.
run_real_basebackup() {
  local stage="$1" net proj pwfile pwdir pwp rc
  command -v docker >/dev/null 2>&1 || fail "docker is required for the real physical backup"
  # Resolve the Compose project network so the ephemeral client reaches `db`.
  proj="${COMPOSE_PROJECT_NAME:-$(basename "$ROOT_DIR" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9_-')}"
  net="${proj}_default"
  echo "physbackup: REAL pg_basebackup over compose network '$net' -> $stage" >&2

  # Private credentials file. mktemp creates it empty, but under Git Bash with
  # mode 644, so tighten to 600 BEFORE any secret is written. PHYS_PW_FILE is
  # set here so cleanup() (the EXIT trap) removes it if a signal or an early
  # fail() lands while the client is still running.
  pwfile="$(mktemp)" || fail "could not create a private credentials file"
  chmod 600 "$pwfile"
  PHYS_PW_FILE="$pwfile"
  printf 'PGPASSWORD=%s\n' \
    "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required for the real physical backup}" \
    > "$pwfile"

  # Resolve the path for the native Docker CLIENT process. The CLI reads
  # --env-file host-side, and under Git Bash it is docker.exe, so the POSIX
  # /tmp/... path must be translated with pwd -W (as the -v mount below already
  # does). pwd -W is unavailable on Linux, where the POSIX path is correct. The
  # explicit { pwd -W || pwd } grouping yields EXACTLY ONE path on both platforms
  # (a bare `a && b || c && d` chain would emit two lines under Git Bash).
  pwdir="$(cd "$(dirname "$pwfile")" && { pwd -W 2>/dev/null || pwd; })"
  pwp="$pwdir/$(basename "$pwfile")"

  rc=0
  MSYS_NO_PATHCONV=1 docker run --rm \
    --network "$net" \
    --env-file "$pwp" \
    -v "$(cd "$stage" && { pwd -W 2>/dev/null || pwd; }):/out" \
    postgres:16-alpine \
    pg_basebackup -h db -U "${POSTGRES_USER:-privacy}" -D /out -Ft -X stream -P \
    || rc=$?

  # Remove the credentials file on BOTH success and failure immediately after the
  # client returns, so the secret is not left on disk until process exit. The
  # cleanup() trap stays as the safety net for signals and early failures.
  rm -f "$pwfile" 2>/dev/null || true
  PHYS_PW_FILE=""

  if (( rc != 0 )); then
    fail "pg_basebackup failed (verify REPLICATION privilege, wal_level, max_wal_senders, pg_hba)"
  fi
}

# ---------------------------------------------------------------------------
# Main flow. Any failure exits non-zero and publishes NO complete manifest, so a
# consumer can never mistake a partial/failed run for a valid set.
# ---------------------------------------------------------------------------
ts="$(date -u +%Y%m%dT%H%M%SZ)"
suffix="$(printf '%06x' "$RANDOM$RANDOM" | cut -c1-6)"
base="m24-physbase-${ts}-${suffix}"

# Dedicated staging prefix (distinct from the logical .m24-tmp.* prefix). It is
# created inside BACKUP_DIR so every publish below is a same-filesystem atomic
# rename, and the trap removes it (and only it) on any exit.
STAGE="$(mktemp -d "$BACKUP_DIR_ABS/.m24-phys-tmp.XXXXXX")"
echo "physbackup: physical backup set $base" >&2

# 1) Transport: writes base.tar, pg_wal.tar, backup_manifest into $STAGE.
rc=0
run_transport "$STAGE" || rc=$?
if (( rc != 0 )); then
  fail "transport failed (rc=$rc); no manifest published; own staging will be removed"
fi

# 2) Every required member must exist and be non-empty.
for m in base.tar pg_wal.tar backup_manifest; do
  [[ -s "$STAGE/$m" ]] || fail "transport did not produce a non-empty $m; no manifest published"
done

# 3) Validate tar structure WITHOUT extracting untrusted content to disk:
#    `tar -tf` only reads headers, so a truncated/corrupt tar fails here. Nothing
#    is written by this step.
tar -tf "$STAGE/base.tar"   >/dev/null 2>&1 || fail "base.tar is not a readable tar archive"
tar -tf "$STAGE/pg_wal.tar" >/dev/null 2>&1 || fail "pg_wal.tar is not a readable tar archive"

# 4) backup_label is the root entry of base.tar. Read it to stdout only (never to
#    disk) and parse the two contract fields. Missing/invalid => fail, no manifest.
label="$(tar -xOf "$STAGE/base.tar" backup_label 2>/dev/null || true)"
[[ -n "$label" ]] || fail "base.tar has no backup_label; cannot establish base_lsn/base_timeline"
base_lsn="$(printf '%s\n' "$label" | awk '/^START WAL LOCATION:/ {print $4; exit}')"
base_timeline="$(printf '%s\n' "$label" | awk '/^START TIMELINE:/ {print $3; exit}')"
[[ "$base_lsn" =~ ^[0-9A-Fa-f]+/[0-9A-Fa-f]+$ ]] \
  || fail "backup_label START WAL LOCATION missing or invalid: '${base_lsn:-<empty>}'"
[[ "$base_timeline" =~ ^[0-9]+$ ]] \
  || fail "backup_label START TIMELINE missing or invalid: '${base_timeline:-<empty>}'"

# 5) SHA-256 and byte size for every member the manifest will reference.
sha_base="$(sha256_of "$STAGE/base.tar")"
sha_wal="$(sha256_of "$STAGE/pg_wal.tar")"
sha_man="$(sha256_of "$STAGE/backup_manifest")"
for s in "$sha_base" "$sha_wal" "$sha_man"; do
  is_sha256 "$s" || fail "failed to compute a valid SHA-256 for a member"
done
bytes_base="$(wc -c < "$STAGE/base.tar"         | tr -d ' \r\n')"
bytes_wal="$(wc -c <  "$STAGE/pg_wal.tar"       | tr -d ' \r\n')"
bytes_man="$(wc -c <  "$STAGE/backup_manifest"  | tr -d ' \r\n')"

# 5b) Extract WAL-Ranges from the PG16 JSON backup_manifest.
#     Structure: "WAL-Ranges": [{"Timeline": N, "Start-LSN": "a/b", "End-LSN": "c/d"}, ...]
#     Values are extracted in declaration order and validated field by field.
#     Absent "WAL-Ranges" key => wal_range_count=0 (documented; consumers
#     decide whether that is acceptable). Any malformed entry fails closed.
wal_range_count=0
wal_ranges_lines=""
if [[ -f "$STAGE/backup_manifest" ]]; then
  # A1 (M31.3): distinguish "no usable python3" from "invalid JSON". The original
  # message claimed the manifest was not valid JSON even when the interpreter was
  # simply absent or unusable (e.g. the Windows Store alias stub under Git Bash),
  # which is misleading. Both cases stay fail-closed: the set is never published.
  if ! python3 -c 'pass' >/dev/null 2>&1; then
    fail "python3 is required to validate backup_manifest JSON but is not usable on this host; refusing set"
  fi
  # Reject non-JSON manifests fail-closed before extracting ranges.
  if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$STAGE/backup_manifest" 2>/dev/null; then
    fail "backup_manifest is not valid JSON; refusing set"
  fi
  # Extract each field's values in declaration order.
  mapfile -t wal_tls < <(grep -o '"Timeline": [0-9]*' "$STAGE/backup_manifest" | sed 's/.*: //')
  mapfile -t wal_sts < <(grep -o '"Start-LSN": "[^"]*"' "$STAGE/backup_manifest" | sed 's/"Start-LSN": "//; s/"$//')
  mapfile -t wal_ens < <(grep -o '"End-LSN": "[^"]*"' "$STAGE/backup_manifest" | sed 's/"End-LSN": "//; s/"$//')
  # All three arrays must have the same length (each range entry is complete).
  wal_n=${#wal_tls[@]}
  [[ $wal_n -eq ${#wal_sts[@]} && $wal_n -eq ${#wal_ens[@]} ]] \
    || fail "WAL-Ranges entries are incomplete (timeline/start/end count mismatch)"
  for (( i = 0; i < wal_n; i++ )); do
    tl="${wal_tls[$i]}"
    st="${wal_sts[$i]}"
    en="${wal_ens[$i]}"
    # Validate timeline: positive integer.
    [[ "$tl" =~ ^[0-9]+$ ]] || fail "WAL-Ranges timeline is not a positive integer (got '$tl')"
    [[ "$tl" -gt 0 ]] || fail "WAL-Ranges timeline must be positive (got '$tl')"
    # Validate LSN format: HEX/HEX, up to 8 digits each half.
    [[ "$st" =~ ^[0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8}$ ]] \
      || fail "WAL-Ranges Start-LSN is not HEX/HEX (got '$st')"
    [[ "$en" =~ ^[0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8}$ ]] \
      || fail "WAL-Ranges End-LSN is not HEX/HEX (got '$en')"
    # Component-wise LSN comparison: start <= end (avoids int64 overflow).
    st_hi="$((16#${st%%/*}))"; st_lo="$((16#${st##*/}))"
    en_hi="$((16#${en%%/*}))"; en_lo="$((16#${en##*/}))"
    if (( st_hi > en_hi )) || (( st_hi == en_hi && st_lo > en_lo )); then
      fail "WAL-Ranges Start-LSN $st > End-LSN $en"
    fi
    # Detect duplicate timelines (ambiguous).
    for (( j = 0; j < i; j++ )); do
      if [[ "${wal_tls[$j]}" == "$tl" ]]; then
        fail "WAL-Ranges duplicate Timeline $tl"
      fi
    done
    wal_range_count=$((wal_range_count + 1))
    wal_ranges_lines+="wal_range_${wal_range_count}_timeline=$tl"$'\n'
    wal_ranges_lines+="wal_range_${wal_range_count}_start_lsn=${st^^}"$'\n'
    wal_ranges_lines+="wal_range_${wal_range_count}_end_lsn=${en^^}"$'\n'
  done
fi

# 6) Write our .pmanifest into staging. status=complete is written ONLY here,
#    after every member validated, and it references the FINAL (published) names.
pg_version="${PHYS_PG_VERSION:-16}"
man="$STAGE/${base}.pmanifest"
{
  printf 'format=pg-base-tar-set\n'
  printf 'schema_version=1\n'
  printf 'set_id=%s\n'          "$base"
  printf 'created_at=%s\n'      "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'postgres_version=%s\n' "$pg_version"
  printf 'base_lsn=%s\n'        "$base_lsn"
  printf 'base_timeline=%s\n'   "$base_timeline"
  printf 'wal_range_count=%s\n' "$wal_range_count"
  printf '%s' "$wal_ranges_lines"
  printf 'base_tar_file=%s\n'     "${base}.base.tar"
  printf 'base_tar_sha256=%s\n'   "$sha_base"
  printf 'base_tar_bytes=%s\n'    "$bytes_base"
  printf 'pgwal_tar_file=%s\n'    "${base}.pg_wal.tar"
  printf 'pgwal_tar_sha256=%s\n'  "$sha_wal"
  printf 'pgwal_tar_bytes=%s\n'   "$bytes_wal"
  printf 'manifest_file=%s\n'     "${base}.backup_manifest"
  printf 'manifest_sha256=%s\n'   "$sha_man"
  printf 'manifest_bytes=%s\n'    "$bytes_man"
  printf 'status=complete\n'
} > "$man"

# 7) Publish: members first, manifest LAST. Never overwrite an existing set.
if [[ -e "$BACKUP_DIR_ABS/${base}.pmanifest" ]]; then
  fail "refusing to overwrite an existing set: $base"
fi
mv "$STAGE/base.tar"         "$BACKUP_DIR_ABS/${base}.base.tar"
mv "$STAGE/pg_wal.tar"       "$BACKUP_DIR_ABS/${base}.pg_wal.tar"
mv "$STAGE/backup_manifest"  "$BACKUP_DIR_ABS/${base}.backup_manifest"
mv "$man"                    "$BACKUP_DIR_ABS/${base}.pmanifest"

echo "physbackup: published set $base in $BACKUP_DIR_ABS" >&2
echo "physbackup: base_lsn=$base_lsn timeline=$base_timeline (from backup_label)" >&2
echo "physbackup: NOTE integrity verified locally; restorability is NOT proven here (F-P5)" >&2
echo "physbackup: verify with: $0 --verify $BACKUP_DIR_ABS/${base}.pmanifest" >&2
exit 0


