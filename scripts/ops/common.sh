#!/usr/bin/env bash
# M25.5 — Shared helpers for the operational scripts.
#
# Sourced by postgres-backup.sh and postgres-restore.sh. Kept dependency-free on
# purpose: these scripts run against whatever shell an operator has during an
# incident, so no extra tooling is required.

# Portable SHA-256 of a file.
#
# The file is fed through stdin on purpose. Passing the path as an argument makes
# sha256sum escape backslashes under MSYS/Git Bash, so the output starts with a
# "\" and `awk '{print $1}'` captures a 65-character value. That prefix then
# bakes into the manifest and a later verification of the very same file (typed
# with a different path form) computes a clean 64-character hash and reports a
# mismatch on a perfectly intact backup. Reading from stdin means the path never
# reaches the tool.
#
# Expected behaviour on every platform: reading the file from stdin yields a
# digest that does not depend on how the path is spelled.
# Verified by execution on: Linux (by construction, this tool is the reference
# implementation) and MSYS/Git Bash (M25.5 drills produced identical digests for
# POSIX and backslash paths). The shasum branch used on macOS, where sha256sum is
# absent, is correct by inspection but has NOT been executed on macOS.
sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum < "$file" | awk '{print $1}'
  else
    shasum -a 256 < "$file" | awk '{print $1}'
  fi
}

# Portable SHA-256 of data arriving on stdin.
sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

# Remove a single leading backslash. Historical manifests written from Git Bash
# with a backslash path carry that prefix; this keeps them restorable without
# rewriting the manifest. Done with parameter expansion rather than `tr` because
# `tr -d "\\"` prints a portability warning to stderr that operators read as an
# error.
strip_sha_prefix() {
  local h="$1"
  printf '%s' "${h#\\}"
}

# Remove a trailing carriage return. A manifest edited on Windows may be CRLF
# encoded, and the awk of Linux does not discard the CR the way the MSYS one
# does. Without this the same manifest is accepted on one host and rejected on
# the other. Single mechanism on purpose: every value read from the manifest,
# including the count_* loop, goes through here.
strip_cr() {
  local s="$1"
  printf '%s' "${s%$'\r'}"
}

# A SHA-256 is exactly 64 lowercase hex characters. Enforcing the shape turns a
# silent corruption into a loud, specific failure and keeps a truncated value
# (which is what `cut -c1-64` would produce) from ever being compared.
is_sha256() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }

# Deterministic aggregate of the drizzle migration journal.
#
# Drizzle stores sha256(migration .sql contents) in __drizzle_migrations, but it
# decides "already applied" by created_at, never by hash, so an edited migration
# is silently skipped. This aggregate gives the backup a fingerprint of the
# journal as it actually stands. Ordering by id makes it stable.
journal_sha256_of() {
  local container="$1" db_user="$2" db_name="$3"
  docker_exec "$container" psql -U "$db_user" -d "$db_name" -Atc \
    "SELECT coalesce(string_agg(id::text || ':' || hash || ':' || created_at::text, chr(10) ORDER BY id), '') FROM drizzle.__drizzle_migrations;" \
    | sha256_stdin
}

# ---------------------------------------------------------------------------
# M26.0 — bounded retry with sleep injection
# ---------------------------------------------------------------------------
#
# The off-host upload is the only network operation the backup performs, and
# the only part of it that can fail for reasons outside the VPS. Without a
# retry a single transient 503 or a one-second TLS interruption turns a
# perfectly good local backup into exit 76, which would page an operator for
# something that resolves itself in two seconds.
#
# The sleep is injected through a function name rather than calling `sleep`
# directly so the tests can run the whole loop with zero real waiting. A
# production retry with a real backoff would make the test suite take minutes
# and would still assert less, because the test could not control the delay it
# is measuring. M25.6 institutionalised exactly this: test the contract, not
# the wall clock.
#
# The loop is bounded and the attempt count is validated up front. An
# unvalidated count would make a non-numeric OFFHOST_UPLOAD_RETRIES behave
# like 1, silently degrading a deliberate retry policy to a single attempt —
# the same class of silent degradation M25.5 fixed for
# BACKUP_LOCK_GRACE_SECONDS, where a typo disguised one condition as another.
retry_sleep() { sleep "$1"; }
retry_sleep_hook="${RETRY_SLEEP_HOOK:-retry_sleep}"

# Create a private temporary directory and echo its path.
#
# `mktemp -d` is not used directly. On the MSYS/Git Bash shell this repository is
# developed against, its output is not reliably captured by `$( )`: the command
# succeeds and prints a path, yet the captured value comes back empty, which
# silently turns every later path into "/" and then `rm -rf "$STAGE"` deletes a
# directory it never created. A silent empty value is worse than a hard failure
# here, so the directory is created explicitly and the result is verified before
# being echoed.
make_temp_dir() {
  local base="${TMPDIR:-/tmp}" dir n=0
  # mkdir is atomic and exclusive, which is the property that makes this safe
  # against a concurrent run on the same host.
  while ((n < 100)); do
    dir="$base/privaris-ops.$$.${RANDOM}${n}"
    if mkdir -p "$dir" 2>/dev/null; then
      # Verify the path is really a directory and non-empty: this is the check
      # that would have caught the empty mktemp capture.
      if [[ -n "$dir" && -d "$dir" ]]; then
        printf '%s' "$dir"
        return 0
      fi
    fi
    n=$((n + 1))
  done
  return 1
}

# A positive integer. 0 is rejected rather than treated as "no retries" so that
# an empty or misspelled value cannot be mistaken for a deliberate policy.
is_positive_int() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }

# Run a command up to `attempts` times, sleeping `delay` seconds between tries.
# Returns the command's own exit status so the caller can act on it. Only the
# final attempt's status is meaningful; earlier failures are retried.
retry_with_backoff() {
  local attempts="$1" delay="$2" attempt status=0
  # The two leading parameters must be removed before "$@" is used as the
  # command, otherwise they are re-invoked as the command itself and the retry
  # loop silently executes a number.
  shift 2
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if ((attempt > 1)); then
      "$retry_sleep_hook" "$delay"
    fi
    status=0
    "$@" || status=$?
    ((status == 0)) && return 0
    # 76 is our own "remote failed" status. Retrying it is the whole point, so
    # it is not special-cased here: any non-zero status is retried.
  done
  return "$status"
}
