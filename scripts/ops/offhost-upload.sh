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

Publishes one backup set to S3-compatible object storage in the order
dump -> roles.sql -> manifest. The manifest goes last and is the commit record.

Required environment:
  BACKUP_BUCKET                        target bucket
  B2_S3_ENDPOINT                       e.g. https://s3.<region>-<NNN>.backblazeb2.com
  B2_S3_REGION                         signing region
  B2_WRITE_KEY_ID, B2_WRITE_SECRET_KEY

Optional:
  BACKUP_PREFIX                        environment prefix (default: prod)
  OFFHOST_UPLOAD_RETRIES               attempts per object (default: 3)
  OFFHOST_UPLOAD_RETRY_DELAY_SECONDS   delay between attempts (default: 5)
  OFFHOST_S3_CMD                       transport override (tests); the default
                                       invokes `aws s3api` with --endpoint-url

Exit codes:
  0   all three objects uploaded
  1   invalid configuration or missing input
  76  local backup fine, upload failed (the local copy is kept)
EOF
}

fail() { echo "offhost: $*" >&2; exit 1; }

BACKUP_FILE=""
ROLES_FILE=""
MANIFEST_FILE=""
DRY_RUN=0

while (($#)); do
  case "$1" in
    --backup)   [[ $# -ge 2 ]] || fail "--backup needs a file"; BACKUP_FILE="$2"; shift 2 ;;
    --roles)    [[ $# -ge 2 ]] || fail "--roles needs a file"; ROLES_FILE="$2"; shift 2 ;;
    --manifest) [[ $# -ge 2 ]] || fail "--manifest needs a file"; MANIFEST_FILE="$2"; shift 2 ;;
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


# Default transport: one `aws s3api put-object` per artefact.
#
# `s3api put-object` is used rather than `s3 cp` because Object Lock is applied
# per request with --object-lock-mode/--object-lock-retain-until-date, and only
# the api-level call exposes them. M26.0 does not set those flags: retention is
# applied by the bucket default once the account exists, so this client does
# not need to know the retention days. That is deliberate — a hardcoded
# retain-until date in the client would outlive any change to that policy.
aws_transport() {
  local file="$1" key="$2" retain_until="${3:-}"
  local -a args=(s3api put-object --bucket "$BUCKET" --key "$key" --body "$file" --endpoint-url "$ENDPOINT")
  # A missing --region would make the CLI sign with a default region, and B2
  # answers that with SignatureDoesNotMatch rather than a usable error, so an
  # absent region is surfaced here instead.
  if [[ -n "$REGION" ]]; then args+=(--region "$REGION"); fi
  if [[ -n "$retain_until" ]]; then
    args+=(--object-lock-mode GOVERNANCE --object-lock-retain-until-date "$retain_until")
  fi
  aws "${args[@]}"
}

transport() {
  local file="$1" key="$2" retain_until="${3:-}"
  if [[ -n "${OFFHOST_S3_CMD:-}" ]]; then
    "$OFFHOST_S3_CMD" "$file" "$key" "$retain_until"
  else
    command -v aws >/dev/null 2>&1 || fail "aws CLI is required for the off-host upload (or set OFFHOST_S3_CMD)"
    aws_transport "$file" "$key" "$retain_until"
  fi
}

upload_one() {
  local kind="$1" file key
  file="$(file_for "$kind")"
  key="$(key_for "$kind")"

  if ((DRY_RUN)); then
    echo "dry-run: would upload $file -> s3://$BUCKET/$key"
    return 0
  fi

  # Retry the whole object, not the request: an interrupted body leaves a
  # partial object, and resuming would require tracking the upload id, state the
  # backup script does not keep across a failure. Re-uploading the whole object
  # is idempotent because the key is derived from a unique run base.
  if retry_with_backoff "$RETRIES" "$RETRY_DELAY" transport "$file" "$key"; then
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

echo "offhost: publishing $base to s3://$BUCKET/backups/$PREFIX/"
for kind in "${UPLOAD_ORDER[@]}"; do
  upload_one "$kind"
done

if ((DRY_RUN)); then
  echo "offhost=dry-run bucket=$BUCKET prefix=$PREFIX base=$base"
else
  echo "offhost=ok bucket=$BUCKET prefix=$PREFIX base=$base objects=${#UPLOAD_ORDER[@]}"
fi
