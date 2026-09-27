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
