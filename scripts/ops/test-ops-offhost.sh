#!/usr/bin/env bash
# M26.0 - Tests for the off-host upload client.
#
# Exercises the real scripts/ops/offhost-upload.sh against a local double via
# OFFHOST_S3_CMD, so the whole contract is verified with no network, no
# credentials, no bucket and no aws CLI. The B2 account cannot be created until
# the production VPS location is known, and a client that is only testable
# against production infrastructure is a client that ships untested.
#
# RETRY_SLEEP_HOOK replaces the real sleep, so the retry assertions cost zero
# wall-clock time while the delays stay observable: they are recorded, not
# skipped.
#
# Run: bash scripts/ops/test-ops-offhost.sh
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UPLOADER="$ROOT_DIR/scripts/ops/offhost-upload.sh"

PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (esperado '$3', obtenido '$2')"; fi; }

echo "M26.0 offhost-upload tests"

# --- fixture: a realistic backup set ---------------------------------------
SET="$WORK/m24-postgres-20260926T001718Z-abc123"
mkdir -p "$SET"
printf 'dump-payload' > "$SET/m24-postgres-20260926T001718Z-abc123.dump"
printf 'roles-payload' > "$SET/m24-postgres-20260926T001718Z-abc123.roles.sql"
DUMP="$SET/m24-postgres-20260926T001718Z-abc123.dump"
ROLES="$SET/m24-postgres-20260926T001718Z-abc123.roles.sql"
MANIFEST="$SET/m24-postgres-20260926T001718Z-abc123.manifest"

# The manifest must describe the files it travels with. M31.8 (C1) compares
# dump_sha256/roles_sha256 against the local bytes before the first PUT, so a
# fixture carrying a fake digest ("deadbeef") would only ever exercise the
# refusal path and the happy path would be untested. The digests are computed
# here the same way postgres-backup.sh writes them: sha256sum over stdin, so the
# path spelling never reaches the tool.
sha_of_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum < "$1" | awk '{print $1}'
  else
    shasum -a 256 < "$1" | awk '{print $1}'
  fi
}
write_manifest() {  # <manifest> <dump> <roles>
  printf 'format=pg_dump-custom\ndump_sha256=%s\nroles_sha256=%s\n' \
    "$(sha_of_file "$2")" "$(sha_of_file "$3")" > "$1"
}
write_manifest "$MANIFEST" "$DUMP" "$ROLES"
DUMP_SHA_FIX="$(sha_of_file "$DUMP")"

# A recording transport: three scripts (PUT, HEAD, GET) sharing a store and a log,
# each able to be told to fail. Three scripts rather than one dispatcher because
# the client talks to three separate seams, and a test that cannot tell a read
# from a write cannot prove that a refusal happened BEFORE the write.
#
# Log format, one record per call:
#   PUT|<key>|<sha256>   a PUT attempt, including retries and failures
#   HEAD|<key>           an existence/size probe
#   GET|<key>            a content read
# The prefix is what lets the assertions count real writes: a retry is a second
# PUT, a probe is not.
#
# Write-side failure modes (unchanged from M26.0):
#   DOUBLE_FAIL_MODE=once     -> fails the first matching PUT, then succeeds.
#                                Models a transient network fault: the retry must
#                                recover and the run must finish 0.
#   DOUBLE_FAIL_MODE=always   -> fails every matching PUT. Models a persistent
#                                fault: the run must exhaust its attempts and
#                                finish 76. Without this mode a "persistent
#                                failure" test silently passed on the first
#                                retry and never exercised the give-up path.
# The marker records that a "once" failure already happened, so a second call in
# the same run succeeds.
#
# Read-side modes (M31.8), applied to the key matching DOUBLE_READ_ON:
#   DOUBLE_HEAD_MODE=wrong-size -> reports one byte more than is stored
#   DOUBLE_HEAD_MODE=read-error -> fails the probe with a status that is NOT the
#                                  "absent" status, which the client must not
#                                  read as "safe to overwrite"
#   DOUBLE_HEAD_MODE=blind      -> reports "absent" for an object that exists:
#                                  this is the race the guard cannot close
#   DOUBLE_GET_MODE=corrupt     -> returns the stored bytes with one byte changed
#                                  (same size, different content)
#   DOUBLE_GET_MODE=read-error  -> fails the read
CALLS="$WORK/calls.log"
STORE="$WORK/store"
COUNTERS="$WORK/counters"
# The counters are per-key call counts for the read probes. They are reset with
# the store so a test never inherits the call history of the previous one.
reset_counters() { rm -rf "$COUNTERS"; mkdir -p "$COUNTERS"; }
reset_store() { rm -rf "$STORE"; mkdir -p "$STORE"; reset_counters; }
reset_store
cat > "$WORK/put.sh" <<'PUT'
#!/usr/bin/env bash
# put.sh <file> <key> [retain_until] [sha256]
printf 'PUT|%s|%s\n' "$2" "${4:-}" >> "$CALLS"
if [[ -n "${DOUBLE_FAIL_ON:-}" && "$2" == *"${DOUBLE_FAIL_ON}"* ]]; then
  case "${DOUBLE_FAIL_MODE:-once}" in
    always)
      echo "double: simulated persistent failure for $2" >&2
      exit 1
      ;;
    once)
      if [[ -f "${DOUBLE_FAIL_MARKER:-/nonexistent}" ]]; then exit 0; fi
      : > "${DOUBLE_FAIL_MARKER:-/nonexistent}"
      echo "double: simulated transient failure for $2" >&2
      exit 1
      ;;
  esac
fi
mkdir -p "$STORE/$(dirname "$2")"
cp -f "$1" "$STORE/$2"
# M31.10 (H-3): simulate another process modifying the LOCAL backup between the PUT
# and the read-back. The mutation happens inside the run, which is the only way to
# place it in that window without a second process racing the test. It runs AFTER the
# copy, so the stored object keeps the bytes that were published.
if [[ -n "${DOUBLE_MUTATE_ON:-}" && "$2" == *"${DOUBLE_MUTATE_ON}"* ]]; then
  printf '%s' "${DOUBLE_MUTATE_TO:-}" > "$1"
fi
PUT
chmod +x "$WORK/put.sh"

cat > "$WORK/head.sh" <<'HEAD'
#!/usr/bin/env bash
# head.sh <key> -> size on stdout; 0 exists / 3 absent / 1 undetermined
printf 'HEAD|%s\n' "$1" >> "$CALLS"
# Per-key call counter. The pre-check probe and the read-back probe are the same
# operation to the client but different calls here, and several failure modes only
# make sense on the second one: an object that is present when the guard looks and
# gone when the read-back looks is not the same incident as an object that was
# never there. DOUBLE_HEAD_AFTER=<n> applies the mode from the nth call on.
n=0
if [[ -n "${COUNTERS:-}" ]]; then
  c="$COUNTERS/head.$(printf '%s' "$1" | tr '/' '_')"
  if [[ -f "$c" ]]; then n="$(cat "$c")"; fi
  n=$((n + 1))
  printf '%s' "$n" > "$c"
fi
apply=1
if [[ -n "${DOUBLE_HEAD_AFTER:-}" ]] && ((n < DOUBLE_HEAD_AFTER)); then apply=0; fi
if ((apply)) && [[ -n "${DOUBLE_READ_ON:-}" && "$1" == *"${DOUBLE_READ_ON}"* ]]; then
  case "${DOUBLE_HEAD_MODE:-}" in
    read-error)
      echo "double: simulated head failure for $1" >&2
      exit 1
      ;;
    blind)
      # The object is there and the probe says it is not. Models the race the
      # guard cannot close: a reader that trusts this answer overwrites.
      exit 3
      ;;
    wrong-size)
      if [[ -f "$STORE/$1" ]]; then
        printf '%s' "$(( $(wc -c < "$STORE/$1" | tr -d ' \r\n') + 1 ))"
        exit 0
      fi
      exit 3
      ;;
  esac
fi
if [[ -f "$STORE/$1" ]]; then
  printf '%s' "$(wc -c < "$STORE/$1" | tr -d ' \r\n')"
  exit 0
fi
exit 3
HEAD
chmod +x "$WORK/head.sh"

cat > "$WORK/get.sh" <<'GET'
#!/usr/bin/env bash
# get.sh <key> <dest>
printf 'GET|%s\n' "$1" >> "$CALLS"
if [[ ! -f "$STORE/$1" ]]; then
  echo "double: no such object: $1" >&2
  exit 3
fi
if [[ -n "${DOUBLE_READ_ON:-}" && "$1" == *"${DOUBLE_READ_ON}"* ]]; then
  case "${DOUBLE_GET_MODE:-}" in
    read-error)
      echo "double: simulated get failure for $1" >&2
      exit 1
      ;;
    corrupt)
      # Same size, different bytes: the size check passes and only the digest
      # comparison can catch it, which is exactly what the reference check is for.
      cp -f "$STORE/$1" "$2"
      printf 'X' | dd of="$2" bs=1 seek=0 conv=notrunc status=none
      exit 0
      ;;
  esac
fi
cp -f "$STORE/$1" "$2"
GET
chmod +x "$WORK/get.sh"

# A `sha256sum` that can be told to start failing from the Nth call on.
#
# M31.10 (H-4): the hashing failures that matter happen while or after objects are
# published, so the test has to let the real tool work through C1 and then break. The
# call counter is a file because the state has to survive across the many short-lived
# processes one run spawns.
SHA_COUNT_FILE="$WORK/sha-count"
REAL_SHA256SUM="$(command -v sha256sum || true)"
mkdir -p "$WORK/binsha"
cat > "$WORK/binsha/sha256sum" <<SHA
#!/usr/bin/env bash
n=0
if [[ -f "$SHA_COUNT_FILE" ]]; then n="\$(cat "$SHA_COUNT_FILE")"; fi
n=\$((n + 1))
printf '%s' "\$n" > "$SHA_COUNT_FILE"
if ((\${SHA_FAIL_FROM:-999999} <= n)); then
  echo "sha256sum: simulated failure on call \$n" >&2
  exit 1
fi
exec "$REAL_SHA256SUM" "\$@"
SHA
chmod +x "$WORK/binsha/sha256sum"
reset_sha_counter() { printf '0' > "$SHA_COUNT_FILE"; }
reset_sha_counter

# A `wc` that can be told to fail on a specific artefact, deterministically.
#
# M31.13 (H-11): the defect was an unguarded `wc -c` inside publish(), so the test
# has to make the MEASUREMENT fail while the real tool keeps working everywhere
# else. It fails on the bytes it receives, not on a file name or a permission: no
# user file is touched, nothing depends on the OS, and the case cannot pass by
# accident on a machine where the artefact happens to be unreadable.
#
# The bytes are spooled to a file before being handed to the real wc. Reading them
# through `$(cat)` would strip a trailing newline and report a size one byte short,
# which would corrupt the very size contract under test.
#
# It stays inert unless the marker is present, so it can sit on PATH for a whole run
# without changing the behaviour of any other case.
REAL_WC="$(command -v wc || true)"
WC_SPOOL="$WORK/wc-spool"
mkdir -p "$WORK/binwc"
cat > "$WORK/binwc/wc" <<WC
#!/usr/bin/env bash
if [[ -n "\${1:-}" && "\${1:0:1}" != "-" ]]; then exec "$REAL_WC" "\$@"; fi
cat > "$WC_SPOOL"
if grep -qF 'H11_MEASURE_FAIL' "$WC_SPOOL"; then
  echo "wc: simulated measurement failure" >&2
  rm -f "$WC_SPOOL"
  exit 1
fi
"$REAL_WC" "\$@" < "$WC_SPOOL"
rc=\$?
rm -f "$WC_SPOOL"
exit \$rc
WC
chmod +x "$WORK/binwc/wc"

# An `rm` that fails for the client's own scratch directory, deterministically.
#
# M31.15 (A3): the guard under test protects a RECOVERABLE failure of the cleanup
# inside the publish/read-back path. The failure is aimed by path: the client's
# scratch directory carries the `privaris-ops.` prefix produced by make_temp_dir, so
# no user file is touched, nothing depends on OS permissions or on being root, and
# the case cannot pass by accident on a host where the directory happens to be
# unwritable. The test's own `rm` calls are unaffected: PATH_PREPEND only reaches the
# client's environment.
REAL_RM="$(command -v rm || true)"
mkdir -p "$WORK/binrm"
cat > "$WORK/binrm/rm" <<RM
#!/usr/bin/env bash
for arg in "\$@"; do
  case "\$arg" in *privaris-ops.*)
    echo "rm: simulated failure: cannot remove '\$arg'" >&2
    exit 1
    ;;
  esac
done
exec "$REAL_RM" "\$@"
RM
chmod +x "$WORK/binrm/rm"

# A fake `aws` CLI on PATH.
#
# The OFFHOST_S3_* seams REPLACE the transport, so they cannot show what the real
# client would have sent to the service: the argument construction (--region,
# --metadata, the Object Lock flags) lives inside aws_transport(), which the seams
# bypass. An executable named `aws` is what exercises that code path offline.
# It implements the three subcommands the client uses, against the same store, and
# records every command line verbatim.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/aws" <<'AWS'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$AWSLOG"
if [[ "${1:-}" != "s3api" ]]; then
  echo "fake aws: unsupported service: ${1:-<none>}" >&2
  exit 2
fi
shift
cmd="$1"; shift
key=""; body=""; dest=""
while (($#)); do
  case "$1" in
    --key) key="$2"; shift 2 ;;
    --body) body="$2"; shift 2 ;;
    --bucket|--endpoint-url|--region|--query|--output|--metadata)
      shift 2 ;;
    --object-lock-mode|--object-lock-retain-until-date)
      shift 2 ;;
    *) dest="$1"; shift ;;
  esac
done
# M31.11 (H-5): the mode knobs let a test put a warning on stderr, return a real CLI
# error, or return an ambiguous answer, so the client's stream handling can be
# exercised on the real argument path. AWS_MODE_ON restricts a mode to one key.
match_mode() { [[ -z "${AWS_MODE_ON:-}" || "$1" == *"${AWS_MODE_ON}"* ]]; }
case "$cmd" in
  put-object)
    mkdir -p "$STORE/$(dirname "$key")"
    cp -f "$body" "$STORE/$key"
    ;;
  head-object)
    # M31.15 (A2): a per-key HEAD counter, so a mode can be aimed at the READ-BACK
    # probe without touching the pre-check one. Without it a HEAD failure can only be
    # tested before the object is published, which is a different incident: here the
    # object was published by this very run and it is the verification that fails.
    # The counter is a file because every invocation is a separate process.
    apply=1
    if [[ -n "${AWS_HEAD_AFTER:-}" && -n "${AWS_COUNTERS:-}" ]]; then
      c="$AWS_COUNTERS/head.$(printf '%s' "$key" | tr '/' '_')"
      n=0
      if [[ -f "$c" ]]; then n="$(cat "$c")"; fi
      n=$((n + 1))
      printf '%s' "$n" > "$c"
      if ((n < AWS_HEAD_AFTER)); then apply=0; fi
    fi
    if ((apply)) && match_mode "$key"; then
      case "${AWS_HEAD_MODE:-}" in
        notfound)
          echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2
          exit 254
          ;;
        error)
          echo "An error occurred (500) when calling the HeadObject operation: InternalError" >&2
          exit 254
          ;;
        forbidden)
          # M31.13 (H-10): an authentication/permission failure. It must never be
          # read as an absent object.
          echo "An error occurred (403) when calling the HeadObject operation: Forbidden" >&2
          exit 254
          ;;
        misleading404)
          # M31.13 (H-10): a real 503 whose message happens to quote "404" in a
          # request id and in the endpoint URL. Nothing in the parenthesised slot
          # says 404, so this is NOT an absence: reading it as one would overwrite
          # whatever is stored under the key.
          echo "An error occurred (503) when calling the HeadObject operation: SlowDown (request id 0A1B-404-XY, endpoint https://s3.us-west-004.backblazeb2.com/404/objects)" >&2
          exit 254
          ;;
        contradictory)
          # M31.13 (H-10): a 404-shaped token AND a different explicit status in the
          # same message. The two contradict each other, so the probe stays
          # undetermined instead of becoming an unconditional overwrite.
          echo "An error occurred (404) when calling the HeadObject operation: Not Found; the retry after (503) SlowDown also failed" >&2
          exit 254
          ;;
        unreachable)
          # M31.13 (H-10): a connectivity failure. The real CLI exits 255 here, not
          # 254, and prints no status at all: neither the text nor the numeric code
          # may be read as an absence.
          echo 'Could not connect to the endpoint URL: "https://s3.test.invalid/404/"' >&2
          exit 255
          ;;
        ambiguous)
          # exit 0 with an answer that is not a size
          printf 'None'
          exit 0
          ;;
        warning)
          echo "warning: retrying with the fallback region" >&2
          ;;
      esac
    fi
    if [[ ! -f "$STORE/$key" ]]; then
      # The CLI reports a missing object as a 404-shaped error; the client maps
      # exactly that shape to "absent" and nothing else.
      #
      # M31.15 (A1): the SHAPE of that error is selectable, because the slot the
      # client accepts carries either the HTTP status (a 404 with no parseable body)
      # or the service code. It is selectable HERE, on the real absence path, and not
      # as a blanket HEAD mode: a blanket mode also hits the read-back probe of an
      # object that was just published, which is a different incident and would make
      # the case pass or fail for the wrong reason.
      case "${AWS_ABSENT_SHAPE:-404}" in
        nosuchkey)
          echo "An error occurred (NoSuchKey) when calling the HeadObject operation: The specified key does not exist." >&2
          ;;
        notfoundcode)
          echo "An error occurred (NotFound) when calling the HeadObject operation: Not Found" >&2
          ;;
        *)
          echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2
          ;;
      esac
      exit 254
    fi
    printf '%s' "$(wc -c < "$STORE/$key" | tr -d ' \r\n')"
    ;;
  get-object)
    if match_mode "$key"; then
      case "${AWS_GET_MODE:-}" in
        error)
          echo "An error occurred (500) when calling the GetObject operation: InternalError" >&2
          exit 254
          ;;
        warning)
          echo "warning: the download was retried once" >&2
          ;;
      esac
    fi
    if [[ ! -f "$STORE/$key" ]]; then
      echo "An error occurred (404) when calling the GetObject operation: Not Found" >&2
      exit 254
    fi
    cp -f "$STORE/$key" "$dest"
    ;;
  *)
    echo "fake aws: unsupported subcommand: $cmd" >&2
    exit 2
    ;;
esac
AWS
chmod +x "$WORK/bin/aws"

# Records sleeps instead of performing them.
cat > "$WORK/sleep.sh" <<'SLEEPER'
#!/usr/bin/env bash
printf 'sleep %s\n' "$1" >> "$SLEEP_LOG"
exit 0
SLEEPER
chmod +x "$WORK/sleep.sh"

export CALLS
export STORE
export COUNTERS
export SLEEP_LOG="$WORK/sleeps.log"

# The knobs are plain global variables rather than `VAR=x func` prefixes.
# A prefix assignment to a *function* call is only visible inside the function
# for variables the function actually reads, which made it impossible to set
# several knobs at once without one shadowing another. Globals with explicit
# defaults are unambiguous and let each test change one thing.
TB_VAR_NAME=""; TB_VAR_VALUE=""
TB_FAIL_ON=""; TB_FAIL_MARKER=""; TB_FAIL_MODE=""
TB_RETRIES=3; TB_DELAY=1
TB_BUCKET="b"; TB_ENDPOINT="https://x.invalid"
TB_DUMP="$DUMP"
TB_ALERT_CMD=""
# M31.8 read-side knobs: the key the mode applies to, and the mode itself.
TB_READ_ON=""; TB_HEAD_MODE=""; TB_GET_MODE=""
# DOUBLE_HEAD_AFTER: apply the HEAD mode from the nth probe of that key on, so a
# mode can be aimed at the read-back probe without touching the pre-check one.
TB_HEAD_AFTER=""
# M31.10 knobs: DOUBLE_MUTATE_ON/TO make the PUT double modify the LOCAL file after
# storing it (H-3), and PATH_PREPEND puts the failing sha256sum first (H-4).
TB_MUTATE_ON=""; TB_MUTATE_TO=""; TB_PATH_PREPEND=""
# M31.11 knobs: how the fake aws answers (H-5).
TB_AWS_HEAD_MODE=""; TB_AWS_GET_MODE=""; TB_AWS_MODE_ON=""
# M31.15 (A2) knob: apply the fake-aws HEAD mode from the nth HEAD of that key on,
# so a mode can be aimed at the read-back probe instead of the pre-check one. The
# per-key counters live in their own directory and are reset before every run.
TB_AWS_HEAD_AFTER=""
# M31.15 (A1) knob: which error shape the fake emits for a genuinely missing object
# (the real absence path), so each accepted rendering can be exercised independently.
TB_AWS_ABSENT_SHAPE=""
AWS_COUNTERS="$WORK/aws-counters"
mkdir -p "$AWS_COUNTERS"
reset_aws_counters() { rm -rf "$AWS_COUNTERS"; mkdir -p "$AWS_COUNTERS"; }

# Defined before the first use on purpose: bash resolves a function at call time,
# so a definition placed after the first call site silently becomes "command not
# found" (127) and every later assertion fails for the wrong reason.
#
# The exit status is captured from an `if` rather than from `$?` after an
# assignment: in this shell an assignment followed by `status=$?` yields an empty
# value, which made a genuinely failing upload report success. The `if` form is
# unambiguous. `env` is used for the variables under test so an explicit EMPTY
# value survives: `NAME=value cmd` cannot express "set to empty", because the
# client would silently fall back to its default instead of being tested.
# The variable under test must WIN over the defaults above. When TB_VAR_NAME is
# set it is appended LAST, because `env` resolves a name given twice as
# last-wins. Passing it first let the default OFFHOST_UPLOAD_RETRIES=3 override
# an explicit "0", so the guard under test never actually ran and the case
# reported the default behaviour instead.
run_capture() {
  local __out
  if __out="$(env ${TB_FAIL_ON:+DOUBLE_FAIL_ON="$TB_FAIL_ON"} \
      ${TB_FAIL_MARKER:+DOUBLE_FAIL_MARKER="$TB_FAIL_MARKER"} \
      ${TB_FAIL_MODE:+DOUBLE_FAIL_MODE="$TB_FAIL_MODE"} \
      ${TB_READ_ON:+DOUBLE_READ_ON="$TB_READ_ON"} \
      ${TB_HEAD_MODE:+DOUBLE_HEAD_MODE="$TB_HEAD_MODE"} \
      ${TB_GET_MODE:+DOUBLE_GET_MODE="$TB_GET_MODE"} \
      ${TB_HEAD_AFTER:+DOUBLE_HEAD_AFTER="$TB_HEAD_AFTER"} \
      ${TB_MUTATE_ON:+DOUBLE_MUTATE_ON="$TB_MUTATE_ON"} \
      ${TB_MUTATE_TO:+DOUBLE_MUTATE_TO="$TB_MUTATE_TO"} \
      ${TB_PATH_PREPEND:+PATH="$TB_PATH_PREPEND:$PATH"} \
      OFFHOST_S3_CMD="$WORK/put.sh" \
      OFFHOST_S3_HEAD_CMD="$WORK/head.sh" \
      OFFHOST_S3_GET_CMD="$WORK/get.sh" \
      RETRY_SLEEP_HOOK="$WORK/sleep.sh" \
      OFFHOST_UPLOAD_RETRIES="$TB_RETRIES" \
      OFFHOST_UPLOAD_RETRY_DELAY_SECONDS="$TB_DELAY" \
      BACKUP_BUCKET="$TB_BUCKET" \
      B2_S3_ENDPOINT="$TB_ENDPOINT" \
      ${TB_VAR_NAME:+"$TB_VAR_NAME=$TB_VAR_VALUE"} \
      ${TB_ALERT_CMD:+ALERT_CMD="$TB_ALERT_CMD"} \
      bash "$UPLOADER" --backup "$TB_DUMP" "$@" 2>&1)"; then
    RC=0
  else
    RC=$?
  fi
  OUT="$__out"
  # Reset the per-test knobs so the next case starts from a known state.
  TB_VAR_NAME=""; TB_VAR_VALUE=""
  TB_FAIL_ON=""; TB_FAIL_MARKER=""; TB_FAIL_MODE=""
  TB_READ_ON=""; TB_HEAD_MODE=""; TB_GET_MODE=""
  TB_HEAD_AFTER=""
  TB_MUTATE_ON=""; TB_MUTATE_TO=""; TB_PATH_PREPEND=""
  TB_AWS_HEAD_MODE=""; TB_AWS_GET_MODE=""; TB_AWS_MODE_ON=""
  TB_AWS_HEAD_AFTER=""; TB_AWS_ABSENT_SHAPE=""
  TB_RETRIES=3; TB_DELAY=1
  TB_BUCKET="b"; TB_ENDPOINT="https://x.invalid"
  TB_DUMP="$DUMP"
  TB_ALERT_CMD=""
}

# Only the PUT records, in order. M31.8 added HEAD/GET calls to the same log, so
# every assertion about "what was published and in what order" has to filter them
# out; an assertion that counted the whole log would now be counting probes.
puts() { grep '^PUT|' "$CALLS" 2>/dev/null || true; }
put_keys() { puts | sed 's/^PUT|//; s/|.*$//'; }
count_puts() { puts | grep -c . || true; }

# Runs the client through the fake `aws` CLI with NO transport seam, so the default
# aws_transport() path is the one that executes. Still offline: the fake never opens
# a socket, it only records the command line and moves bytes inside the store.
AWSLOG="$WORK/aws.log"
run_capture_aws() {
  local __out
  : > "$AWSLOG"
  reset_aws_counters
  if __out="$(env \
      PATH="${TB_PATH_PREPEND:+$TB_PATH_PREPEND:}$WORK/bin:$PATH" \
      STORE="$STORE" AWSLOG="$AWSLOG" \
      AWS_COUNTERS="$AWS_COUNTERS" \
      ${TB_AWS_HEAD_MODE:+AWS_HEAD_MODE="$TB_AWS_HEAD_MODE"} \
      ${TB_AWS_GET_MODE:+AWS_GET_MODE="$TB_AWS_GET_MODE"} \
      ${TB_AWS_MODE_ON:+AWS_MODE_ON="$TB_AWS_MODE_ON"} \
      ${TB_AWS_HEAD_AFTER:+AWS_HEAD_AFTER="$TB_AWS_HEAD_AFTER"} \
      ${TB_AWS_ABSENT_SHAPE:+AWS_ABSENT_SHAPE="$TB_AWS_ABSENT_SHAPE"} \
      ${TB_VAR_NAME:+"$TB_VAR_NAME=$TB_VAR_VALUE"} \
      BACKUP_BUCKET="privaris-postgres-backups" \
      B2_S3_ENDPOINT="https://s3.test.invalid" \
      B2_S3_REGION="test-region" \
      bash "$UPLOADER" --backup "$TB_DUMP" "$@" 2>&1)"; then
    RC=0
  else
    RC=$?
  fi
  OUT="$__out"
  # M31.11: the fake-aws knobs are per-run too, so a mode cannot leak into the next
  # case (the leak made a GET-error case inherit the previous HEAD-error case).
  TB_AWS_HEAD_MODE=""; TB_AWS_GET_MODE=""; TB_AWS_MODE_ON=""
  TB_AWS_HEAD_AFTER=""; TB_AWS_ABSENT_SHAPE=""
  TB_PATH_PREPEND=""
  TB_VAR_NAME=""; TB_VAR_VALUE=""
}

# Convenience wrapper for the happy path with the real bucket name.
run_upload() {
  : > "$CALLS"
  : > "$SLEEP_LOG"
  TB_BUCKET="privaris-postgres-backups" run_capture "$@"
}

# --- 1. orden obligatorio dump -> roles -> manifest -------------------------
run_upload
check "upload exitoso devuelve 0" "$RC" "0"
check "sube exactamente 3 objetos" "$(count_puts)" "3"
check "orden dump -> roles -> manifest" "$(put_keys | sed 's/.*\.\(dump\|roles\.sql\|manifest\)$/\1/' | tr '\n' ',')" "dump,roles.sql,manifest,"
# El manifest debe ser el ULTIMO objeto en existir: es el commit logico del set.
check "el manifest se sube el ultimo" "$(put_keys | tail -n1 | grep -c '\.manifest$')" "1"
check "el dump NO es el ultimo" "$(put_keys | tail -n1 | grep -c '\.dump$')" "0"
check "la clave usa el layout backups/<env>/<base>" \
  "$(put_keys | head -n1)" "backups/prod/m24-postgres-20260926T001718Z-abc123.dump"
# M31.8 (C2): the summary may only claim remote verification after the read-back.
check "el resumen declara remote_verified=yes" \
  "$(printf '%s' "$OUT" | grep -c '^offhost=uploaded .* remote_verified=yes')" "1"
check "el resumen declara 3/3 objetos verificados" \
  "$(printf '%s' "$OUT" | grep -c 'verified=3/3')" "1"
check "el resumen NO dice remote_verified=no cuando verifico" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=no')" "0"
check "la nota ya no dice que no se leyo el remoto" \
  "$(printf '%s' "$OUT" | grep -c 'were not read back')" "0"
check "la nota limita el alcance a durabilidad/Object Lock/lifecycle" \
  "$(printf '%s' "$OUT" | grep -c 'durability, Object Lock and lifecycle are NOT verified')" "1"

# --- 2. prefijo de entorno --------------------------------------------------
: > "$CALLS"
TB_VAR_NAME=BACKUP_PREFIX; TB_VAR_VALUE=drill
run_capture
check "BACKUP_PREFIX=drill usa backups/drill/" "$(put_keys | head -n1)" "backups/drill/m24-postgres-20260926T001718Z-abc123.dump"

# --- 3. codigo 76 y conservacion del backup local ---------------------------
# Persistent failure: EVERY attempt of the manifest must fail, so the run has to
# give up and report 76. The "once" mode would be recovered by the retry and
# would exit 0, so it cannot be used to test the give-up path.
: > "$CALLS"; : > "$SLEEP_LOG"
TB_FAIL_ON=".manifest"; TB_FAIL_MODE=always; TB_RETRIES=2; TB_DELAY=0
run_capture
check "upload fallido devuelve 76 (no 1)" "$RC" "76"
check "el backup local se conserva tras el fallo" "$([[ -f "$DUMP" ]] && echo yes)" "yes"
check "el cliente explica que el backup local sigue intacto" \
  "$(printf '%s' "$OUT" | grep -c 'local backup is intact')" "1"
# The double records ATTEMPTS, including the ones that failed, so the manifest
# key appears RETRIES times even though the object was never published. What
# makes the set unusable is that no manifest object exists at the end; the log
# cannot show that, and the client does not attempt a compensating delete of the
# half-published dump/roles, which is deliberate (see the ADR-003 note).
check "el manifest se intentó RETRIES veces y ninguna tuvo exito" \
  "$(put_keys | grep -c '\.manifest$')" "2"
check "el fallo no borra los objetos ya publicados" \
  "$(put_keys | grep -c '\.dump$')" "1"
check "un fallo de subida no declara verificacion remota" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"

# --- 4. reintentos ----------------------------------------------------------
: > "$CALLS"; : > "$SLEEP_LOG"
TB_FAIL_ON=".manifest"; TB_FAIL_MODE=always; TB_RETRIES=3; TB_DELAY=7
run_capture
check "fallo persistente tras 3 intentos devuelve 76" "$RC" "76"
# dump + roles = 2 llamadas, manifest = 3 intentos -> 5 llamadas en total.
check "reintenta el objeto fallido (2+3 llamadas)" "$(count_puts)" "5"
check "respeta el retardo configurado" "$(sort -u "$SLEEP_LOG" | tr -d ' ')" "sleep7"
# retry_with_backoff sleeps BETWEEN ATTEMPTS OF THE SAME OBJECT, not between
# different objects. With RETRIES=3 on the manifest that is exactly 2 sleeps, and
# none before its first attempt. The successful dump and roles do not sleep at
# all: they succeeded on the first try. A loop that also slept between objects
# would add latency to every healthy run for no reason.
check "duerme solo entre reintentos del mismo objeto" "$(wc -l < "$SLEEP_LOG" | tr -d ' ')" "2"
check "no duerme tras un objeto que tuvo exito" "$(sort -u "$SLEEP_LOG" | tr -d ' ')" "sleep7"
# The bound is real: a run that kept retrying would hang the scheduler forever.
check "no intenta un cuarto intento" "$(put_keys | grep -c '\.manifest$')" "3"

# --- 5. recuperacion tras un fallo transitorio ------------------------------
rm -f "$WORK/never.fail"
: > "$CALLS"; : > "$SLEEP_LOG"
TB_FAIL_ON=".roles.sql"; TB_FAIL_MARKER="$WORK/never.fail"; TB_RETRIES=3; TB_DELAY=1
run_capture
check "un fallo transitorio no aborta: devuelve 0" "$RC" "0"
check "sube los 3 objetos pese al fallo transitorio" "$(count_puts)" "4"
# El manifest sigue siendo el ultimo objeto aunque roles se haya reintentado.
check "el manifest sigue siendo el ultimo tras un reintento" "$(put_keys | tail -n1 | grep -c '\.manifest$')" "1"

# --- 6. idempotencia --------------------------------------------------------
# M31.8 (C3): the second run finds the same bytes already stored. The guard reads
# them, confirms they are identical, and re-publishes: the KEYS are the same, which
# is what "idempotent" means here, and the guard reports the state it found.
# A fresh store is used so the first run proves the "absent" path and the second
# proves the "identical" path; reusing the store from the earlier tests would make
# the first run an identical-path run too and hide the difference.
reset_store
run_upload
first_keys="$(put_keys)"
check "la primera ejecucion no encontro contenido identico" \
  "$(printf '%s' "$OUT" | grep -c 'identical=3')" "0"
run_upload
check "re-ejecutar produce las mismas claves (idempotente)" "$(put_keys)" "$first_keys"
check "la re-ejecucion reconoce los 3 objetos como identicos" \
  "$(printf '%s' "$OUT" | grep -c 'identical=3')" "1"
check "la re-ejecucion sigue verificando el remoto" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "1"
check "la guarda lee antes de escribir (GET antes del PUT)" \
  "$(grep -c '^GET|' "$CALLS")" "6"

# --- 7. validacion de configuracion (fail-fast, sin llamadas) ---------------
# Each case asserts two things: the client exits 1, and it never reached the
# transport. A guard that validated AFTER uploading would still exit 1 while
# having already published objects under a key the credential does not allow.
cfg_case() {
  local desc="$1" name="$2" value="$3"
  : > "$CALLS"
  TB_VAR_NAME="$name"; TB_VAR_VALUE="$value"
  run_capture
  if [[ "$RC" == 1 && ! -s "$CALLS" ]]; then
    ok "$desc"
  else
    no "$desc (salida $RC, llamadas $(wc -l < "$CALLS" | tr -d ' '))"
  fi
}
# A single helper has to express both "set to a value" and "set to empty".
# `NAME=value cmd` cannot do that: the empty assignment never reaches the child,
# so the client would fall back to its default and the test would assert the
# wrong thing. `env` inside run_capture is what makes the empty case real.
cfg_case "BACKUP_PREFIX con traversal rechazado"  BACKUP_PREFIX '../escape'
cfg_case "BACKUP_PREFIX con barra inicial rechazado" BACKUP_PREFIX '/prod'
cfg_case "BACKUP_PREFIX vacio rechazado"            BACKUP_PREFIX ''
cfg_case "OFFHOST_UPLOAD_RETRIES=0 rechazado"       OFFHOST_UPLOAD_RETRIES '0'
cfg_case "OFFHOST_UPLOAD_RETRIES no numerico rechazado" OFFHOST_UPLOAD_RETRIES 'abc'
cfg_case "OFFHOST_UPLOAD_RETRIES negativo rechazado" OFFHOST_UPLOAD_RETRIES '-1'
cfg_case "OFFHOST_UPLOAD_RETRY_DELAY no numerico rechazado" OFFHOST_UPLOAD_RETRY_DELAY_SECONDS 'xx'

# --- 7b. variables obligatorias ausentes ------------------------------------
: > "$CALLS"; TB_BUCKET=""
run_capture
if [[ "$RC" == 1 && ! -s "$CALLS" ]]; then ok "BACKUP_BUCKET vacio rechazado antes de cualquier llamada"; else no "BACKUP_BUCKET vacio no rechazado (salida $RC)"; fi
: > "$CALLS"; TB_ENDPOINT=""
run_capture
if [[ "$RC" == 1 && ! -s "$CALLS" ]]; then ok "B2_S3_ENDPOINT vacio rechazado antes de cualquier llamada"; else no "B2_S3_ENDPOINT vacio no rechazado (salida $RC)"; fi

# --- 8. --dry-run no toca el almacenamiento ---------------------------------
: > "$CALLS"
run_capture --dry-run
check "--dry-run no invoca al transporte" "$(wc -l < "$CALLS" | tr -d ' ')" "0"
check "--dry-run reporta las 3 claves" "$(printf '%s' "$OUT" | grep -c 'would upload')" "3"

# --- 9. artefactos faltantes ------------------------------------------------
: > "$CALLS"; TB_DUMP="$WORK/no-existe.dump"
run_capture
check "dump inexistente rechazado" "$RC" "1"
NOMAN="$WORK/m24-postgres-20260926T001718Z-zzz999"
mkdir -p "$NOMAN"
printf 'x' > "$NOMAN/m24-postgres-20260926T001718Z-zzz999.dump"
: > "$CALLS"
TB_DUMP="$NOMAN/m24-postgres-20260926T001718Z-zzz999.dump" run_capture
check "manifest ausente rechazado (no se sube un set incompleto)" "$RC" "1"
check "no se sube ningun objeto si falta el manifest" "$(wc -l < "$CALLS" | tr -d ' ')" "0"

# --- 10. los guards criticos siguen presentes en el codigo -----------------
if grep -q 'local backup is intact' "$UPLOADER"; then ok "el cliente declara que conserva el backup local"; else no "falta la nota de conservacion del backup local"; fi
if grep -q 'EXIT_UPLOAD_FAILED=76' "$UPLOADER"; then ok "el codigo 76 esta definido en el cliente"; else no "falta EXIT_UPLOAD_FAILED=76"; fi
# El orden NO debe ser configurable: es el invariante que hace del manifest un commit.
if grep -q '^UPLOAD_ORDER=("dump" "roles.sql" "manifest")' "$UPLOADER"; then
  ok "el orden de subida es una constante, no una variable de entorno"
else
  no "el orden de subida es configurable <-- romperia el invariante del manifest"
fi
# The published suffix must be the one postgres-restore.sh looks for. A "roles"
# entry would publish <base>.roles while the restore derives <base>.roles.sql,
# so the set would look complete in the bucket and only fail at restore time.
if grep -q 'roles\.sql) printf' "$UPLOADER"; then
  ok "el sufijo roles.sql coincide con el que deriva el restore"
else
  no "el sufijo publicado no coincide con el que busca postgres-restore.sh"
fi

# =============================================================================
# M31.8 — C1 (the manifest must describe the local files), C2 (read-back
# verification), C3 (divergence guard), C4 (opt-in metadata).
#
# Offline: the three seams are local scripts and the "remote" is a directory, so
# every failure mode below is a real execution of the client, not a mock of it.
# =============================================================================
echo ""
echo "M31.8 offhost verification tests (offline, sin red)"

# --- C1: the local set must match its own manifest --------------------------
# A tampered dump: its bytes no longer match dump_sha256.
reset_store
printf 'dump-payload' > "$DUMP"
write_manifest "$MANIFEST" "$DUMP" "$ROLES"
printf 'tampered' >> "$DUMP"
: > "$CALLS"
run_upload
check "C1 dump que no coincide con su manifiesto rechazado" "$RC" "1"
check "C1 no se publica nada" "$(count_puts)" "0"
check "C1 falla antes de la primera lectura remota" "$(grep -c '^HEAD|' "$CALLS")" "0"
check "C1 el diagnostico nombra dump_sha256" \
  "$(printf '%s' "$OUT" | grep -c 'does not match dump_sha256')" "1"
check "C1 el dump local no se toca" "$(wc -c < "$DUMP" | tr -d ' ')" "20"

# A malformed digest: 8 hex characters are not a SHA-256.
printf 'dump-payload' > "$DUMP"
printf 'format=pg_dump-custom\ndump_sha256=deadbeef\nroles_sha256=%s\n' \
  "$(sha_of_file "$ROLES")" > "$MANIFEST"
: > "$CALLS"
run_upload
check "C1 digest malformado rechazado" "$RC" "1"
check "C1 nada se publica con un digest malformado" "$(count_puts)" "0"
check "C1 el diagnostico dice que no es un digest" \
  "$(printf '%s' "$OUT" | grep -c 'no valid dump_sha256')" "1"

# No format field at all: not a manifest this client can trust.
printf 'dump_sha256=%s\nroles_sha256=%s\n' \
  "$(sha_of_file "$DUMP")" "$(sha_of_file "$ROLES")" > "$MANIFEST"
: > "$CALLS"
run_upload
check "C1 manifiesto sin format rechazado" "$RC" "1"
check "C1 nada se publica sin format" "$(count_puts)" "0"

# A roles export that does not match its recorded digest (the sibling case).
write_manifest "$MANIFEST" "$DUMP" "$ROLES"
printf 'roles-payload-extra' >> "$ROLES"
: > "$CALLS"
run_upload
check "C1 roles que no coincide con su manifiesto rechazado" "$RC" "1"
check "C1 el diagnostico nombra roles_sha256" \
  "$(printf '%s' "$OUT" | grep -c 'does not match roles_sha256')" "1"
printf 'roles-payload' > "$ROLES"
write_manifest "$MANIFEST" "$DUMP" "$ROLES"
reset_store

# --- C2: read-back verification --------------------------------------------
# The happy path is asserted in test 1 (verified=3/3, remote_verified=yes). Below
# are the failure modes, each on a FRESH store so the pre-check cannot be what
# produces the failure: on an empty store every object takes the "absent" path and
# the only read of the stored bytes is the read-back.

# C2-a: the stored bytes differ from the local file, with the SAME size, so only
# the digest comparison can catch it. The other objects must still be inspected:
# a phase that stopped at the first mismatch would report 1 of 3.
reset_store
TB_READ_ON=".dump"; TB_GET_MODE="corrupt"
: > "$CALLS"
run_capture
check "C2 contenido divergente falla la verificacion" "$RC" "76"
check "C2 el resumen NO declara verificacion remota" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=no')" "1"
check "C2 el resumen no dice remote_verified=yes" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"
check "C2 se verificaron 2 de 3 objetos" \
  "$(printf '%s' "$OUT" | grep -c 'verified=2/3')" "1"
check "C2 el fallo nombra el digest del objeto" \
  "$(printf '%s' "$OUT" | grep -c 'VERIFY FAILED .*\.dump: stored sha256')" "1"
# Three verification GETs prove the phase did not abort on the first failure.
check "C2 los 3 objetos se inspeccionan pese al fallo del primero" \
  "$(grep -c '^GET|' "$CALLS")" "3"
check "C2 el fallo de verificacion alerta con el 76" "$(grep -c 'FAILED remote verification' <<<"$OUT")" "1"

# C2-b: the stored object cannot be read back at all.
reset_store
TB_READ_ON=".roles.sql"; TB_GET_MODE="read-error"
: > "$CALLS"
run_capture
check "C2 objeto ilegible falla la verificacion" "$RC" "76"
check "C2 el fallo nombra la descarga" \
  "$(printf '%s' "$OUT" | grep -c 'could not be downloaded')" "1"
check "C2 se verificaron 2 de 3 objetos" \
  "$(printf '%s' "$OUT" | grep -c 'verified=2/3')" "1"

# C2-c: the object was there when the guard looked and gone when the read-back
# looked. DOUBLE_HEAD_AFTER=2 aims the mode at the read-back probe only.
reset_store
TB_READ_ON=".manifest"; TB_HEAD_MODE="blind"; TB_HEAD_AFTER=2
: > "$CALLS"
run_capture
check "C2 objeto ausente en la verificacion" "$RC" "76"
check "C2 el fallo nombra la lectura de tamano" \
  "$(printf '%s' "$OUT" | grep -c 'the stored size could not be read')" "1"

# C2-d: a size that does not match, detected without downloading the object.
reset_store
TB_READ_ON=".roles.sql"; TB_HEAD_MODE="wrong-size"; TB_HEAD_AFTER=2
: > "$CALLS"
run_capture
check "C2 tamano incorrecto falla la verificacion" "$RC" "76"
check "C2 el fallo compara tamanos contra la referencia publicada" \
  "$(printf '%s' "$OUT" | grep -c 'does not match the size recorded for')" "1"

# C2-e: an UNDETERMINED probe before the write is not "absent". The client refuses
# rather than overwriting an object whose state it could not establish. This is the
# difference between "the service said 404" and "the read failed".
reset_store
TB_READ_ON=".manifest"; TB_HEAD_MODE="read-error"
: > "$CALLS"
run_capture
check "C2 sonda indeterminada antes de escribir: rechazo" "$RC" "76"
check "C2 el rechazo explica que no es un objeto ausente" \
  "$(printf '%s' "$OUT" | grep -c 'an undetermined probe is not an absent object')" "1"
check "C2 los objetos anteriores si se publicaron" "$(count_puts)" "2"
check "C2 el objeto de estado desconocido no se sobrescribe" \
  "$(put_keys | grep -c '\.manifest$')" "0"

# C2-f: a verification failure emits the documented 76 alert, exactly once.
VERIFY_ALERT="$WORK/verify-alert.json"
rm -f "$VERIFY_ALERT"
reset_store
TB_READ_ON=".dump"; TB_GET_MODE="corrupt"; TB_ALERT_CMD="cat > $VERIFY_ALERT"
run_capture
check "C2 una verificacion fallida conserva el 76" "$RC" "76"
check "C2 la alerta usa el evento documentado" \
  "$(grep -c '"result":"partial_upload_failed"' "$VERIFY_ALERT" 2>/dev/null || true)" "1"
check "C2 la alerta lleva exit_code 76" \
  "$(grep -c '"exit_code":76' "$VERIFY_ALERT" 2>/dev/null || true)" "1"

# --- C3: the divergence guard ----------------------------------------------
# The remote object in these cases is planted in the store before the run, which is
# exactly what a re-run against a set written by a different run looks like.

# C3-a: a pre-existing object with a DIFFERENT SIZE is never overwritten.
reset_store
mkdir -p "$STORE/backups/prod"
printf 'a-divergent-remote-object-with-a-different-size\n' \
  > "$STORE/backups/prod/m24-postgres-20260926T001718Z-abc123.dump"
: > "$CALLS"
run_upload
check "C3 tamano distinto: rechazo con 76" "$RC" "76"
check "C3 el objeto divergente NO se sobrescribe" \
  "$(cat "$STORE/backups/prod/m24-postgres-20260926T001718Z-abc123.dump")" \
  "a-divergent-remote-object-with-a-different-size"
check "C3 no se sube el objeto divergente" "$(put_keys | grep -c '\.dump$')" "0"
check "C3 el diagnostico dice REFUSING y nombra la clave" \
  "$(printf '%s' "$OUT" | grep -c 'REFUSING to overwrite a divergent object.*\.dump')" "1"
check "C3 el diagnostico compara tamanos" \
  "$(printf '%s' "$OUT" | grep -c 'bytes and the local file is')" "1"
check "C3 el commit record no se publica tras el rechazo" \
  "$(put_keys | grep -c '\.manifest$')" "0"
check "C3 un rechazo no declara verificacion remota" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"

# C3-b: same size, different bytes. The size check cannot catch this one, which is
# why the guard downloads the object instead of trusting a metadata comparison.
reset_store
mkdir -p "$STORE/backups/prod"
printf 'DUMP-PAYLOAD' \
  > "$STORE/backups/prod/m24-postgres-20260926T001718Z-abc123.dump"
: > "$CALLS"
run_upload
check "C3 mismo tamano y bytes distintos: rechazo con 76" "$RC" "76"
check "C3 el contenido divergente NO se sobrescribe" \
  "$(cat "$STORE/backups/prod/m24-postgres-20260926T001718Z-abc123.dump")" "DUMP-PAYLOAD"
check "C3 el diagnostico distingue mismo tamano de mismo contenido" \
  "$(printf '%s' "$OUT" | grep -c 'same size but different bytes')" "1"

# C3-c: the race the guard CANNOT close, pinned as a limitation. A probe that
# answers "absent" for an object that exists makes the client overwrite it. The
# guard is a read-then-write with no conditional write behind it, so the window is
# real; the read-back verifies OUR bytes, which is not the same as proving that
# nothing else was clobbered. Closing this needs If-None-Match on the PUT and
# evidence that the endpoint honours it, which is F-P7 work.
reset_store
mkdir -p "$STORE/backups/prod"
printf 'DUMP-PAYLOAD' \
  > "$STORE/backups/prod/m24-postgres-20260926T001718Z-abc123.dump"
TB_READ_ON=".dump"; TB_HEAD_MODE="blind"
: > "$CALLS"
run_capture
check "C3 sonda ciega: el PUT sobrescribe (ventana real)" \
  "$(cat "$STORE/backups/prod/m24-postgres-20260926T001718Z-abc123.dump")" "dump-payload"
check "C3 la lectura de retorno detecta la sonda ciega" "$RC" "76"
check "C3 el fallo se reporta como verificacion, no como subida" \
  "$(printf '%s' "$OUT" | grep -c 'VERIFY FAILED .*\.dump')" "1"
check "C3 el resumen no declara verificacion remota" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=no')" "1"

# --- C4: the metadata option is opt-in and the default request is unchanged ----
# Exercised through the fake `aws` CLI, because that is the only way to observe the
# arguments the real transport builds: the seams replace it entirely.
reset_store
run_capture_aws
check "C4 default: la subida usa aws s3api put-object" \
  "$(grep -c 's3api put-object' "$AWSLOG")" "3"
check "C4 default: ningun --metadata enviado" \
  "$(grep -c -- '--metadata' "$AWSLOG" || true)" "0"
check "C4 default: la verificacion usa head-object" \
  "$(grep -c 's3api head-object' "$AWSLOG")" "6"
check "C4 default: la verificacion usa get-object" \
  "$(grep -c 's3api get-object' "$AWSLOG")" "3"
check "C4 default: la region viaja en cada llamada" \
  "$(grep -c -- '--region test-region' "$AWSLOG")" "12"
check "C4 default: el endpoint viaja en cada llamada" \
  "$(grep -c -- '--endpoint-url https://s3.test.invalid' "$AWSLOG")" "12"
check "C4 default: el resumen verifica 3/3 por la ruta aws" \
  "$(printf '%s' "$OUT" | grep -c 'verified=3/3')" "1"
check "C4 default: ninguna bandera de Object Lock se envia" \
  "$(grep -c -- '--object-lock' "$AWSLOG" || true)" "0"
reset_store
TB_VAR_NAME="OFFHOST_UPLOAD_METADATA_SHA256"; TB_VAR_VALUE="1"
run_capture_aws
check "C4 activo: el digest viaja como --metadata en los 3 PUT" \
  "$(grep -c -- 's3api put-object .*--metadata sha256=[0-9a-f]\{64\}' "$AWSLOG")" "3"
check "C4 activo: el digest enviado es el del fichero concreto" \
  "$(grep -c -- "--body .*\.dump .*--metadata sha256=${DUMP_SHA_FIX}" "$AWSLOG")" "1"
check "C4 activo: el resumen sigue verificando 3/3" \
  "$(printf '%s' "$OUT" | grep -c 'verified=3/3')" "1"
reset_store
TB_VAR_NAME="OFFHOST_UPLOAD_METADATA_SHA256"; TB_VAR_VALUE="2"
: > "$CALLS"; : > "$AWSLOG"
run_capture
check "C4 valor no booleano rechazado" "$RC" "1"
check "C4 el rechazo no toca el transporte" "$(grep -c . "$CALLS")" "0"

# --- C3/C4: the divergence guard through the REAL transport path --------------
# The C3 cases use the seams, which replace the transport. This one goes through
# aws_transport (head-object + get-object + put-object), so the guard is proven on
# the path F-P7 will use, not only on the test path.
reset_store
mkdir -p "$STORE/backups/prod"
printf 'DUMP-PAYLOAD' > "$STORE/backups/prod/m24-postgres-20260926T001718Z-abc123.dump"
run_capture_aws
check "C4 ruta aws: la guarda rechaza la divergencia" "$RC" "76"
check "C4 ruta aws: el objeto divergente no se sobrescribe" \
  "$(cat "$STORE/backups/prod/m24-postgres-20260926T001718Z-abc123.dump")" "DUMP-PAYLOAD"
check "C4 ruta aws: ningun PUT del objeto divergente" \
  "$(grep -c -- 's3api put-object .*\.dump' "$AWSLOG" || true)" "0"
check "C4 ruta aws: el rechazo no declara verificacion remota" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"
reset_store

# =============================================================================
# M31.10 — cierre de los hallazgos de M31.9:
#   H-2 (un registro vacio nunca es un exito silencioso)
#   H-3 (la referencia es el par capturado antes de publicar, no una relectura)
#   H-4 (dependencias resueltas antes del primer PUT; fallos en curso son 76)
# =============================================================================
echo ""
echo "M31.10 offhost closure tests (offline, sin red)"

# --- H-2: un registro vacio es un fallo de verificacion ----------------------
# La guarda se ejerce sobre la funcion REAL, extraida del script que se ejecuta, para
# que la asercion sea sobre el codigo que corre y no sobre una reimplementacion. La
# extraccion se comprueba primero: una extraccion incompleta haria la prueba vacia.
H2_FN="$WORK/h2-verify-remote.sh"
sed -n '/^verify_remote() {$/,/^}$/p' "$UPLOADER" > "$H2_FN"
check "H-2 la extraccion empieza en la funcion" "$(head -n1 "$H2_FN")" "verify_remote() {"
check "H-2 la extraccion contiene la guarda" \
  "$(grep -cF 'no expected objects were registered' "$H2_FN")" "1"
check "H-2 la extraccion contiene el retorno final" \
  "$(grep -cF '((VERIFY_FAILS == 0))' "$H2_FN")" "1"
RC=0
OUT="$(bash -c 'set -Eeuo pipefail; EXPECT_KEYS=(); EXPECT_FILES=(); EXPECT_SHA=(); EXPECT_BYTES=(); source "$1"; verify_remote' _ "$H2_FN" 2>&1)" || RC=$?
check "H-2 registro vacio: verify_remote devuelve no-cero" \
  "$([ "$RC" -ne 0 ] && echo yes || echo no)" "yes"
check "H-2 registro vacio: el diagnostico lo explica" \
  "$(printf '%s' "$OUT" | grep -c 'no expected objects were registered')" "1"
check "H-2 registro vacio: ninguna senal de verificacion" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"

# --- H-3: la referencia es el par capturado antes de publicar ----------------
# (a) El fichero local cambia de TAMANO despues del PUT. La copia remota esta intacta,
# asi que la ejecucion debe declararla verificada: releer el tamano al verificar
# reportaria un desajuste que no existe. Esto es lo que distingue el par capturado de
# una relectura.
reset_store
TB_MUTATE_ON=".dump"; TB_MUTATE_TO="dump-payload-and-more"
: > "$CALLS"
run_capture
check "H-3 cambio de tamano local: termina 0" "$RC" "0"
check "H-3 cambio de tamano local: sin falso desajuste de tamano" \
  "$(printf '%s' "$OUT" | grep -c 'does not match the size recorded for')" "0"
check "H-3 cambio de tamano local: se verifica 3/3" \
  "$(printf '%s' "$OUT" | grep -c 'verified=3/3 .* remote_verified=yes')" "1"
check "H-3 el remoto conserva los bytes publicados" \
  "$(cat "$STORE/backups/prod/m24-postgres-20260926T001718Z-abc123.dump")" "dump-payload"
check "H-3 el fichero local si cambio (mutado por el doble)" \
  "$(cat "$DUMP")" "dump-payload-and-more"
printf 'dump-payload' > "$DUMP"

# (b) El fichero local cambia de CONTENIDO conservando el TAMANO. La comparacion debe
# usar el digest capturado antes del PUT: comparar contra un digest recalculado del
# fichero ya modificado reportaria una divergencia que el remoto no tiene.
reset_store
TB_MUTATE_ON=".dump"; TB_MUTATE_TO="DUMP-PAYLOAD"   # mismos 12 bytes que 'dump-payload'
: > "$CALLS"
run_capture
check "H-3 cambio de contenido con el mismo tamano: termina 0" "$RC" "0"
check "H-3 sin falso desajuste de digest" \
  "$(printf '%s' "$OUT" | grep -c 'does not match the local sha256')" "0"
check "H-3 sin fallo de verificacion" \
  "$(printf '%s' "$OUT" | grep -c 'VERIFY FAILED')" "0"
check "H-3 se verifica 3/3 con la referencia capturada" \
  "$(printf '%s' "$OUT" | grep -c 'verified=3/3 .* remote_verified=yes')" "1"
check "H-3 el local y el remoto ya no coinciden (y aun asi el remoto es correcto)" \
  "$(cat "$DUMP")" "DUMP-PAYLOAD"
check "H-3 el remoto conserva el contenido publicado" \
  "$(cat "$STORE/backups/prod/m24-postgres-20260926T001718Z-abc123.dump")" "dump-payload"
printf 'dump-payload' > "$DUMP"
write_manifest "$MANIFEST" "$DUMP" "$ROLES"
reset_store

# --- H-4: dependencias resueltas antes del primer PUT ------------------------
# (a) Solo el seam de escritura: falta la ruta de lectura y no hay aws en PATH. El
# exit 1 debe significar "no se publico nada", asi que la comprobacion tiene que
# ocurrir antes del primer PUT y sin ninguna llamada remota.
reset_store
: > "$CALLS"
RC=0
OUT="$(env OFFHOST_S3_CMD="$WORK/put.sh" BACKUP_BUCKET=b B2_S3_ENDPOINT=https://x.invalid \
    bash "$UPLOADER" --backup "$DUMP" 2>&1)" || RC=$?
check "H-4 sin ruta de lectura: exit 1" "$RC" "1"
check "H-4 sin ruta de lectura: ninguna llamada al transporte" "$(grep -c . "$CALLS")" "0"
check "H-4 sin ruta de lectura: el diagnostico nombra la verificacion" \
  "$(printf '%s' "$OUT" | grep -c 'aws CLI is required for the read-back verification')" "1"

# (b) Solo el seam de HEAD: sigue siendo un error de configuracion, tambien antes del
# PUT, y el diagnostico apunta a la pieza que falta.
: > "$CALLS"
RC=0
OUT="$(env OFFHOST_S3_HEAD_CMD="$WORK/head.sh" BACKUP_BUCKET=b B2_S3_ENDPOINT=https://x.invalid \
    bash "$UPLOADER" --backup "$DUMP" 2>&1)" || RC=$?
check "H-4 solo HEAD: exit 1" "$RC" "1"
check "H-4 solo HEAD: ninguna llamada al transporte" "$(grep -c . "$CALLS")" "0"
check "H-4 solo HEAD: el diagnostico nombra la subida" \
  "$(printf '%s' "$OUT" | grep -c 'aws CLI is required for the off-host upload')" "1"

# (c) Herramienta de hashing que falla desde la primera llamada: C1 no puede
# establecer el conjunto local, no se publica nada y el diagnostico es explicito (ni
# exito ni salida silenciosa).
reset_store
reset_sha_counter
TB_PATH_PREPEND="$WORK/binsha"; TB_VAR_NAME="SHA_FAIL_FROM"; TB_VAR_VALUE="1"
: > "$CALLS"
run_capture
check "H-4 hashing roto desde el inicio: exit 1" "$RC" "1"
check "H-4 hashing roto desde el inicio: nada se publica" "$(count_puts)" "0"
check "H-4 hashing roto desde el inicio: diagnostico explicito" \
  "$(printf '%s' "$OUT" | grep -c 'could not be computed (the hashing tool failed)')" "1"

# (d) La herramienta funciona hasta despues de las subidas y falla en la lectura de
# retorno. Llamadas de hashing: 1-2 C1, 3 digest del manifiesto, 4+ la verificacion.
# El fallo ocurre DESPUES de publicar, asi que es 76 (fallo remoto), no 1 (que
# significaria que no se publico nada).
reset_store
reset_sha_counter
TB_PATH_PREPEND="$WORK/binsha"; TB_VAR_NAME="SHA_FAIL_FROM"; TB_VAR_VALUE="4"
: > "$CALLS"
run_capture
check "H-4 hashing roto en la verificacion: exit 76" "$RC" "76"
check "H-4 hashing roto en la verificacion: los 3 objetos se publicaron" "$(count_puts)" "3"
check "H-4 hashing roto en la verificacion: se atribuye al hashing" \
  "$(printf '%s' "$OUT" | grep -c 'the downloaded bytes could not be hashed')" "3"
check "H-4 hashing roto en la verificacion: remote_verified=no" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=no')" "1"
check "H-4 hashing roto en la verificacion: no se declara exito" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"
check "H-4 hashing roto en la verificacion: 0/3 verificados" \
  "$(printf '%s' "$OUT" | grep -c 'verified=0/3')" "1"
check "H-4 contabilidad de llamadas de hashing" "$(cat "$SHA_COUNT_FILE")" "6"

# (e) La herramienta falla en la guarda de divergencia de un objeto que ya existe
# (llamada 3). No debe sobrescribirlo ni llamarlo divergencia: el fallo es del
# hashing y el codigo es 76.
reset_store
mkdir -p "$STORE/backups/prod"
cp -f "$DUMP" "$STORE/backups/prod/m24-postgres-20260926T001718Z-abc123.dump"
reset_sha_counter
TB_PATH_PREPEND="$WORK/binsha"; TB_VAR_NAME="SHA_FAIL_FROM"; TB_VAR_VALUE="3"
: > "$CALLS"
run_capture
check "H-4 hashing roto en la guarda: exit 76" "$RC" "76"
check "H-4 hashing roto en la guarda: se atribuye al hashing, no a divergencia" \
  "$(printf '%s' "$OUT" | grep -c 'content could not be hashed')" "1"
check "H-4 hashing roto en la guarda: no se sobrescribe el objeto" \
  "$(put_keys | grep -c '\.dump$')" "0"
check "H-4 hashing roto en la guarda: sin senal de verificacion" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"
reset_store
reset_sha_counter

# --- H-5: stdout y stderr se tratan por separado ------------------------------
# Exercised through the fake `aws` CLI, because the stream handling lives in
# aws_head/aws_get, which only the real transport path reaches.

# (a) Valid answer on stdout with a warning on stderr. The answer must be parsed and
# the warning preserved: merging the streams made the size unparseable and the run
# refused to publish a perfectly good object.
reset_store
mkdir -p "$STORE/backups/prod"
cp -f "$SET/m24-postgres-20260926T001718Z-abc123.dump"      "$STORE/backups/prod/"
cp -f "$SET/m24-postgres-20260926T001718Z-abc123.roles.sql" "$STORE/backups/prod/"
cp -f "$SET/m24-postgres-20260926T001718Z-abc123.manifest"  "$STORE/backups/prod/"
TB_AWS_HEAD_MODE="warning"; TB_AWS_GET_MODE="warning"
run_capture_aws
check "H-5 aviso en stderr con respuesta valida: termina 0" "$RC" "0"
check "H-5 aviso en stderr: se verifica 3/3" \
  "$(printf '%s' "$OUT" | grep -c 'verified=3/3 .* remote_verified=yes')" "1"
check "H-5 aviso en stderr: los 3 objetos se reconocen como identicos" \
  "$(printf '%s' "$OUT" | grep -c 'identical=3')" "1"
check "H-5 aviso en stderr: no se pierde ningun diagnostico" \
  "$(printf '%s' "$OUT" | grep -c 'reported diagnostics on stderr')" "12"
check "H-5 aviso de HEAD conservado" \
  "$(printf '%s' "$OUT" | grep -c 'retrying with the fallback region')" "6"
check "H-5 aviso de GET conservado" \
  "$(printf '%s' "$OUT" | grep -c 'the download was retried once')" "6"
check "H-5 aviso en stderr: ningun fallo de verificacion" \
  "$(printf '%s' "$OUT" | grep -c 'VERIFY FAILED')" "0"

# (b) A real CLI error (500) must NOT be read as an absent object: it is
# undetermined, so the client refuses instead of overwriting whatever is there.
reset_store
TB_AWS_HEAD_MODE="error"
run_capture_aws
check "H-5 error real de HEAD: exit 76" "$RC" "76"
check "H-5 error real de HEAD: no se lee como ausencia" \
  "$(printf '%s' "$OUT" | grep -c 'is not an absent object')" "1"
check "H-5 error real de HEAD: el error del CLI no se oculta" \
  "$(printf '%s' "$OUT" | grep -c 'InternalError')" "1"
check "H-5 error real de HEAD: nada se publica" \
  "$(grep -c -- 's3api put-object' "$AWSLOG" || true)" "0"

# (c) An ambiguous answer (exit 0, stdout is not a size) fails conservatively: the
# client refuses to guess and nothing is published.
reset_store
TB_AWS_HEAD_MODE="ambiguous"
run_capture_aws
check "H-5 respuesta ambigua: exit 76" "$RC" "76"
check "H-5 respuesta ambigua: se rechaza sin adivinar" \
  "$(printf '%s' "$OUT" | grep -c 'refusing to guess')" "1"
check "H-5 respuesta ambigua: la respuesta se cita en el diagnostico" \
  "$(printf '%s' "$OUT" | grep -c 'stdout=None')" "1"
check "H-5 respuesta ambigua: nada se publica" \
  "$(grep -c -- 's3api put-object' "$AWSLOG" || true)" "0"

# (d) A real CLI error on GET during the read-back: a failed read, never a valid
# download and never a divergence.
reset_store
TB_AWS_GET_MODE="error"
run_capture_aws
check "H-5 error real de GET: exit 76" "$RC" "76"
check "H-5 error real de GET: los 3 objetos se publicaron" \
  "$(grep -c -- 's3api put-object' "$AWSLOG")" "3"
check "H-5 error real de GET: se reporta la descarga" \
  "$(printf '%s' "$OUT" | grep -c 'could not be downloaded')" "3"
check "H-5 error real de GET: el error del CLI no se oculta" \
  "$(printf '%s' "$OUT" | grep -c 'InternalError')" "3"
check "H-5 error real de GET: 0/3 verificados" \
  "$(printf '%s' "$OUT" | grep -c 'verified=0/3')" "1"
reset_store

# --- H-10: la ausencia se reconoce solo por la forma posicional del CLI --------
# M31.13: el clasificador anterior aceptaba la SUBCADENA `404` en cualquier texto,
# asi que un 503, un 403 o un error de conectividad que citara "404" (request id,
# URL, nombre de bucket) se leia como objeto ausente; y un objeto ausente se
# publica sin comparar, que es una sobrescritura. Estos casos fijan la forma
# aceptada y demuestran que un falso 404 no puede sobrescribir una clave.

# (a) Objeto realmente ausente, con la forma de error que el harness ya emite. La
# regresion importa tanto como el defecto: si el clasificador nuevo rechazara la
# forma real, ningun objeto nuevo se publicaria nunca.
reset_store
run_capture_aws
check "H-10 ausente real: exit 0" "$RC" "0"
check "H-10 ausente real: los 3 objetos se publican" \
  "$(grep -c -- 's3api put-object' "$AWSLOG" || true)" "3"
check "H-10 ausente real: 3/3 verificados y remote_verified=yes" \
  "$(printf '%s' "$OUT" | grep -c 'verified=3/3 .* remote_verified=yes')" "1"
check "H-10 ausente real: no se trata como indeterminado" \
  "$(printf '%s' "$OUT" | grep -c 'is not an absent object')" "0"

# (b) "404" dentro de un texto que NO es una respuesta de ausencia: request id y URL
# de un 503 real. Debe quedar indeterminado y nada se publica.
reset_store
TB_AWS_HEAD_MODE="misleading404"
run_capture_aws
check "H-10 404 en texto libre: exit 76" "$RC" "76"
check "H-10 404 en texto libre: se lee como indeterminado, no como ausencia" \
  "$(printf '%s' "$OUT" | grep -c 'is not an absent object')" "1"
check "H-10 404 en texto libre: el error real no se oculta" \
  "$(printf '%s' "$OUT" | grep -c 'SlowDown')" "1"
check "H-10 404 en texto libre: no se publica nada" \
  "$(grep -c -- 's3api put-object' "$AWSLOG" || true)" "0"
check "H-10 404 en texto libre: sin senal de exito" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"

# (c) Una forma 404 y un estado distinto en el mismo mensaje: se contradicen, asi
# que el sondeo sigue indeterminado en lugar de convertirse en sobrescritura.
reset_store
TB_AWS_HEAD_MODE="contradictory"
run_capture_aws
check "H-10 404 contradictorio: exit 76" "$RC" "76"
check "H-10 404 contradictorio: se nombra el estado que contradice" \
  "$(printf '%s' "$OUT" | grep -c 'different status (503)')" "1"
check "H-10 404 contradictorio: no se publica nada" \
  "$(grep -c -- 's3api put-object' "$AWSLOG" || true)" "0"
check "H-10 404 contradictorio: sin senal de exito" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"

# (d) Error de autenticacion/permisos (403): nunca ausencia.
reset_store
TB_AWS_HEAD_MODE="forbidden"
run_capture_aws
check "H-10 permisos 403: exit 76" "$RC" "76"
check "H-10 permisos 403: se lee como indeterminado" \
  "$(printf '%s' "$OUT" | grep -c 'is not an absent object')" "1"
check "H-10 permisos 403: el 403 del CLI no se oculta" \
  "$(printf '%s' "$OUT" | grep -c 'Forbidden')" "1"
check "H-10 permisos 403: no se publica nada" \
  "$(grep -c -- 's3api put-object' "$AWSLOG" || true)" "0"
check "H-10 permisos 403: sin senal de exito" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"

# (e) Error de conectividad, sin estado y con el codigo de salida del CLI (255, no
# 254): ni el texto ni el codigo numerico pueden leerse como ausencia.
reset_store
TB_AWS_HEAD_MODE="unreachable"
run_capture_aws
check "H-10 conectividad: exit 76" "$RC" "76"
check "H-10 conectividad: se lee como indeterminado" \
  "$(printf '%s' "$OUT" | grep -c 'is not an absent object')" "1"
check "H-10 conectividad: no se publica nada" \
  "$(grep -c -- 's3api put-object' "$AWSLOG" || true)" "0"
check "H-10 conectividad: sin senal de exito" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"

# (f) La prueba que importa: la clave YA EXISTE con contenido divergente y el sondeo
# miente (404 falso), no tiene permisos (403) o falla (500). Un falso 404 la
# sobrescribiria; el cliente debe dejarla intacta. Se comprueba el CONTENIDO
# almacenado, no solo el contador de PUTs: un PUT contado de menos no probaria que
# los bytes remotos siguen siendo los de antes.
DIVERGENT="$WORK/divergent.dump"
printf 'divergent-remote-content\n' > "$DIVERGENT"
DUMP_KEY="backups/prod/m24-postgres-20260926T001718Z-abc123.dump"
for mode in misleading404 forbidden error; do
  reset_store
  mkdir -p "$STORE/backups/prod"
  cp -f "$DIVERGENT" "$STORE/$DUMP_KEY"
  TB_AWS_HEAD_MODE="$mode"; TB_AWS_MODE_ON="abc123.dump"
  run_capture_aws
  check "H-10 sobrescritura ($mode): exit 76" "$RC" "76"
  check "H-10 sobrescritura ($mode): la clave afectada no se publica" \
    "$(grep -c -- 's3api put-object' "$AWSLOG" || true)" "0"
  check "H-10 sobrescritura ($mode): el diagnostico no la llama ausente" \
    "$(printf '%s' "$OUT" | grep -c 'is not an absent object')" "1"
  if [[ "$(sha_of_file "$DIVERGENT")" == "$(sha_of_file "$STORE/$DUMP_KEY")" ]]; then
    ok "H-10 sobrescritura ($mode): el objeto remoto queda intacto"
  else
    no "H-10 sobrescritura ($mode): el objeto remoto fue sobrescrito"
  fi
  check "H-10 sobrescritura ($mode): sin senal de exito" \
    "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"
done
reset_store

# --- H-11: el fallo al medir un artefacto no puede salir con 1 ni en silencio ---
# M31.13: `size="$(wc -c < "$file")"` sin guarda abortaba el script bajo `set -e`
# con estado 1 y SIN diagnostico, y el fallo ocurre despues de publicar los objetos
# anteriores: el codigo mentia (1 = "no se publico nada") y la causa quedaba oculta.
#
# El fallo se simula con el `wc` de $WORK/binwc, que falla cuando los bytes que
# recibe llevan una marca. Es determinista, no toca ningun archivo del usuario y no
# depende de permisos del sistema operativo. La marca vive en un manifiesto PROPIO
# del caso, pasado con --manifest, asi que el fixture compartido no se altera; sus
# digests son los mismos, de modo que C1 sigue pasando y el fallo ocurre al medir el
# tercer objeto, con los dos primeros ya publicados.
H11_MANIFEST="$WORK/h11-marked.manifest"
cp -f "$MANIFEST" "$H11_MANIFEST"
printf 'h11_measure_marker=H11_MEASURE_FAIL\n' >> "$H11_MANIFEST"

reset_store
TB_PATH_PREPEND="$WORK/binwc"
: > "$CALLS"
run_capture --manifest "$H11_MANIFEST"
check "H-11 fallo de medicion: exit 76 (no 1)" "$RC" "76"
check "H-11 fallo de medicion: los dos primeros objetos se publicaron" "$(count_puts)" "2"
check "H-11 fallo de medicion: el objeto afectado NO se publica" \
  "$(put_keys | grep -c '\.manifest$' || true)" "0"
check "H-11 fallo de medicion: el diagnostico nombra el artefacto" \
  "$(printf '%s' "$OUT" | grep -c 'could not be measured')" "1"
check "H-11 fallo de medicion: el diagnostico admite publicaciones previas" \
  "$(printf '%s' "$OUT" | grep -c 'may already be stored')" "1"
check "H-11 fallo de medicion: no se presenta como fallo de entrada" \
  "$(printf '%s' "$OUT" | grep -c 'nothing was published')" "0"
check "H-11 fallo de medicion: sin senal de exito" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"
check "H-11 fallo de medicion: sin resumen de subida" \
  "$(printf '%s' "$OUT" | grep -c '^offhost=uploaded')" "0"

# En un ensayo no se publica nada, asi que ahi 1 sigue siendo el codigo exacto: la
# guarda distingue los dos casos en lugar de etiquetar todo como 76.
reset_store
TB_PATH_PREPEND="$WORK/binwc"
: > "$CALLS"
run_capture --dry-run --manifest "$H11_MANIFEST"
check "H-11 ensayo: fallo de medicion devuelve 1" "$RC" "1"
check "H-11 ensayo: el diagnostico explica que no se publico nada" \
  "$(printf '%s' "$OUT" | grep -c 'this is a rehearsal')" "1"
check "H-11 ensayo: no se publica nada" "$(count_puts)" "0"
reset_store

# =============================================================================
# M31.15 - refuerzo de las brechas A1/A2/A7/A3 del informe M31.14.
# =============================================================================

# --- A1: los renders de codigo de servicio del CLI -----------------------------
# El clasificador acepta el token en la ranura parentetica, y esa ranura lleva el
# estado HTTP (404 sin cuerpo) o el codigo de servicio. Solo la forma (404) estaba
# probada. Estos dos casos son INDEPENDIENTES entre si, de modo que eliminar
# cualquiera de los dos reconocimientos hace fallar su propia prueba.
reset_store
TB_AWS_ABSENT_SHAPE="nosuchkey"
run_capture_aws
check "A1 (NoSuchKey): se lee como ausencia y el set se publica" "$RC" "0"
check "A1 (NoSuchKey): los 3 objetos se publican" \
  "$(grep -c -- 's3api put-object' "$AWSLOG" || true)" "3"
check "A1 (NoSuchKey): 3/3 verificados con senal de exito" \
  "$(printf '%s' "$OUT" | grep -c 'verified=3/3 .* remote_verified=yes')" "1"
check "A1 (NoSuchKey): no pasa por la rama de sondeo fallido" \
  "$(printf '%s' "$OUT" | grep -c 'head-object failed')" "0"
check "A1 (NoSuchKey): no se trata como indeterminado" \
  "$(printf '%s' "$OUT" | grep -c 'is not an absent object')" "0"

reset_store
TB_AWS_ABSENT_SHAPE="notfoundcode"
run_capture_aws
check "A1 (NotFound): se lee como ausencia y el set se publica" "$RC" "0"
check "A1 (NotFound): los 3 objetos se publican" \
  "$(grep -c -- 's3api put-object' "$AWSLOG" || true)" "3"
check "A1 (NotFound): 3/3 verificados con senal de exito" \
  "$(printf '%s' "$OUT" | grep -c 'verified=3/3 .* remote_verified=yes')" "1"
check "A1 (NotFound): no pasa por la rama de sondeo fallido" \
  "$(printf '%s' "$OUT" | grep -c 'head-object failed')" "0"
check "A1 (NotFound): no se trata como indeterminado" \
  "$(printf '%s' "$OUT" | grep -c 'is not an absent object')" "0"
reset_store

# --- A2: el fallo del HEAD en la LECTURA DE RETORNO -----------------------------
# El objeto YA esta publicado y es la verificacion la que falla: es el camino que
# separa "subido" de "verificado". El contador del falso aws permite apuntar el modo
# al SEGUNDO sondeo de una clave (el de la lectura de retorno) sin tocar el primero.
# (a) error real de servidor en la lectura de retorno del dump: el objeto se publica
# y la verificacion lo cuenta como fallo, sin dejar de verificar el resto del set.
reset_store
TB_AWS_HEAD_MODE="error"; TB_AWS_MODE_ON="abc123.dump"; TB_AWS_HEAD_AFTER="2"
run_capture_aws
check "A2 (a) error en lectura de retorno: exit 76" "$RC" "76"
check "A2 (a) error en lectura de retorno: los 3 objetos se publicaron" \
  "$(grep -c -- 's3api put-object' "$AWSLOG" || true)" "3"
check "A2 (a) error en lectura de retorno: el fallo se atribuye a la verificacion" \
  "$(printf '%s' "$OUT" | grep -c 'VERIFY FAILED .*the stored size could not be read')" "1"
check "A2 (a) error en lectura de retorno: el resto del set si se verifico (2/3)" \
  "$(printf '%s' "$OUT" | grep -c 'verified=2/3 .* remote_verified=no')" "1"
check "A2 (a) error en lectura de retorno: se declara NO verificado" \
  "$(printf '%s' "$OUT" | grep -c 'the remote objects were NOT verified')" "1"
check "A2 (a) error en lectura de retorno: el error del CLI no se oculta" \
  "$(printf '%s' "$OUT" | grep -c 'InternalError')" "1"
check "A2 (a) error en lectura de retorno: sin senal de exito" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"

# (b) el sondeo de retorno responde "ausente" (exit 3) para un objeto que si se
# publico: es un fallo de verificacion, nunca un exito.
reset_store
TB_AWS_HEAD_MODE="notfound"; TB_AWS_MODE_ON="roles.sql"; TB_AWS_HEAD_AFTER="2"
run_capture_aws
check "A2 (b) ausencia en lectura de retorno: exit 76" "$RC" "76"
check "A2 (b) ausencia en lectura de retorno: los 3 objetos se publicaron" \
  "$(grep -c -- 's3api put-object' "$AWSLOG" || true)" "3"
check "A2 (b) ausencia en lectura de retorno: el sondeo ausente se cita como fallo" \
  "$(printf '%s' "$OUT" | grep -c 'the stored size could not be read (probe exit 3)')" "1"
check "A2 (b) ausencia en lectura de retorno: 2/3 y remote_verified=no" \
  "$(printf '%s' "$OUT" | grep -c 'verified=2/3 .* remote_verified=no')" "1"
check "A2 (b) ausencia en lectura de retorno: sin senal de exito" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"

# (c) "404" en texto libre durante la lectura de retorno: indeterminado, no exito.
reset_store
TB_AWS_HEAD_MODE="misleading404"; TB_AWS_MODE_ON=".manifest"; TB_AWS_HEAD_AFTER="2"
run_capture_aws
check "A2 (c) 404 falso en lectura de retorno: exit 76" "$RC" "76"
check "A2 (c) 404 falso en lectura de retorno: el fallo se reporta como verificacion" \
  "$(printf '%s' "$OUT" | grep -c 'VERIFY FAILED .*the stored size could not be read (probe exit 1)')" "1"
check "A2 (c) 404 falso en lectura de retorno: el error real no se oculta" \
  "$(printf '%s' "$OUT" | grep -c 'SlowDown')" "1"
check "A2 (c) 404 falso en lectura de retorno: 2/3 y remote_verified=no" \
  "$(printf '%s' "$OUT" | grep -c 'verified=2/3 .* remote_verified=no')" "1"
check "A2 (c) 404 falso en lectura de retorno: sin senal de exito" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"
reset_store

# --- A7: la negativa a sobrescribir una clave POSTERIOR -------------------------
# Los casos de H-10 rechazan en el PRIMER objeto, asi que no demuestran que la
# guarda funcione cuando ya hay publicaciones. Aqui la clave divergente es el
# manifiesto: dump y roles YA estan almacenados cuando la guarda lo examina.
MANIFEST_KEY="backups/prod/m24-postgres-20260926T001718Z-abc123.manifest"
A7_SEED="$WORK/a7-seed.manifest"
printf 'divergent-manifest' > "$A7_SEED"

# (a) divergencia por TAMANO: se detecta sin descargar nada
reset_store
mkdir -p "$STORE/backups/prod"
cp -f "$A7_SEED" "$STORE/$MANIFEST_KEY"
: > "$CALLS"
run_capture_aws
check "A7 (a) tamano divergente en clave posterior: exit 76" "$RC" "76"
check "A7 (a) tamano divergente en clave posterior: dump y roles ya publicados" \
  "$(grep -c -- 's3api put-object' "$AWSLOG" || true)" "2"
check "A7 (a) tamano divergente en clave posterior: la negativa es por divergencia" \
  "$(printf '%s' "$OUT" | grep -c 'REFUSING to overwrite a divergent object')" "1"
check "A7 (a) tamano divergente en clave posterior: nombra el objeto posterior" \
  "$(printf '%s' "$OUT" | grep -c 'abc123.manifest')" "1"
check "A7 (a) tamano divergente en clave posterior: el objeto remoto queda intacto" \
  "$(sha_of_file "$STORE/$MANIFEST_KEY")" "$(sha_of_file "$A7_SEED")"
check "A7 (a) tamano divergente en clave posterior: sin senal de exito" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"

# (b) divergencia por DIGEST con el MISMO tamano: el tamano no la ve y solo la
# comparacion de contenido puede negarse. El fixture se construye cambiando el
# primer byte del manifiesto real, asi que el tamano coincide por construccion.
A7_SAMESIZE="$WORK/a7-samesize.manifest"
{ printf 'X'; tail -c +2 "$MANIFEST"; } > "$A7_SAMESIZE"
check "A7 fixture: el manifiesto divergente tiene el mismo tamano" \
  "$(wc -c < "$A7_SAMESIZE" | tr -d ' \r\n')" "$(wc -c < "$MANIFEST" | tr -d ' \r\n')"
reset_store
mkdir -p "$STORE/backups/prod"
cp -f "$A7_SAMESIZE" "$STORE/$MANIFEST_KEY"
: > "$CALLS"
run_capture_aws
check "A7 (b) mismo tamano, bytes distintos: exit 76" "$RC" "76"
check "A7 (b) mismo tamano, bytes distintos: dump y roles ya publicados" \
  "$(grep -c -- 's3api put-object' "$AWSLOG" || true)" "2"
check "A7 (b) mismo tamano, bytes distintos: la negativa nombra los bytes" \
  "$(printf '%s' "$OUT" | grep -c 'same size but different bytes')" "1"
check "A7 (b) mismo tamano, bytes distintos: el objeto remoto queda intacto" \
  "$(sha_of_file "$STORE/$MANIFEST_KEY")" "$(sha_of_file "$A7_SAMESIZE")"
check "A7 (b) mismo tamano, bytes distintos: sin senal de exito" \
  "$(printf '%s' "$OUT" | grep -c 'remote_verified=yes')" "0"
reset_store

# --- A3: un fallo recuperable de limpieza no puede matar la ejecucion -----------
# El `rm` falso de $WORK/binrm falla para el directorio scratch del cliente (su
# nombre lleva el prefijo privaris-ops. de make_temp_dir). La limpieza del camino de
# publicacion y de lectura de retorno falla entonces de forma determinista, sin
# permisos del SO y sin tocar ficheros del usuario: la ejecucion debe continuar,
# avisar y conservar el resultado real que sus operaciones hayan conseguido.
reset_store
TB_PATH_PREPEND="$WORK/binrm"
: > "$CALLS"
run_capture
a3_warns="$(printf '%s' "$OUT" | grep -c 'could not be removed' || true)"
check "A3 limpieza que falla (transporte simulado): el resultado real se conserva" "$RC" "0"
check "A3 limpieza que falla (transporte simulado): la verificacion sigue siendo real" \
  "$(printf '%s' "$OUT" | grep -c 'verified=3/3 .* remote_verified=yes')" "1"
check "A3 limpieza que falla (transporte simulado): no se declara fallo" \
  "$(printf '%s' "$OUT" | grep -c 'offhost: FAILED')" "0"
if ((a3_warns >= 1)); then
  ok "A3 limpieza que falla (transporte simulado): se avisa ($a3_warns aviso(s))"
else
  no "A3 limpieza que falla (transporte simulado): no se avisa"
fi

# El caso que ejercita la guarda donde `set -e` ESTA activo: la guarda de divergencia
# de publish() se invoca como comando simple, asi que sin guarda el `rm` que falla
# abortaria con 1. Con el store ya identico, ese camino se recorre entero.
reset_store
TB_PATH_PREPEND="$WORK/binrm"
mkdir -p "$STORE/backups/prod"
cp -f "$SET/m24-postgres-20260926T001718Z-abc123.dump"      "$STORE/backups/prod/"
cp -f "$SET/m24-postgres-20260926T001718Z-abc123.roles.sql" "$STORE/backups/prod/"
cp -f "$SET/m24-postgres-20260926T001718Z-abc123.manifest"  "$STORE/backups/prod/"
: > "$CALLS"
run_capture
a3_probe_warns="$(printf '%s' "$OUT" | grep -c 'could not be removed' || true)"
check "A3 limpieza que falla (guarda de divergencia): exit 0" "$RC" "0"
check "A3 limpieza que falla (guarda de divergencia): los 3 objetos se reconocen identicos" \
  "$(printf '%s' "$OUT" | grep -c 'identical=3')" "1"
check "A3 limpieza que falla (guarda de divergencia): no se declara fallo" \
  "$(printf '%s' "$OUT" | grep -c 'offhost: FAILED')" "0"
if ((a3_probe_warns >= 1)); then
  ok "A3 limpieza que falla (guarda de divergencia): se avisa ($a3_probe_warns aviso(s))"
else
  no "A3 limpieza que falla (guarda de divergencia): no se avisa"
fi
reset_store

# El mismo fallo por el transporte real, donde la limpieza afectada incluye ademas
# los ficheros de diagnostico de aws_head/aws_get.
reset_store
TB_PATH_PREPEND="$WORK/binrm"
run_capture_aws
a3_aws_warns="$(printf '%s' "$OUT" | grep -c 'could not be removed' || true)"
check "A3 limpieza que falla (transporte aws): exit 0" "$RC" "0"
check "A3 limpieza que falla (transporte aws): 3/3 verificados" \
  "$(printf '%s' "$OUT" | grep -c 'verified=3/3 .* remote_verified=yes')" "1"
if ((a3_aws_warns >= 1)); then
  ok "A3 limpieza que falla (transporte aws): se avisa ($a3_aws_warns aviso(s))"
else
  no "A3 limpieza que falla (transporte aws): no se avisa"
fi
reset_store

# =============================================================================
# M29.2 A2 - Alertas en el punto donde nace el 76.
#
# El 76 lo produce ESTE script, asi que aqui se emite la alerta. Estos casos
# son offline y deterministas: el canal es un comando que escribe el JSON
# recibido por stdin en un fichero. Sin red, sin credenciales y sin proveedor.
# =============================================================================
echo ""
echo "M29.2 A2 offhost alert tests (offline, sin red)"

ALERT_OUT="$WORK/alert.json"
ALERT_SINK="cat > $ALERT_OUT"

# --- A1: upload exitoso NO alerta -------------------------------------------
rm -f "$ALERT_OUT"
TB_BUCKET="privaris-postgres-backups" TB_ALERT_CMD="$ALERT_SINK" run_capture
check "A1 upload exitoso conserva exit 0" "$RC" "0"
if [[ ! -s "$ALERT_OUT" ]]; then
  ok "A2 upload exitoso NO emite alerta"
else
  no "A2 upload exitoso emitio alerta"
fi

# --- A3: fallo definitivo -> partial_upload_failed --------------------------
# DOUBLE_FAIL_MODE=always hace fallar todos los intentos: es el fallo
# definitivo que produce el 76, no el transitorio que se recupera.
rm -f "$ALERT_OUT"
TB_FAIL_MODE="always" TB_FAIL_ON="dump" TB_RETRIES=1 TB_DELAY=1 \
  TB_BUCKET="privaris-postgres-backups" TB_ALERT_CMD="$ALERT_SINK" run_capture
check "A3 fallo definitivo conserva exit 76 (no lo degrada)" "$RC" "76"
if [[ -s "$ALERT_OUT" ]]; then
  ok "A4 fallo definitivo emite alerta"
else
  no "A4 fallo definitivo NO emitio alerta"
fi
if grep -q '"result":"partial_upload_failed"' "$ALERT_OUT" 2>/dev/null; then
  ok "A5 la alerta identifica partial_upload_failed"
else
  no "A5 la alerta no dice partial_upload_failed"
fi
if grep -q '"exit_code":76' "$ALERT_OUT" 2>/dev/null; then
  ok "A6 el JSON lleva exit_code 76 como numero"
else
  no "A6 el JSON no lleva exit_code 76"
fi
if grep -qE '"timestamp":"[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$ALERT_OUT" 2>/dev/null; then
  ok "A7 el JSON lleva timestamp ISO-8601"
else
  no "A7 el JSON no lleva timestamp ISO-8601"
fi

# --- A8: sin ALERT_CMD no ocurre nada y el 76 sigue intacto -----------------
rm -f "$ALERT_OUT"
TB_FAIL_MODE="always" TB_FAIL_ON="dump" TB_RETRIES=1 TB_DELAY=1 \
  TB_BUCKET="privaris-postgres-backups" run_capture
check "A8 sin ALERT_CMD el 76 se conserva" "$RC" "76"
if [[ ! -s "$ALERT_OUT" ]]; then
  ok "A9 sin ALERT_CMD no se invoca ningun canal"
else
  no "A9 se invoco un canal sin ALERT_CMD"
fi
if grep -q 'alert' <<<"$OUT"; then
  no "A10 sin ALERT_CMD la salida no debe hablar de alertas"
else
  ok "A10 sin ALERT_CMD no hay ruido en la salida"
fi

# --- A11: un ALERT_CMD caido NO oculta ni reemplaza el 76 --------------------
TB_FAIL_MODE="always" TB_FAIL_ON="dump" TB_RETRIES=1 TB_DELAY=1 \
  TB_BUCKET="privaris-postgres-backups" TB_ALERT_CMD="exit 42" run_capture
check "A11 canal caido: el proceso sigue devolviendo 76" "$RC" "76"
if grep -q 'alert delivery FAILED' <<<"$OUT"; then
  ok "A12 el fallo del canal queda registrado"
else
  no "A12 el fallo del canal no quedo registrado"
fi

# --- A13: el calendario de A1 NO ejecuta este script -------------------------
# Impide "arreglar" el hueco de R9c encadenando el uploader al timer: el
# calendario debe seguir siendo SOLO backup local.
# Se comprueba una INVOCACION, no una mencion: un comentario que cite el
# uploader es legitimo (el seam comparte contrato con el), mientras que una
# llamada real rompere el calendario de A1. Por eso se filtran las lineas de
# comentario y se busca el nombre del script en codigo ejecutable.
sched="$ROOT_DIR/scripts/ops/backup-schedule.sh"
sched_code="$(grep -vE '^[[:space:]]*#' "$sched")"
if grep -q 'offhost-upload' <<<"$sched_code"; then
  no "A13 backup-schedule.sh NO debe invocar offhost-upload.sh"
else
  ok "A13 backup-schedule.sh no invoca offhost-upload.sh"
fi
if grep -qE 'OFFHOST_S3_CMD|bash .*offhost' <<<"$sched_code"; then
  no "A13b backup-schedule.sh no debe ejecutar transporte off-host"
else
  ok "A13b backup-schedule.sh no ejecuta ningun transporte off-host"
fi
svc="$ROOT_DIR/scripts/ops/backup-schedule.service"
if grep -q 'ExecStart=.*backup-schedule\.sh' "$svc" && ! grep -q 'offhost' "$svc"; then
  ok "A14 la unidad systemd arranca backup-schedule.sh y no el uploader"
else
  no "A14 la unidad systemd no arranca solo backup-schedule.sh"
fi

# --- A15: el emisor es compartido, no duplicado ------------------------------
lib="$ROOT_DIR/scripts/ops/lib/alert.sh"
if [[ -f "$lib" ]]; then
  ok "A15 existe la libreria compartida de alertas"
else
  no "A15 falta scripts/ops/lib/alert.sh"
fi
dupes="$(grep -c 'printf.*timestamp.*result.*exit_code' "$sched" "$ROOT_DIR/scripts/ops/offhost-upload.sh" 2>/dev/null | grep -v ':0$' || true)"
if [[ -z "$dupes" ]]; then
  ok "A16 el payload JSON esta definido una sola vez (en lib/alert.sh)"
else
  no "A16 el payload JSON esta duplicado en: $dupes"
fi
for s in "$sched" "$ROOT_DIR/scripts/ops/offhost-upload.sh"; do
  if grep -q 'lib/alert.sh' "$s"; then
    ok "A17 $(basename "$s") usa el emisor compartido"
  else
    no "A17 $(basename "$s") no usa lib/alert.sh"
  fi
done

# --- A18: el emisor nunca cambia el codigo de salida ------------------------
if bash -c 'set -Eeuo pipefail; source scripts/ops/lib/alert.sh; ALERT_CMD="exit 9"; emit_alert partial_upload_failed 76 2026-10-01T00:00:00Z; exit 76' 2>/dev/null; then
  no "A18 el proceso deberia salir 76 con un canal caido"
else
  rc18=$?
  check "A18 el codigo de salida sobrevive a un canal caido" "$rc18" "76"
fi
printf '\n  %d ok, %d fail\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]] || exit 1
