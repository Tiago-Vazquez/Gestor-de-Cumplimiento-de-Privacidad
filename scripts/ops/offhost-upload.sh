#!/usr/bin/env bash
# M26.0: off-host upload of a backup set to S3-compatible object storage.
#
# Reads the three artefacts of one backup and publishes them to
# backups/<env>/<base>.{dump,roles.sql,manifest}. It is deliberately a separate
# script from postgres-backup.sh: the local backup must remain verifiable and
# runnable on a host that has no off-host configuration at all, and coupling
# them would mean a missing endpoint disables local backups too.
#
# The transport is injected through OFFHOST_S3_CMD so the contract can be
# exercised against a local double with no network, no credentials and no aws
# CLI. M26 has to be testable before the B2 account exists, and the account
# cannot be created until the production VPS location is known.
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/ops/common.sh
source "$ROOT_DIR/scripts/ops/common.sh"

# Prefijo de las lineas de alerta en los logs de este script.
ALERT_LOG_PREFIX="offhost"

# M29.2 A2: alerting. El 76 NACE AQUI, asi que la alerta se emite aqui: este es
# el unico punto del repositorio donde se produce EXIT_UPLOAD_FAILED. El mismo
# contrato ALERT_CMD que usa backup-schedule.sh, con el emisor compartido en
# lib/alert.sh para que no haya dos definiciones del payload JSON.
# El calendario de A1 NO ejecuta este script (ver docs/operations-runbook.md 12).
# shellcheck source=scripts/ops/lib/alert.sh
source "$ROOT_DIR/scripts/ops/lib/alert.sh"

# M26.0: 75 is already EX_TEMPFAIL (lock held). 76 is new and distinct: the
# local backup is complete and verified, but it is NOT off-host. The distinction
# is the whole point. Exit 1 can be a full disk; 76 means the host is healthy
# and simply has no off-site copy. An alert that cannot tell them apart is not
# actionable.
EXIT_UPLOAD_FAILED=76

# Un unico timestamp por ejecucion, reutilizado por todas las alertas de este
# script: varios objetos pueden fallar, pero un unico evento describe la
# ejecucion. Se captura al inicio para que la hora sea la del intento, no la
# del ultimo objeto reintentado.
ALERT_TIMESTAMP="$(date -u +%FT%TZ)"

BUCKET="${BACKUP_BUCKET:-}"
# NOTE on ${VAR-default} vs ${VAR:-default}: the `:-` form also substitutes when
# the variable is set but EMPTY, so an operator who deliberately sets
# BACKUP_PREFIX= (to assert "use the account root") would silently get "prod"
# instead, and the guard below would never see the empty value. The `-` form
# only substitutes when the variable is genuinely unset, so an explicit empty
# reaches the validation and is rejected with a specific message.
PREFIX="${BACKUP_PREFIX-prod}"
ENDPOINT="${B2_S3_ENDPOINT-}"
REGION="${B2_S3_REGION-}"
# The retry knobs keep `:-` on purpose: an empty value there is a typo, and
# falling back to the documented default is the safe reading of it.
RETRIES="${OFFHOST_UPLOAD_RETRIES:-3}"
RETRY_DELAY="${OFFHOST_UPLOAD_RETRY_DELAY_SECONDS:-5}"
# M31.8 (C4): whether the PUT also carries sha256 as object metadata. OFF by
# default and validated as a strict 0/1, because the default path must be exactly
# the request shape that has been exercised so far. `--metadata` maps to the
# standard x-amz-meta-* headers, but this client has never talked to B2, and an
# unverified option in the default path would turn F-P7's first upload into a
# test of the option instead of a test of the backup. Metadata is also never
# trusted as evidence: the read-back below is what proves the stored bytes.
METADATA_SHA256="${OFFHOST_UPLOAD_METADATA_SHA256:-0}"
# Order is fixed by the contract, not by a variable. The manifest is the commit
# record: its presence means the set is complete, so it must be the last object
# to exist. A variable would let someone reorder these and silently break the
# invariant, which is exactly the kind of change no test would catch.
#
# The entries are the real object suffixes, not logical names: key_for() appends
# them verbatim, and postgres-restore.sh derives the siblings by stripping
# ".dump" and re-appending ".roles.sql". A "roles" entry here would publish
# "<base>.roles" while the restore looks for "<base>.roles.sql", so the set would
# look complete in the bucket and fail at restore time.
UPLOAD_ORDER=("dump" "roles.sql" "manifest")

usage() {
  cat <<'EOF'
Usage: bash scripts/ops/offhost-upload.sh --backup FILE [--roles FILE] [--manifest FILE]
                                       [--dry-run]
                                       [--physical-set SET.pmanifest] [--wal-dir DIR]

Publishes one backup set to S3-compatible object storage in the order
dump -> roles.sql -> manifest. The manifest goes last and is the commit record.

With --physical-set (M31.4 / F-P6) the physical base set, its complementary WAL
chain manifest (<set_id>.walchain) and every archived WAL segment the chain
references are uploaded too, under backups/<PREFIX>/physical/<set_id>/. The chain
manifest is uploaded LAST: it is the commit record for the physical set, so a
consumer can tell a complete set from a partial one. --wal-dir is required with
--physical-set and is where the segments live.

Verification and divergence guard (M31.8):

  Before any object is uploaded, the digest fields of the logical manifest
  (dump_sha256, roles_sha256) are checked against the local files that are about
  to be published. A set whose bytes do not match its own manifest is refused
  before the first request.

  Every object that is already stored is READ FIRST and compared with the local
  file (size, then content). An existing object with different bytes is never
  overwritten: the run fails safely and the commit record is not published. An
  existing object with identical bytes is re-published, which keeps the run
  idempotent without ever replacing content this run did not produce.

  After all uploads, every expected object is read back (HEAD for existence and
  size, GET for content) and its stored SHA-256 is compared with the local file.
  All objects are inspected and the mismatches are accumulated. The summary
  reports remote_verified=yes only when every expected object passed.

  remote_verified=yes means "the bytes stored right now are byte-identical to the
  local files". It says NOTHING about durability, versioning, Object Lock or
  lifecycle: those are F-P7 and are not claimed here.

  The divergence guard is a read-then-write, NOT a conditional write. This client
  has no If-None-Match/If-Match, so the window between the read and the PUT
  exists; the read-back verification that follows is what catches a divergence
  that landed inside that window. The ETag is deliberately never treated as a
  digest: for a multipart upload it is not even an MD5 of the whole object.

  The reference used by the read-back is the pair (SHA-256, size) captured BEFORE
  the object is published. A local file that changes afterwards therefore cannot
  turn a correct remote copy into a false mismatch, and the two halves of the
  reference always describe the same bytes. The registry must be non-empty: an
  empty registry is a verification failure, never a silent success.

  Every external dependency (transport, HEAD, GET, SHA-256 tool) is resolved
  BEFORE the first object is published, so exit 1 keeps meaning "nothing was
  published". A dependency that disappears while or after publishing is a failure
  of the remote path and exits 76, not 1.

Required environment:
  BACKUP_BUCKET                        target bucket
  B2_S3_ENDPOINT                       e.g. https://s3.<region>-<NNN>.backblazeb2.com
  B2_S3_REGION                         signing region
  B2_WRITE_KEY_ID, B2_WRITE_SECRET_KEY

Optional:
  BACKUP_PREFIX                        environment prefix (default: prod)
  OFFHOST_UPLOAD_RETRIES               attempts per object (default: 3)
  OFFHOST_UPLOAD_RETRY_DELAY_SECONDS   delay between attempts (default: 5)
  OFFHOST_S3_CMD                       PUT override (tests): <file> <key>
                                       [retain_until] [sha256]; the default
                                       invokes `aws s3api put-object`
  OFFHOST_S3_HEAD_CMD                  HEAD override (tests): <key> -> prints the
                                       stored size, exit 0 exists / 3 absent /
                                       anything else undetermined
  OFFHOST_S3_GET_CMD                   GET override (tests): <key> <dest>
  OFFHOST_UPLOAD_METADATA_SHA256       1 = also send sha256 as object metadata
                                       (default 0). Left off until F-P7 confirms
                                       the endpoint accepts x-amz-meta-*: the
                                       option is standard S3 API surface, but
                                       "standard" is not "verified against B2",
                                       and metadata is not trusted as evidence
                                       anyway (the read-back is).

Exit codes:
  0   every object uploaded (logical set, and the physical set when requested)
      and read back byte-identical to the local file
  1   invalid configuration, missing input, or a local artefact that does not
      match its own manifest (nothing is published)
  76  local backup fine, upload OR remote verification failed (local copy kept)
EOF
}

fail() { echo "offhost: $*" >&2; exit 1; }

BACKUP_FILE=""
ROLES_FILE=""
MANIFEST_FILE=""
PHYS_SET=""
PHYS_WALDIR=""
DRY_RUN=0

while (($#)); do
  case "$1" in
    --backup)   [[ $# -ge 2 ]] || fail "--backup needs a file"; BACKUP_FILE="$2"; shift 2 ;;
    --roles)    [[ $# -ge 2 ]] || fail "--roles needs a file"; ROLES_FILE="$2"; shift 2 ;;
    --manifest) [[ $# -ge 2 ]] || fail "--manifest needs a file"; MANIFEST_FILE="$2"; shift 2 ;;
    --physical-set) [[ $# -ge 2 ]] || fail "--physical-set needs a file"; PHYS_SET="$2"; shift 2 ;;
    --wal-dir)  [[ $# -ge 2 ]] || fail "--wal-dir needs a directory"; PHYS_WALDIR="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

[[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]] || fail "--backup must point to an existing dump"
backup_dir="$(cd "$(dirname "$BACKUP_FILE")" && pwd -P)"
BACKUP_FILE="$backup_dir/$(basename "$BACKUP_FILE")"
# basename is mandatory: ${BACKUP_FILE%.dump} strips the extension but keeps the
# directory, which would make every key absolute ("backups/prod//var/backups/...").
# An absolute key is outside the credential's namePrefix, so B2 would reject it,
# and the failure would look like a permissions problem rather than a name bug.
base="$(basename "${BACKUP_FILE%.dump}")"
# The sibling artefacts are resolved from the directory captured BEFORE the
# basename reduction. Deriving them from the reduced `base` would make them
# relative to the caller's working directory, so a restore or upload started
# from anywhere but BACKUP_DIR would not find them.
ROLES_FILE="${ROLES_FILE:-$backup_dir/${base}.roles.sql}"
MANIFEST_FILE="${MANIFEST_FILE:-$backup_dir/${base}.manifest}"
[[ -f "$ROLES_FILE" ]] || fail "roles export not found: $ROLES_FILE"
[[ -f "$MANIFEST_FILE" ]] || fail "manifest not found: $MANIFEST_FILE"

[[ -n "$BUCKET" ]] || fail "BACKUP_BUCKET is required"
[[ -n "$ENDPOINT" ]] || fail "B2_S3_ENDPOINT is required"
is_positive_int "$RETRIES" || fail "OFFHOST_UPLOAD_RETRIES must be a positive integer (got: $RETRIES)"
[[ "$RETRY_DELAY" =~ ^[0-9]+$ ]] || fail "OFFHOST_UPLOAD_RETRY_DELAY_SECONDS must be a non-negative integer (got: $RETRY_DELAY)"
[[ "$METADATA_SHA256" =~ ^[01]$ ]] || fail "OFFHOST_UPLOAD_METADATA_SHA256 must be 0 or 1 (got: $METADATA_SHA256)"

# The environment prefix becomes a key prefix verbatim, so a value with a
# leading slash, a trailing slash or a traversal segment would produce keys that
# do not match what the credential's namePrefix allows; B2 rejects a key outside
# that prefix at request time. Rejecting it here turns a confusing remote error
# into a specific local one.
[[ "$PREFIX" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
  || fail "BACKUP_PREFIX must be a single path segment of letters, digits, dots, hyphens or underscores (got: $PREFIX)"

key_for() { printf 'backups/%s/%s.%s' "$PREFIX" "$base" "$1"; }

file_for() {
  case "$1" in
    dump)      printf '%s' "$BACKUP_FILE" ;;
    roles.sql) printf '%s' "$ROLES_FILE" ;;
    manifest)  printf '%s' "$MANIFEST_FILE" ;;
    *) fail "unknown artefact: $1" ;;
  esac
}

mval() { awk -F= -v k="$1" '$1==k {sub(/^[^=]*=/,""); print; exit}' "$2"; }

# ---------------------------------------------------------------------------
# Optional physical/WAL integration (M31.4 / F-P6). Everything is validated
# BEFORE the first upload: a broken physical set must not leave a published
# logical set next to a dangling physical prefix.
# ---------------------------------------------------------------------------
PHYS_SET_ID=""; PHYS_DIR=""; PHYS_WALDIR_ABS=""; PHYS_CHAIN=""
PHYS_MEMBERS=(); PHYS_SEGMENTS=(); PHYS_AUX=()
# M31.8: the digest each member was already VERIFIED against, kept so the upload
# does not re-hash the same bytes. The validation below hashes every member once;
# hashing a multi-gigabyte base tar a second time would double the cost of every
# run for a value that cannot have changed in between (the file is read here,
# never written).
PHYS_MEMBER_SHA=(); PHYS_SEG_SHA=(); PHYS_AUX_SHA=()
if [[ -n "$PHYS_SET" ]]; then
  [[ -n "$PHYS_WALDIR" ]] || fail "--wal-dir is required with --physical-set"
  [[ -f "$PHYS_SET" ]] || fail "--physical-set not found: $PHYS_SET"
  [[ ! -L "$PHYS_SET" ]] || fail "--physical-set is a symlink; refusing: $PHYS_SET"
  [[ -d "$PHYS_WALDIR" ]] || fail "--wal-dir is not a directory: $PHYS_WALDIR"
  PHYS_DIR="$(cd "$(dirname "$PHYS_SET")" && pwd -P)"
  PHYS_WALDIR_ABS="$(cd "$PHYS_WALDIR" && pwd -P)"

  [[ "$(mval format "$PHYS_SET")" == "pg-base-tar-set" ]] \
    || fail "--physical-set is not a pg-base-tar-set manifest: $PHYS_SET"
  PHYS_SET_ID="$(mval set_id "$PHYS_SET")"
  [[ "$PHYS_SET_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || fail "physical set_id is not a safe single path segment: '${PHYS_SET_ID:-<empty>}'"
  [[ "$(basename "$PHYS_SET")" == "$PHYS_SET_ID.pmanifest" ]] \
    || fail "physical manifest filename does not match its set_id (expected $PHYS_SET_ID.pmanifest)"

  # Members referenced by the manifest must exist with the recorded size+sha256.
  for key in base_tar pgwal_tar manifest; do
    f="$(mval "${key}_file" "$PHYS_SET")"
    want_sha="$(mval "${key}_sha256" "$PHYS_SET")"
    want_bytes="$(mval "${key}_bytes" "$PHYS_SET")"
    [[ -n "$f" && -n "$want_sha" && -n "$want_bytes" ]] || fail "physical manifest is missing ${key}_* fields"
    [[ "$f" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail "unsafe member name in physical manifest: '$f'"
    [[ -f "$PHYS_DIR/$f" && ! -L "$PHYS_DIR/$f" ]] || fail "physical member missing or symlink: $PHYS_DIR/$f"
    is_sha256 "$want_sha" || fail "physical manifest ${key}_sha256 is not a digest"
    [[ "$(sha256_of "$PHYS_DIR/$f")" == "$want_sha" ]] || fail "physical member $f does not match its recorded sha256"
    [[ "$(wc -c < "$PHYS_DIR/$f" | tr -d ' \r\n')" == "$want_bytes" ]] || fail "physical member $f does not match its recorded size"
    PHYS_MEMBERS+=("$f")
    PHYS_MEMBER_SHA+=("$want_sha")
  done
  # The physical manifest itself is a member of the set and travels with it. Its
  # own digest is not recorded inside it (that would be circular), so it is
  # computed here, once.
  PHYS_MEMBERS+=("$(basename "$PHYS_SET")")
  PHYS_MEMBER_SHA+=("$(sha256_of "$PHYS_SET")")

  # Complementary WAL chain: required, and re-verified against the WAL store.
  PHYS_CHAIN="$PHYS_DIR/$PHYS_SET_ID.walchain"
  [[ -f "$PHYS_CHAIN" && ! -L "$PHYS_CHAIN" ]] \
    || fail "complementary WAL chain manifest not found: $PHYS_CHAIN (run wal-chain-manifest.sh --emit first)"
  bash "$ROOT_DIR/scripts/ops/wal-chain-manifest.sh" --verify --chain "$PHYS_CHAIN" \
    --wal-dir "$PHYS_WALDIR_ABS" --set-dir "$PHYS_DIR" >/dev/null 2>&1 \
    || fail "the WAL chain manifest does not verify against --wal-dir and the physical set: $PHYS_CHAIN"
  [[ "$(mval base_set "$PHYS_CHAIN")" == "$PHYS_SET_ID" ]] \
    || fail "chain manifest base_set does not match the physical set_id"

  n=0
  while true; do
    n=$((n + 1))
    seg="$(mval "segment_${n}_name" "$PHYS_CHAIN")"
    [[ -z "$seg" ]] && break
    [[ "$seg" =~ ^[0-9A-F]{24}$ ]] || fail "chain references a non-canonical segment name: '$seg'"
    [[ -f "$PHYS_WALDIR_ABS/$seg" && ! -L "$PHYS_WALDIR_ABS/$seg" ]] || fail "chain segment missing: $seg"
    seg_sha="$(mval "segment_${n}_sha256" "$PHYS_CHAIN")"
    is_sha256 "$seg_sha" || fail "chain manifest carries no valid sha256 for segment $seg"
    PHYS_SEGMENTS+=("$seg")
    PHYS_SEG_SHA+=("$seg_sha")
  done
  n=0
  while true; do
    n=$((n + 1))
    aux="$(mval "aux_${n}_name" "$PHYS_CHAIN")"
    [[ -z "$aux" ]] && break
    [[ "$aux" =~ ^([0-9A-F]{24}\.[0-9A-F]{8}\.backup|[0-9A-F]{8}\.history)$ ]] || fail "chain references a non-canonical auxiliary name: '$aux'"
    [[ -f "$PHYS_WALDIR_ABS/$aux" && ! -L "$PHYS_WALDIR_ABS/$aux" ]] || fail "chain auxiliary artefact missing: $aux"
    aux_sha="$(mval "aux_${n}_sha256" "$PHYS_CHAIN")"
    is_sha256 "$aux_sha" || fail "chain manifest carries no valid sha256 for auxiliary artefact $aux"
    PHYS_AUX+=("$aux")
    PHYS_AUX_SHA+=("$aux_sha")
  done
  [[ ${#PHYS_SEGMENTS[@]} -gt 0 ]] || fail "the chain references no segments; refusing to publish an empty physical set"
fi

# ---------------------------------------------------------------------------
# M31.8 (C1) — the logical manifest must describe the files being uploaded.
#
# The manifest carries dump_sha256 and roles_sha256, and postgres-restore.sh
# compares the artefact it is about to restore against those fields. Publishing a
# set whose bytes do not match its own manifest defers the discovery to restore
# time, on a host that may no longer have the original file to compare against.
# The check is local, costs one hash per artefact, and happens BEFORE the first
# PUT: when it fails nothing is published and no credential is used.
#
# Exit 1 (invalid input), NOT 76. The runbook defines 76 as "the local backup is
# fine and the upload failed"; here the local set itself is not trustworthy, which
# is a different incident with a different response. It is also the reason the
# manifest is read with the same tolerant readers postgres-restore.sh uses
# (strip_cr / strip_sha_prefix): a manifest written on Windows must not be
# accepted by the restore and rejected by the upload.
# ---------------------------------------------------------------------------
manifest_format="$(mval format "$MANIFEST_FILE")"
[[ -n "$manifest_format" ]] || fail "the manifest has no format field: $MANIFEST_FILE"
DUMP_SHA="$(strip_sha_prefix "$(strip_cr "$(mval dump_sha256 "$MANIFEST_FILE")")")"
ROLES_SHA="$(strip_sha_prefix "$(strip_cr "$(mval roles_sha256 "$MANIFEST_FILE")")")"
is_sha256 "$DUMP_SHA" \
  || fail "the manifest carries no valid dump_sha256 (got: '${DUMP_SHA:-<empty>}'): $MANIFEST_FILE"
is_sha256 "$ROLES_SHA" \
  || fail "the manifest carries no valid roles_sha256 (got: '${ROLES_SHA:-<empty>}'): $MANIFEST_FILE"
# M31.10 (H-4): a hashing tool that fails must produce its own diagnostic, not a
# bare exit with no message, and an empty digest must never be compared as if it
# were a mismatch. Both cases remain exit 1: this runs before the first PUT.
actual_sha="$(sha256_of "$BACKUP_FILE")" \
  || fail "the SHA-256 of the dump could not be computed (the hashing tool failed): $BACKUP_FILE"
is_sha256 "$actual_sha" || fail "the computed SHA-256 of the dump is not a digest: '${actual_sha:-<empty>}'"
[[ "$actual_sha" == "$DUMP_SHA" ]] \
  || fail "the dump does not match dump_sha256 in its own manifest (manifest=$DUMP_SHA actual=$actual_sha): $BACKUP_FILE"
actual_sha="$(sha256_of "$ROLES_FILE")" \
  || fail "the SHA-256 of the roles export could not be computed (the hashing tool failed): $ROLES_FILE"
is_sha256 "$actual_sha" || fail "the computed SHA-256 of the roles export is not a digest: '${actual_sha:-<empty>}'"
[[ "$actual_sha" == "$ROLES_SHA" ]] \
  || fail "the roles export does not match roles_sha256 in its own manifest (manifest=$ROLES_SHA actual=$actual_sha): $ROLES_FILE"

# Default transport: one `aws s3api put-object` per artefact.
#
# `s3api put-object` is used rather than `s3 cp` because Object Lock is applied
# per request with --object-lock-mode/--object-lock-retain-until-date, and only
# the api-level call exposes them. M26.0 does not set those flags: retention is
# applied by the bucket default once the account exists, so this client does
# not need to know the retention days. That is deliberate — a hardcoded
# retain-until date in the client would outlive any change to that policy.
aws_transport() {
  local file="$1" key="$2" retain_until="${3:-}" sha256="${4:-}"
  local -a args=(s3api put-object --bucket "$BUCKET" --key "$key" --body "$file" --endpoint-url "$ENDPOINT")
  # A missing --region would make the CLI sign with a default region, and B2
  # answers that with SignatureDoesNotMatch rather than a usable error, so an
  # absent region is surfaced here instead.
  if [[ -n "$REGION" ]]; then args+=(--region "$REGION"); fi
  if [[ -n "$retain_until" ]]; then
    args+=(--object-lock-mode GOVERNANCE --object-lock-retain-until-date "$retain_until")
  fi
  # M31.8 (C4): opt-in. Not enabled by default (see METADATA_SHA256 above).
  if ((METADATA_SHA256)) && [[ -n "$sha256" ]]; then
    args+=(--metadata "sha256=$sha256")
  fi
  aws "${args[@]}"
}

transport() {
  local file="$1" key="$2" retain_until="${3:-}" sha256="${4:-}"
  if [[ -n "${OFFHOST_S3_CMD:-}" ]]; then
    "$OFFHOST_S3_CMD" "$file" "$key" "$retain_until" "$sha256"
  else
    command -v aws >/dev/null 2>&1 || fail "aws CLI is required for the off-host upload (or set OFFHOST_S3_CMD)"
    aws_transport "$file" "$key" "$retain_until" "$sha256"
  fi
}

# ---------------------------------------------------------------------------
# M31.15 (A3) — removing a scratch file is a recoverable operation.
#
# `rm -f` is not a formality: it is a syscall that fails when the scratch directory
# has become unwritable or when the path is not a plain file, and under `set -e` a
# bare `rm -f` aborted the whole run with status 1 and no `offhost:` diagnostic —
# in the middle of the publish or read-back phase, which is the same class M31.13
# (H-11) fixed for `wc -c`. Correctness does not depend on the removal: every read
# is preceded by a removal and a failed read never hashes whatever is on disk, so
# the failure is reported and the run continues with the code its real outcome
# earns. Two precision notes, both verified on bash 5.2:
#   - `set -e` is IGNORED inside a function called from a condition (`if
#     verify_remote`), so the removals on that path could not abort even without
#     this guard. The guard still matters where `set -e` IS active: publish() is
#     called as a plain command, so its probe removals would abort the run.
#   - A failing command inside an EXIT trap DOES replace the exit status under
#     `set -e` (`trap f EXIT; exit 76` exits 1), which is why the trap below has its
#     own guard instead of a comment claiming it is harmless.
rm_scratch() {  # <path>
  if ! rm -f "$1"; then
    printf 'offhost: warning: the scratch file %s could not be removed; continuing (the next read rewrites it)\n' "$1" >&2
  fi
}

# ---------------------------------------------------------------------------
# M31.8 (C2/C3) — remote reads: HEAD for existence and size, GET for content.
#
# `s3api put-object` returning 0 means the request was ACCEPTED. It is not
# evidence that the object exists, that its bytes match the local file, or that
# it will still be there tomorrow. M31.6's H-05 signal said exactly that
# (`remote_verified=no`); M31.8 makes the verification real so the signal can
# become truthful.
#
# Two operations, each with its own seam so the offline double can model every
# failure mode with no network, no credentials and no aws CLI:
#
#   remote_head <key>          prints the stored size on stdout
#                              exit 0 : the object exists
#                              exit 3 : the service answered "not found"
#                              other  : could not be determined (network, auth)
#   remote_get  <key> <dest>   writes the stored body to <dest>
#
# Exit 3 is deliberately NOT "any error". Reading a transient read failure as
# "absent" would turn it into an unconditional overwrite of whatever is stored
# there, which is the exact data loss the divergence guard exists to prevent.
# The default implementations map the aws CLI's 404-shaped error to 3 and treat
# every other failure as undetermined; that mapping is the CLI's behaviour and
# has NOT been exercised against B2 (F-P7), which is why the double exists.
#
# M31.11 (H-5): stdout and stderr are captured SEPARATELY. stdout carries the
# answer (the size, the body path) and stderr carries diagnostics; merging them
# made a warning on stderr indistinguishable from the answer, so a perfectly good
# HEAD could be read as unusable. Diagnostics are still reported — just not parsed
# as an answer — and a response that cannot be interpreted is refused, never
# guessed.
aws_head() {
  local key="$1" out err rc=0
  local err_file
  # The scratch directory is created before the first PUT and removed by the exit
  # trap; if it is somehow unavailable the probe is refused instead of guessing
  # (1 = undetermined, which the caller turns into 76).
  if [[ -z "${VERIFY_TMP:-}" || ! -d "$VERIFY_TMP" ]]; then
    printf 'offhost: internal error: the read-back scratch directory is unavailable; refusing to probe\n' >&2
    return 1
  fi
  err_file="$VERIFY_TMP/aws-head.err"
  local -a args=(s3api head-object --bucket "$BUCKET" --key "$key"
    --endpoint-url "$ENDPOINT" --query ContentLength --output text)
  if [[ -n "$REGION" ]]; then args+=(--region "$REGION"); fi
  out="$(aws "${args[@]}" 2>"$err_file")" || rc=$?
  err="$(cat "$err_file" 2>/dev/null || true)"
  rm_scratch "$err_file"
  if ((rc != 0)); then
    # Only the CLI's own "absent" rendering means "absent". Nothing else is treated
    # as absent: an authentication error, a timeout, a connectivity error, a server
    # error or an unrecognised answer stay undetermined, and the caller turns an
    # undetermined probe into a refusal (76), never into a PUT.
    #
    # M31.13 (H-10): the classifier used to accept a bare `404`/`Not Found`/
    # `NoSuchKey`/`NotFound` SUBSTRING anywhere in the text. A 503, a 403 or a
    # connection error whose message merely quoted "404" — a request id, a URL, a
    # bucket name — was therefore read as a missing object, and a missing object is
    # published unconditionally, which overwrites whatever is stored under that key.
    # That is the one failure mode with data loss in it, so the accepted shapes are
    # now the CLI's positional ones and nothing else:
    #
    #   An error occurred (404) when calling the HeadObject operation: ...
    #   An error occurred (NoSuchKey) when calling the HeadObject operation: ...
    #   An error occurred (NotFound) when calling the HeadObject operation: ...
    #
    # The token must sit in the parenthesised slot the CLI reserves for the HTTP
    # status (a 404 answer whose body carries no code) or for the service error code.
    # The surrounding sentence is NOT required, because a wrapper may translate it;
    # the slot is what distinguishes a status from free text. A DIFFERENT explicit
    # status in the same message (403, 500, 503, ...) contradicts an absence claim
    # and keeps the probe undetermined. The exit code is deliberately not used as
    # evidence: the CLI's numeric codes are its own behaviour and are NOT verified
    # against B2 (F-P7), so the text shape is the only signal trusted here.
    if grep -qE '\((404|NoSuchKey|NotFound)\)' <<<"$err$out"; then
      local other_statuses
      # Every parenthesised 3-digit status other than 404. `|| true` keeps a
      # no-match (or an all-404 match) from aborting under `set -e`: no output here
      # means "no contradicting status", which is the accepting case.
      other_statuses="$(grep -oE '\([0-9]{3}\)' <<<"$err$out" \
        | tr -d '()' | grep -v '^404$' | sort -u | tr '\n' ' ' || true)"
      if [[ -z "$other_statuses" ]]; then return 3; fi
      printf 'offhost: head-object for %s carries a 404-shaped token but a different status (%s); refusing to read it as an absent object: %s\n' \
        "$key" "${other_statuses% }" "${err:-$out}" >&2
      return 1
    fi
    printf 'offhost: head-object failed for %s (exit %s): %s\n' "$key" "$rc" "${err:-$out}" >&2
    return 1
  fi
  if [[ ! "$out" =~ ^[0-9]+$ ]]; then
    # A success status with an answer that is not a size is ambiguous. Guessing
    # would mean either overwriting an object whose state is unknown or skipping a
    # real divergence, so it fails conservatively.
    printf 'offhost: head-object returned an ambiguous answer for %s (exit 0, stdout=%q, stderr=%q); refusing to guess\n' \
      "$key" "$out" "$err" >&2
    return 1
  fi
  # A warning on stderr does not invalidate a valid answer, but it is not hidden.
  if [[ -n "$err" ]]; then
    printf 'offhost: head-object for %s reported diagnostics on stderr: %s\n' "$key" "$err" >&2
  fi
  printf '%s' "$out"
}

aws_get() {
  local key="$1" dest="$2" out err rc=0
  local err_file
  if [[ -z "${VERIFY_TMP:-}" || ! -d "$VERIFY_TMP" ]]; then
    printf 'offhost: internal error: the read-back scratch directory is unavailable; refusing to download\n' >&2
    return 1
  fi
  err_file="$VERIFY_TMP/aws-get.err"
  local -a args=(s3api get-object --bucket "$BUCKET" --key "$key"
    --endpoint-url "$ENDPOINT" "$dest")
  if [[ -n "$REGION" ]]; then args+=(--region "$REGION"); fi
  out="$(aws "${args[@]}" 2>"$err_file")" || rc=$?
  err="$(cat "$err_file" 2>/dev/null || true)"
  rm_scratch "$err_file"
  if ((rc != 0)); then
    # The body is only ever the file on disk, so a non-zero exit is a failed read no
    # matter what was printed. Diagnostics from both streams are preserved.
    printf 'offhost: get-object failed for %s (exit %s): %s\n' "$key" "$rc" "${err:-$out}" >&2
    return 1
  fi
  # A GET that reports success but leaves no body is not a successful read: the
  # hash of a missing file would otherwise be compared against the local digest.
  [[ -f "$dest" ]] \
    || { printf 'offhost: get-object wrote no body for %s\n' "$key" >&2; return 1; }
  # The CLI writes the object metadata to stdout. It is not the body and it is never
  # hashed; it is reported so a warning is not lost.
  if [[ -n "$err" ]]; then
    printf 'offhost: get-object for %s reported diagnostics on stderr: %s\n' "$key" "$err" >&2
  fi
  return 0
}

# ---------------------------------------------------------------------------
# M31.10 (H-4) — resolve every external dependency BEFORE the first PUT.
#
# The uploader publishes as it goes, so a dependency discovered halfway through the
# run cannot be reported as "nothing was published": exit 1 means exactly that in
# the runbook. Checking here keeps 1 for what happens before any publication, and
# leaves 76 for whatever fails while or after publishing.
#
# Only reached outside --dry-run: a rehearsal publishes nothing and needs no
# transport, which is the behaviour --dry-run has always had.
# ---------------------------------------------------------------------------
require_exec() {  # <variable-name> <value>
  [[ -x "$2" ]] || command -v "$2" >/dev/null 2>&1 \
    || fail "$1 is neither executable nor on PATH: $2"
}

check_dependencies() {
  if [[ -n "${OFFHOST_S3_CMD:-}" ]]; then
    require_exec OFFHOST_S3_CMD "$OFFHOST_S3_CMD"
  else
    command -v aws >/dev/null 2>&1 \
      || fail "aws CLI is required for the off-host upload (or set OFFHOST_S3_CMD)"
  fi
  if [[ -n "${OFFHOST_S3_HEAD_CMD:-}" ]]; then
    require_exec OFFHOST_S3_HEAD_CMD "$OFFHOST_S3_HEAD_CMD"
  else
    command -v aws >/dev/null 2>&1 \
      || fail "aws CLI is required for the read-back verification (or set OFFHOST_S3_HEAD_CMD)"
  fi
  if [[ -n "${OFFHOST_S3_GET_CMD:-}" ]]; then
    require_exec OFFHOST_S3_GET_CMD "$OFFHOST_S3_GET_CMD"
  else
    command -v aws >/dev/null 2>&1 \
      || fail "aws CLI is required for the read-back verification (or set OFFHOST_S3_GET_CMD)"
  fi
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
    || fail "neither sha256sum nor shasum is available; the local artefacts cannot be hashed"
}

remote_head() {
  if [[ -n "${OFFHOST_S3_HEAD_CMD:-}" ]]; then
    "$OFFHOST_S3_HEAD_CMD" "$1"
    return $?
  fi
  # M31.10 (H-4): by the time this runs the run may already have published objects,
  # so a missing tool is not the configuration error that "published nothing": it is
  # a failure of the remote read path, and the caller turns it into 76. Its absence
  # before the first PUT is caught by check_dependencies() and still exits 1.
  command -v aws >/dev/null 2>&1 \
    || { printf 'offhost: the aws CLI is not available for the remote read (undetermined)\n' >&2; return 1; }
  aws_head "$1"
}

remote_get() {
  if [[ -n "${OFFHOST_S3_GET_CMD:-}" ]]; then
    "$OFFHOST_S3_GET_CMD" "$1" "$2"
    return $?
  fi
  command -v aws >/dev/null 2>&1 \
    || { printf 'offhost: the aws CLI is not available for the remote read (undetermined)\n' >&2; return 1; }
  aws_get "$1" "$2"
}

# ---------------------------------------------------------------------------
# M31.8 (C2) — expected-object registry.
#
# Every object this run intends to publish is registered BEFORE its PUT, with the
# local file, that file's SHA-256 and its size. The read-back phase walks the
# registry and not the upload log: an object whose PUT failed must not silently
# disappear from the set that gets verified.
#
# M31.10 (H-3): the size is stored HERE, next to the digest, and not re-read at
# verification time. A size read later would describe the file as it is then while
# the digest still describes the bytes that were published, so the two halves of the
# reference could belong to different contents. The pair (digest, size) is the
# reference for what was published, and it is captured in one place.
# ---------------------------------------------------------------------------
EXPECT_KEYS=(); EXPECT_FILES=(); EXPECT_SHA=(); EXPECT_BYTES=()
IDENTICAL=0
register_expected() { EXPECT_KEYS+=("$1"); EXPECT_FILES+=("$2"); EXPECT_SHA+=("$3"); EXPECT_BYTES+=("$4"); }

# The 76 is born here too: a divergence or an unreadable remote object is an
# upload-side failure by contract, so the alert is emitted at this point exactly
# as upload_file() does for a failed PUT. The event name stays
# partial_upload_failed because that is the documented 76 event; a new name would
# be invisible to a consumer that matches on it.
fail_remote() {  # <headline> <detail>
  printf 'offhost: %s\n' "$1" >&2
  printf 'offhost:   %s\n' "$2" >&2
  echo "offhost: the remote object was left untouched and nothing further was published" >&2
  echo "offhost: the local backup is intact and will be retried on the next run" >&2
  emit_alert "partial_upload_failed" "$EXIT_UPLOAD_FAILED" "$ALERT_TIMESTAMP"
  exit "$EXIT_UPLOAD_FAILED"
}

# ---------------------------------------------------------------------------
# M31.8 (C3) — publish one object behind a divergence guard.
#
# The guard is a read-then-write, NOT a conditional write. This client has no
# If-None-Match/If-Match, and there is no evidence that the endpoint honours them
# for PUT, so the window between the read and the write is REAL and is not closed
# here. What the guard does guarantee: a divergence already stored when the object
# is examined is never overwritten, and the read-back phase that follows catches a
# divergence that appeared inside the window.
#
# An existing object with IDENTICAL bytes is re-published rather than skipped. The
# overwrite is provably a no-op on content, and skipping would make the run log and
# the publication order depend on remote state, which is harder to reason about
# than an unconditional PUT of the same bytes.
# ---------------------------------------------------------------------------
publish() {  # <local_file> <key> <sha256>
  local file="$1" key="$2" sha="$3"
  local size probe probe_size rc got hash_rc

  # M31.10 (H-3): the size is captured here, together with the digest, and both
  # travel into the registry as one reference. See the registry note above.
  #
  # M31.13 (H-11): the measurement is guarded. Unguarded, a local file that became
  # unreadable at this point aborted the script under `set -e` with status 1 and NO
  # diagnostic — after earlier objects had already been published, so the run both
  # lied (1 means "nothing was published") and hid the cause. The size is measured
  # before this object's PUT but AFTER the previous ones, so the honest code is 76;
  # 1 is kept only for a rehearsal, where nothing is ever published.
  if ! size="$(wc -c < "$file" | tr -d ' \r\n')"; then
    if ((DRY_RUN)); then
      fail "the local artefact could not be measured: $file (nothing was published: this is a rehearsal)"
    fi
    fail_remote "the local artefact could not be measured: $file" \
      "the size of the local file could not be read before publishing it, and earlier objects of this run may already be stored"
  fi
  register_expected "$key" "$file" "$sha" "$size"

  if ((DRY_RUN)); then
    echo "dry-run: would upload $file -> s3://$BUCKET/$key"
    return 0
  fi

  rc=0
  probe="$(remote_head "$key")" || rc=$?
  if ((rc == 0)); then
    probe_size="$(printf '%s' "$probe" | tr -d ' \r\n')"
    if [[ "$probe_size" != "$size" ]]; then
      fail_remote "REFUSING to overwrite a divergent object: $key" \
        "the stored object is $probe_size bytes and the local file is $size bytes"
    fi
    rm_scratch "$VERIFY_TMP/probe"
    if ! remote_get "$key" "$VERIFY_TMP/probe"; then
      fail_remote "REFUSING to overwrite an object that could not be read: $key" \
        "the stored object exists ($probe_size bytes) but its content could not be read back for comparison"
    fi
    # M31.10 (H-4): a failing hashing tool must not be reported as divergence. The
    # empty output of a failed substitution is not evidence that the bytes differ,
    # and naming the wrong cause sends the operator after the wrong problem.
    got=""; hash_rc=0
    got="$(sha256_of "$VERIFY_TMP/probe")" || hash_rc=$?
    if ((hash_rc != 0)); then
      fail_remote "REFUSING to overwrite an object whose content could not be hashed: $key" \
        "the stored object was downloaded but the local SHA-256 tool failed (exit $hash_rc)"
    fi
    if [[ "$got" != "$sha" ]]; then
      fail_remote "REFUSING to overwrite a divergent object: $key" \
        "the stored object has the same size but different bytes than the local file"
    fi
    IDENTICAL=$((IDENTICAL + 1))
    echo "offhost: $key already stores this exact content (checked, not a blind overwrite)"
    rm_scratch "$VERIFY_TMP/probe"
  elif ((rc == 3)); then
    : # definitively absent: publishing is safe
  else
    fail_remote "REFUSING to publish over an object whose state is unknown: $key" \
      "the existence probe failed with status $rc, and an undetermined probe is not an absent object"
  fi

  upload_file "$file" "$key" "$sha"
}

upload_file() {
  local file="$1" key="$2" sha="$3"

  if ((DRY_RUN)); then
    echo "dry-run: would upload $file -> s3://$BUCKET/$key"
    return 0
  fi

  # Retry the whole object, not the request: an interrupted body leaves a
  # partial object, and resuming would require tracking the upload id, state the
  # backup script does not keep across a failure. Re-uploading the whole object
  # is idempotent because the key is derived from a unique run base.
  #
  # The third argument stays empty on purpose: it is the Object Lock retain-until
  # slot, which this client deliberately does not fill (see the transport note
  # above). The digest travels as the fourth argument so the metadata option (C4)
  # can use it without the caller having to hash the file a second time.
  if retry_with_backoff "$RETRIES" "$RETRY_DELAY" transport "$file" "$key" "" "$sha"; then
    echo "offhost: uploaded $key"
    return 0
  fi

  echo "offhost: FAILED to upload $key after $RETRIES attempt(s)" >&2
  # The local copy is deliberately left untouched. Removing it because the
  # upload failed would turn a network problem into data loss, which is the
  # exact failure this milestone exists to prevent.
  echo "offhost: the local backup is intact and will be retried on the next run" >&2

  # M29.2 A2: se alerta en el punto exacto donde nace el 76. emit_alert devuelve
  # siempre 0, asi que bajo `set -e` no aborta aqui ni convierte este fallo en
  # exito: la linea siguiente sigue siendo la que fijara el codigo de salida.
  emit_alert "partial_upload_failed" "$EXIT_UPLOAD_FAILED" "$ALERT_TIMESTAMP"
  return "$EXIT_UPLOAD_FAILED"
}

# ---------------------------------------------------------------------------
# M31.8 (C2) — read-back verification of every expected object.
#
# All objects are inspected and the failures are accumulated instead of aborting
# on the first one: the point of the phase is to report the true remote state of
# the set, and a single diagnostic per run would hide the rest of it.
#
# A missing object, an unreadable object, a size that differs and a digest that
# differs are all verification failures, and all of them mean the same thing to
# the operator: the copy is NOT verified. The ETag is never used as a digest: for
# a multipart upload it is not even an MD5 of the whole object, and no
# S3-compatible service promises a SHA-256 there.
# ---------------------------------------------------------------------------
VERIFIED=0
VERIFY_FAILS=0
verify_remote() {
  local i key file want want_bytes probe probe_size rc got hash_rc
  VERIFIED=0
  VERIFY_FAILS=0

  # M31.10 (H-2): an empty registry must never be read as "nothing failed". Without
  # this guard the loop below would not run, VERIFY_FAILS would stay 0 and the
  # summary would claim remote_verified=yes having verified nothing. The check is
  # explicit on purpose: relying on `set -u` aborting an empty-array expansion is
  # version-dependent, and a silent success is worse than a hard failure.
  if ((${#EXPECT_KEYS[@]} == 0)); then
    printf 'offhost: VERIFY FAILED: no expected objects were registered; refusing to report a verified remote\n' >&2
    VERIFY_FAILS=1
    return 1
  fi

  for i in "${!EXPECT_KEYS[@]}"; do
    key="${EXPECT_KEYS[$i]}"
    file="${EXPECT_FILES[$i]}"
    want="${EXPECT_SHA[$i]}"
    # M31.10 (H-3): the size comes from the registry, captured before the PUT, so it
    # describes the same bytes as the digest. Re-reading it here would compare the
    # stored object against a reference assembled from two different moments.
    want_bytes="${EXPECT_BYTES[$i]}"

    rc=0
    probe="$(remote_head "$key")" || rc=$?
    if ((rc != 0)); then
      printf 'offhost: VERIFY FAILED %s: the stored size could not be read (probe exit %s)\n' "$key" "$rc" >&2
      VERIFY_FAILS=$((VERIFY_FAILS + 1))
      continue
    fi
    probe_size="$(printf '%s' "$probe" | tr -d ' \r\n')"
    if [[ "$probe_size" != "$want_bytes" ]]; then
      printf 'offhost: VERIFY FAILED %s: stored size %s does not match the size recorded for %s before publishing (%s)\n' \
        "$key" "$probe_size" "$file" "$want_bytes" >&2
      VERIFY_FAILS=$((VERIFY_FAILS + 1))
      continue
    fi

    rm_scratch "$VERIFY_TMP/verify"
    if ! remote_get "$key" "$VERIFY_TMP/verify"; then
      printf 'offhost: VERIFY FAILED %s: the stored object could not be downloaded\n' "$key" >&2
      VERIFY_FAILS=$((VERIFY_FAILS + 1))
      continue
    fi
    # M31.10 (H-4): a failing hashing tool is a verification failure with its own
    # cause, not a digest mismatch. Counting it as a failure keeps the run honest
    # (76) without pretending the bytes differ.
    got=""; hash_rc=0
    got="$(sha256_of "$VERIFY_TMP/verify")" || hash_rc=$?
    rm_scratch "$VERIFY_TMP/verify"
    if ((hash_rc != 0)); then
      printf 'offhost: VERIFY FAILED %s: the downloaded bytes could not be hashed (local SHA-256 tool exit %s)\n' "$key" "$hash_rc" >&2
      VERIFY_FAILS=$((VERIFY_FAILS + 1))
      continue
    fi
    if [[ "$got" != "$want" ]]; then
      printf 'offhost: VERIFY FAILED %s: stored sha256 %s does not match the local sha256 %s\n' "$key" "$got" "$want" >&2
      VERIFY_FAILS=$((VERIFY_FAILS + 1))
      continue
    fi
    VERIFIED=$((VERIFIED + 1))
  done

  ((VERIFY_FAILS == 0))
}

# The logical set publishes the digests C1 already validated; only the manifest
# (which carries no digest of itself) is hashed here.
upload_one() {  # <kind>
  local kind="$1" file key sha
  file="$(file_for "$kind")"
  key="$(key_for "$kind")"
  case "$kind" in
    dump)      sha="$DUMP_SHA" ;;
    roles.sql) sha="$ROLES_SHA" ;;
    # M31.10 (H-4): this runs after the dump and the roles export have already been
    # published, so a hashing failure here is a remote-path failure (76), not the
    # configuration error that "published nothing" (1). The object is not published
    # without its digest: the failure happens before its PUT.
    *)         sha="$(sha256_of "$file")" \
                 || fail_remote "the local artefact could not be hashed: $file" \
                   "the SHA-256 tool failed before publishing this object" ;;
  esac
  publish "$file" "$key" "$sha"
}

# The temporary directory is created once, and only when something will really be
# read back. make_temp_dir (common.sh) is used rather than `mktemp -d`: on the
# MSYS/Git Bash shell this repository is developed against, `$(mktemp -d)` can come
# back empty, and an empty path would turn every read-back into a write to "/".
VERIFY_TMP=""
# M31.15 (A3): the EXIT trap must not be able to change the outcome of the run.
# Under `set -e` a failing command INSIDE the trap replaces the exit status
# (verified on bash 5.2: with `set -Eeuo pipefail`, `trap f EXIT; exit 76` where f
# fails exits 1; without `set -e` the 76 survives, which is why the earlier audit
# got this wrong). A scratch directory that cannot be removed would therefore turn a
# verified upload (0) into a local failure (1). The removal is best-effort: a
# leftover file inside our own private temp directory is not worth misreporting the
# result of the run, and the `|| true` keeps even a failing diagnostic from
# reintroducing the same abort.
cleanup_verify_tmp() {
  [[ -n "${VERIFY_TMP:-}" ]] || return 0
  if ! rm -rf "$VERIFY_TMP"; then
    printf 'offhost: warning: the scratch directory %s could not be removed\n' "$VERIFY_TMP" >&2 || true
  fi
}
if ((!DRY_RUN)); then
  # M31.10 (H-4): dependencies are resolved BEFORE the first PUT, so exit 1 keeps
  # meaning "nothing was published". A dependency that disappears later exits 76.
  check_dependencies
  VERIFY_TMP="$(make_temp_dir)" || fail "could not create a temporary directory for read-back verification"
  trap cleanup_verify_tmp EXIT
fi

echo "offhost: publishing $base to s3://$BUCKET/backups/$PREFIX/"
for kind in "${UPLOAD_ORDER[@]}"; do
  upload_one "$kind"
done

# --- physical set + WAL chain (M31.4 / F-P6) --------------------------------
# Members first, then the auxiliary artefacts, then the segments, and the chain
# manifest LAST: it is the commit record for the physical set, exactly like the
# logical manifest is for the dump. A consumer that finds the chain can trust
# that every component it references was uploaded before it.
#
# M31.8: each member is published with the digest it was already verified against
# (PHYS_*_SHA), so the divergence guard and the read-back do not hash a base tar
# that has already been hashed.
if [[ -n "$PHYS_SET" ]]; then
  phys_key() { printf 'backups/%s/physical/%s/%s' "$PREFIX" "$PHYS_SET_ID" "$1"; }
  echo "offhost: publishing physical set $PHYS_SET_ID (members=${#PHYS_MEMBERS[@]} segments=${#PHYS_SEGMENTS[@]} aux=${#PHYS_AUX[@]})"
  for i in "${!PHYS_MEMBERS[@]}"; do
    f="${PHYS_MEMBERS[$i]}"
    publish "$PHYS_DIR/$f" "$(phys_key "$f")" "${PHYS_MEMBER_SHA[$i]}"
  done
  for i in "${!PHYS_AUX[@]}"; do
    a="${PHYS_AUX[$i]}"
    publish "$PHYS_WALDIR_ABS/$a" "$(phys_key "wal/$a")" "${PHYS_AUX_SHA[$i]}"
  done
  for i in "${!PHYS_SEGMENTS[@]}"; do
    sg="${PHYS_SEGMENTS[$i]}"
    publish "$PHYS_WALDIR_ABS/$sg" "$(phys_key "wal/$sg")" "${PHYS_SEG_SHA[$i]}"
  done
  # M31.10 (H-4): the commit record is the last object, and a hashing failure here
  # happens after everything else was published: 76, not the 1 that would claim
  # nothing was published.
  chain_sha="$(sha256_of "$PHYS_CHAIN")" \
    || fail_remote "the WAL chain manifest could not be hashed: $PHYS_CHAIN" \
      "the SHA-256 tool failed before publishing the commit record"
  publish "$PHYS_CHAIN" "$(phys_key "$PHYS_SET_ID.walchain")" "$chain_sha"
fi

if ((DRY_RUN)); then
  echo "offhost=dry-run bucket=$BUCKET prefix=$PREFIX base=$base physical=${PHYS_SET_ID:-none} remote_verified=no"
else
  # H-05 (M31.6) + M31.8 (C2): the summary states what was actually established.
  # 'uploaded' means the transport accepted every PUT. remote_verified=yes is only
  # emitted after every expected object was read back and matched its local file.
  # It still says NOTHING about durability, versioning, Object Lock or lifecycle.
  if verify_remote; then
    echo "offhost: NOTE every remote object was read back and its SHA-256 matches the local file; durability, Object Lock and lifecycle are NOT verified here (F-P7)" >&2
    echo "offhost=uploaded bucket=$BUCKET prefix=$PREFIX base=$base objects=${#UPLOAD_ORDER[@]} physical=${PHYS_SET_ID:-none} transport=$([[ -n "${OFFHOST_S3_CMD:-}" ]] && echo simulated || echo aws) verified=$VERIFIED/${#EXPECT_KEYS[@]} identical=$IDENTICAL remote_verified=yes"
  else
    echo "offhost: FAILED remote verification for $VERIFY_FAILS of ${#EXPECT_KEYS[@]} object(s); the local backup is intact and will be retried on the next run" >&2
    echo "offhost: the remote objects were NOT verified; do not read the next line as remote integrity" >&2
    emit_alert "partial_upload_failed" "$EXIT_UPLOAD_FAILED" "$ALERT_TIMESTAMP"
    echo "offhost=uploaded bucket=$BUCKET prefix=$PREFIX base=$base objects=${#UPLOAD_ORDER[@]} physical=${PHYS_SET_ID:-none} transport=$([[ -n "${OFFHOST_S3_CMD:-}" ]] && echo simulated || echo aws) verified=$VERIFIED/${#EXPECT_KEYS[@]} identical=$IDENTICAL remote_verified=no"
    exit "$EXIT_UPLOAD_FAILED"
  fi
fi
