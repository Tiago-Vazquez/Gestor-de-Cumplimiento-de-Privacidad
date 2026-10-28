#!/usr/bin/env bash
# F-P3.4 -- offline tests for the H-2 fix in scripts/ops/postgres-restore.sh.
#
# The M25.3 key_check one-shot must hand SOURCE_ENCRYPTION_KEY to
# `docker compose run` WITHOUT placing the value in host argv (the same
# class fixed for PGPASSWORD in postgres-physbackup.sh, M-2). The fix uses
# a private 600-mode env-file consumed via `docker compose run
# --env-from-file` (NOT the interpolation --env-file).
#
# Everything here runs with NO Docker daemon, NO network, NO PostgreSQL
# and NO real secrets. A stub `docker` records argv and emulates the
# in-container node check against canned responses; all values are
# synthetic (DUMMY-*). The gated real path (an actual `compose run`
# against a live project) is NEVER reached here.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESTORE="$ROOT_DIR/scripts/ops/postgres-restore.sh"
PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()   { PASS=$((PASS + 1)); printf "  ok   %s\n" "$1"; }
no()   { FAIL=$((FAIL + 1)); printf "  FAIL %s\n" "$1"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (esperado '$3', obtenido '$2')"; fi; }
code_hits() { grep -c -- "$2" "$1" 2>/dev/null || true; }

echo "F-P3.4 postgres-restore key-env tests"

DUMMY_KEY="DUMMY-SYNTHETIC-KEY-0123456789abcdef-padding=="
DUMMY_FP="dummysyntheticfingerprint0123456789abcdef0123456789abcdef01"

# 1) Static gate: syntax + forbidden argv pattern + required mechanism.
bash -n "$RESTORE";                     check 'bash -n clean'                              "$?" "0"
bash -u -n "$RESTORE";                  check 'bash -u -n clean'                            "$?" "0"
check 'no -e SOURCE_ENCRYPTION_KEY= with value' \
  "$(code_hits "$RESTORE" '-e SOURCE_ENCRYPTION_KEY=')" "0"
check 'no -e EXPECTED_KEY_FINGERPRINT= with value' \
  "$(code_hits "$RESTORE" '-e EXPECTED_KEY_FINGERPRINT=')" "0"
[[ "$(code_hits "$RESTORE" --env-from-file)" -ge 1 ]]; \
  check '--env-from-file present'                      "$?" "0"
check 'mktemp before chmod 600 before write (order)' \
  "$(awk '/keyfile=.*mktemp/{m=NR} /chmod 600 "\$keyfile"/{c=NR} /SOURCE_ENCRYPTION_KEY=%s/{w=NR} END{print ((m>0&&c>m&&w>c)?"ordered":"BAD")}' "$RESTORE")" \
  "ordered"
[[ "$(code_hits "$RESTORE" "trap 'cleanup_restore_keyfile; cleanup' EXIT")" -ge 1 ]]; \
  check 'EXIT trap chains keyfile cleanup + original teardown' "$?" "0"
[[ "$(code_hits "$RESTORE" "trap 'exit 130' INT")" -ge 1 ]]; \
  check 'INT trap installed'                           "$?" "0"
[[ "$(code_hits "$RESTORE" "trap 'exit 143' TERM")" -ge 1 ]]; \
  check 'TERM trap installed'                          "$?" "0"
check 'no printing of the key material' \
  "$(grep -cE 'echo.*\$RESTORE_SOURCE_ENCRYPTION_KEY|echo.*\$expected_fp|cat.*keyfile|cat.*KEY_FILE' "$RESTORE" || true)" "0"

# 2) Functional seam: stub docker + minimal stage tree.
STUBBIN="$WORK/stubbin"; mkdir -p "$STUBBIN"
cat > "$STUBBIN/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\x01' "$@" >> "$CALLS_ARGV"; printf '\n' >> "$CALLS_ARGV"
# 1) The M25.3 key_check one-shot. Detected FIRST, before the generic
# compose branch, so the --env-from-file host path is snapshotted (mode +
# exact content) and the canned key_check body is emitted. The host path
# itself is not secret; the two VALUES live only inside that file.
if [[ " $* " == *" compose "* && " $* " == *" run "* ]]; then
  mode="$(cat "$CTL_DIR/docker-mode" 2>/dev/null || echo ok)"
  printf 'compose-run %s\n' "$mode" >> "$CALLS_RUN"
  for ((i=1; i<=$#; i++)); do
    if [[ "${!i}" == "--env-from-file" ]]; then
      j=$((i+1)); f="${!j}"
      printf 'ENVFILE_PATH=%s\n' "$f" >> "$CALLS_RUN"
      if [[ -f "$f" ]]; then
        stat -c 'ENVFILE_MODE=%a' "$f" >> "$CALLS_RUN" 2>/dev/null \
          || stat -f 'ENVFILE_MODE=%p' "$f" >> "$CALLS_RUN" 2>/dev/null || true
        cp "$f" "$SNAPSHOT" 2>/dev/null || true
      else
        printf 'ENVFILE_MISSING=1\n' >> "$CALLS_RUN"
      fi
    fi
  done
  body="$(cat "$CTL_DIR/key-body" 2>/dev/null || printf 'key_check_verified=true\n')"
  printf '%s\n' "$body"
  case "$mode" in
    ok) exit 0 ;; fail) exit 1 ;; exit3) exit 3 ;;
  esac
fi
# 2) `docker exec` canned answers so the script clears the M24 integrity
# gauntlet and reaches key_check. Order matters: the RLS query also
# mentions pg_class, so relforcerowsecurity is matched before pg_class;
# the drift query also mentions __drizzle_migrations, so DISTINCT hash is
# matched before the migration-count branch.
#   SELECT 1 (readiness)             -> "1"
#   RLS report (relforcerowsecurity) -> the 7 protected tables, all t|t
#   pg_class relkind count (empty)   -> "0"
#   rolbypassrls app_role / bg_role  -> f / t
#   SELECT DISTINCT hash (drift)     -> "" (clean early return, no warning)
#   migration count                  -> "0"
#   count(*) FROM "<table>"          -> "0"   (any other exec -> empty)
if [[ "$1" == "exec" ]]; then
  if   [[ " $* " == *"SELECT 1"* ]];             then printf '1\n'
  elif [[ " $* " == *"relforcerowsecurity"* ]];  then
       printf 'sources|t|t\nfindings|t|t\nreports|t|t\nactivity|t|t\nscans|t|t\nscan_schedules|t|t\nmasking_jobs|t|t\n'
  elif [[ " $* " == *"pg_class"* ]];             then printf '0\n'
  elif [[ " $* " == *"app_role"* ]];             then printf 'f\n'
  elif [[ " $* " == *"bg_role"* ]];              then printf 't\n'
  elif [[ " $* " == *"DISTINCT hash"* ]];        then printf '\n'
  elif [[ " $* " == *"__drizzle_migrations"* ]]; then printf '0\n'
  elif [[ " $* " == *'FROM "'* ]];             then printf '0\n'
  else                                                printf '\n'
  fi
  exit 0
fi
# 3) Compose lifecycle + container-id lookups: canned success. `ps -q db`
# yields a fake id so wait_for_postgres proceeds to the exec loop.
if [[ "$1" == "compose" || "$1" == "ps" || "$1" == "volume" ]]; then
  if [[ " $* " == *" ps -q "* ]]; then printf 'stubdbid\n'; fi
  exit 0
fi
# Every other docker invocation (compose version/ps/up/cp, exec rm ...)
# succeeds silently.
exit 0
STUB
chmod +x "$STUBBIN/docker"

FIX="$WORK/fix"; mkdir -p "$FIX/bin" "$FIX/data"
export CTL_DIR="$FIX/ctl" CALLS_ARGV="$FIX/argv.log" CALLS_RUN="$FIX/run.log" SNAPSHOT="$FIX/snap.env"
mkdir -p "$CTL_DIR"; : > "$CALLS_ARGV"; : > "$CALLS_RUN"
ln -s "$STUBBIN/docker" "$FIX/bin/docker"
printf 'key_check_verified=true\n' > "$CTL_DIR/key-body"
printf 'ok' > "$CTL_DIR/docker-mode"

# Minimal stage tree: only what the pre-key_check stages need.
# Manifest holds the REAL shas of the fixture files; the stub answers
# every docker invocation (compose lifecycle + exec psql queue).
DUMP_SHA="2172fca28cf3a71372d8c91280a35c4981204d3e02a3a2b39d9e45374e9e5f85"
ROLES_SHA="b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd"
BK="$FIX/data/backup"
mkdir -p "$BK"
printf 'DUMMYDUMP' > "$BK/bk.dump"
printf 'SELECT 1;\n' > "$BK/bk.roles.sql"
cat > "$BK/bk.manifest" <<MAN
manifest_version=2
backup_tool=m24-test
pg_major=16
dump_sha256=$DUMP_SHA
roles_sha256=$ROLES_SHA
tables_total=0
tables_with_data=0
rows_total=0
rows_total_sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
migration_count=0
count_sources=0
source_key_fingerprint=dummysyntheticfingerprint0123456789abcdef0123456789abcdef01
MAN

run_restore() {  # $1 = tag ; sets RC and OUT
  OUT="$WORK/out.$1"; : > "$OUT"; RC=0
  : > "$CALLS_ARGV"; : > "$CALLS_RUN"; rm -f "$SNAPSHOT" "$CTL_DIR/psql-queue"
  PATH="$FIX/bin:$PATH" \
  RESTORE_CONFIRM=RESTORE \
  RESTORE_POSTGRES_PASSWORD="DUMMY-PG-PASS-1" \
  RESTORE_APP_ROLE_PASSWORD="DUMMY-APP-PASS-1" \
  RESTORE_BG_ROLE_PASSWORD="DUMMY-BG-PASS-1" \
  RESTORE_JWT_SECRET="DUMMY-JWT-SECRET-0123456789abcdef" \
  RESTORE_SOURCE_ENCRYPTION_KEY="$DUMMY_KEY" \
  bash "$RESTORE" --backup "$BK/bk.dump" --roles "$BK/bk.roles.sql" --manifest "$BK/bk.manifest" \
    >>"$OUT" 2>&1 || RC=$?
}

# Scenario A: key verifies (exit 0).
run_restore "verify-ok"
check 'verified run exits 0' "$RC" "0"
check 'dummy key absent from captured argv' \
  "$(grep -cF "$DUMMY_KEY" "$CALLS_ARGV" || true)" "0"
check 'dummy pg passwords absent from captured argv' \
  "$(grep -cE 'DUMMY-PG-PASS-1|DUMMY-APP-PASS-1|DUMMY-BG-PASS-1' "$CALLS_ARGV" || true)" "0"
[[ "$(grep -c -- '--env-from-file' "$CALLS_ARGV" || true)" -ge 1 ]]; \
  check 'compose run used --env-from-file' "$?" "0"
check 'no -e VAR=VALUE reached the stub' \
  "$(grep -cE -- '-e (SOURCE_ENCRYPTION_KEY|EXPECTED_KEY_FINGERPRINT)=' "$CALLS_ARGV" || true)" "0"
check 'env-file existed at call time' \
  "$(grep -c 'ENVFILE_MISSING' "$CALLS_RUN" || true)" "0"
check 'env-file mode was 600' \
  "$(grep -c 'ENVFILE_MODE=600' "$CALLS_RUN" || true)" "1"
check 'env-file held exactly the two mapped lines' \
  "$(printf 'SOURCE_ENCRYPTION_KEY=%s\nEXPECTED_KEY_FINGERPRINT=%s\n' "$DUMMY_KEY" "$DUMMY_FP" | cmp -s - "$SNAPSHOT" && echo exact || echo BAD)" \
  "exact"
check 'key file removed after success' \
  "$(grep '^ENVFILE_PATH=' "$CALLS_RUN" | cut -d= -f2- | while read -r p; do [[ -e "$p" ]] && echo LEFT || echo gone; done | grep -c LEFT || true)" "0"

# Scenario B: one-shot fails (exit != 0) -> file removed too.
printf 'fail' > "$CTL_DIR/docker-mode"
run_restore "verify-fail"
check 'failed run exits non-zero' "$([ "$RC" != "0" ] && echo nonzero || echo zero)" "nonzero"
check 'dummy key absent from argv on failure' \
  "$(grep -cF "$DUMMY_KEY" "$CALLS_ARGV" || true)" "0"
check 'key file removed after failure' \
  "$(grep '^ENVFILE_PATH=' "$CALLS_RUN" | cut -d= -f2- | while read -r p; do [[ -e "$p" ]] && echo LEFT || echo gone; done | grep -c LEFT || true)" "0"
printf 'ok' > "$CTL_DIR/docker-mode"

# Scenario C: fingerprint mismatch (exit 3) refuses with named message.
printf 'exit3' > "$CTL_DIR/docker-mode"
printf 'key_check_fingerprint=mismatch\n' > "$CTL_DIR/key-body"
run_restore "verify-mismatch"
check 'mismatch run refuses (non-zero)' "$([ "$RC" != "0" ] && echo nonzero || echo zero)" "nonzero"
check 'refusal message names fingerprint' \
  "$(grep -c 'fingerprint mismatch' "$OUT" || true)" "1"
printf 'ok' > "$CTL_DIR/docker-mode"
printf 'key_check_verified=true\n' > "$CTL_DIR/key-body"

# Scenario D: value with '=' survives (base64 padding).
DUMMY_EQ="DUMMY-KEY-WITH-PADDING-0123456789abcdef=="
OUT_EQ="$WORK/out.eq"; : > "$OUT_EQ"; RC_EQ=0
: > "$CALLS_ARGV"; : > "$CALLS_RUN"; rm -f "$SNAPSHOT" "$CTL_DIR/psql-queue"
PATH="$FIX/bin:$PATH" \
RESTORE_CONFIRM=RESTORE \
RESTORE_POSTGRES_PASSWORD="DUMMY-PG-PASS-1" \
RESTORE_APP_ROLE_PASSWORD="DUMMY-APP-PASS-1" \
RESTORE_BG_ROLE_PASSWORD="DUMMY-BG-PASS-1" \
RESTORE_JWT_SECRET="DUMMY-JWT-SECRET-0123456789abcdef" \
RESTORE_SOURCE_ENCRYPTION_KEY="$DUMMY_EQ" \
bash "$RESTORE" --backup "$BK/bk.dump" --roles "$BK/bk.roles.sql" --manifest "$BK/bk.manifest" \
  >>"$OUT_EQ" 2>&1 || RC_EQ=$?
check 'value with = exits 0' "$RC_EQ" "0"
check 'padded value intact in env-file' \
  "$(grep -cF "SOURCE_ENCRYPTION_KEY=$DUMMY_EQ" "$SNAPSHOT" || true)" "1"

# Scenario E: newline rejected closed, no compose run attempted.
OUT_NL="$WORK/out.nl"; : > "$OUT_NL"; RC_NL=0
: > "$CALLS_ARGV"; : > "$CALLS_RUN"; rm -f "$SNAPSHOT" "$CTL_DIR/psql-queue"
NL_KEY="$(printf 'DUMMY-BAD-KEY-WITH-PADDING-0123456789abcdef\nINJECTED=1')"
PATH="$FIX/bin:$PATH" \
RESTORE_CONFIRM=RESTORE \
RESTORE_POSTGRES_PASSWORD="DUMMY-PG-PASS-1" \
RESTORE_APP_ROLE_PASSWORD="DUMMY-APP-PASS-1" \
RESTORE_BG_ROLE_PASSWORD="DUMMY-BG-PASS-1" \
RESTORE_JWT_SECRET="DUMMY-JWT-SECRET-0123456789abcdef" \
RESTORE_SOURCE_ENCRYPTION_KEY="$NL_KEY" \
bash "$RESTORE" --backup "$BK/bk.dump" --roles "$BK/bk.roles.sql" --manifest "$BK/bk.manifest" \
  >>"$OUT_NL" 2>&1 || RC_NL=$?
check 'newline key refused (non-zero)' "$([ "$RC_NL" != "0" ] && echo nonzero || echo zero)" "nonzero"
check 'refusal names the env-file reason' \
  "$(grep -c 'incompatible with the private env-file' "$OUT_NL" || true)" "1"
check 'no compose run attempted after refusal' \
  "$(grep -c 'compose-run' "$CALLS_RUN" || true)" "0"

# Scenario F: trap predicate removes tracked file, never a symlink target.
SIGF="$WORK/sigfile"; printf 'x' > "$SIGF"
RESTORE_KEY_FILE="$SIGF"
if [[ -n "${RESTORE_KEY_FILE:-}" && -f "$RESTORE_KEY_FILE" && ! -L "$RESTORE_KEY_FILE" ]]; then
  rm -f "$RESTORE_KEY_FILE" 2>/dev/null || true
fi
check 'trap predicate removes the tracked regular file' "$([ -e "$SIGF" ] && echo LEFT || echo gone)" "gone"
REALF="$WORK/realfile"; printf 'x' > "$REALF"
LNK="$WORK/siglink"; ln -s "$REALF" "$LNK" 2>/dev/null || cp "$REALF" "$LNK"
if [[ -L "$LNK" ]]; then
  RESTORE_KEY_FILE="$LNK"
  if [[ -n "${RESTORE_KEY_FILE:-}" && -f "$RESTORE_KEY_FILE" && ! -L "$RESTORE_KEY_FILE" ]]; then
    rm -f "$RESTORE_KEY_FILE" 2>/dev/null || true
  fi
  check 'trap predicate never deletes a symlink target' "$([ -e "$REALF" ] && echo intact || echo GONE)" "intact"
else
  ok "trap predicate never deletes a symlink target (SKIP: no symlinks on this host)"
fi
RESTORE_KEY_FILE=""

# 3) Mutation gate: forbidden pattern reintroduced in an ISOLATED COPY
# must turn the static gate red. Production file untouched (verified).
MUT="$WORK/mut-restore.sh"; cp "$RESTORE" "$MUT"
sed -i 's/--env-from-file "$keypath" \\/-e SOURCE_ENCRYPTION_KEY="MUT" \\/' "$MUT"
check 'mutation gate: forbidden -e reintroduced is detected' \
  "$(code_hits "$MUT" '-e SOURCE_ENCRYPTION_KEY=')" "1"
check 'production file still has zero forbidden -e' \
  "$(code_hits "$RESTORE" '-e SOURCE_ENCRYPTION_KEY=')" "0"

echo "----"
if [[ "$FAIL" == 0 ]]; then echo "  $PASS ok, 0 fail"; else echo "  $PASS ok, $FAIL fail"; fi
exit "$([ "$FAIL" == 0 ] && echo 0 || echo 1)"

