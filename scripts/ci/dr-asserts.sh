#!/usr/bin/env bash
# M28.0: assertions for the DR drill, split out so the orchestrator stays small.
#
# This file holds ONLY pure assertions. It performs no Docker work, mutates no
# state and starts nothing: it reads values the orchestrator exports and decides
# pass/fail. Keeping it free of orchestration is what makes it safe to edit and
# easy to reason about independently of the drill itself.
#
# Contract with run-dr-drill.sh — the orchestrator must export:
#   PASS, FAIL              counters
#   RESTORE_OUT             restore stdout, the source of most assertions
#   MANIFEST                the backup manifest, for expected row counts
#   TGT_Q                   fn: SQL -> value, against the restored database
#   DRILL_KEY, RESTORED_BLOB  for the decrypt-after-restore assertion
#   mfv                     fn: key -> value, read from MANIFEST
#
# Run: sourced by run-dr-drill.sh; not executable on its own.

ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no()   { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
note() { printf '  --   %s\n' "$1"; }

assert_manifest() {
  local t
  for t in organizations users sources findings scans audit_events; do
    [[ -n "$(mfv "count_$t")" ]] && ok "manifest records count_$t" || no "manifest lacks count_$t"
  done
  [[ -n "$(mfv migration_journal_sha256)" ]] \
    && ok "manifest records the migration journal digest" \
    || no "manifest lacks migration_journal_sha256"
  # Without a fingerprint the restore's key check degrades to a warning, so the
  # drill would silently stop proving that the key is the RIGHT one.
  [[ -n "$(mfv source_key_fingerprint)" ]] \
    && ok "manifest records source_key_fingerprint" \
    || no "manifest lacks source_key_fingerprint (key check would be weaker)"
  [[ "$(mfv dump_sha256)" =~ ^[0-9a-f]{64}$ ]] \
    && ok "dump_sha256 is a well-formed digest" \
    || no "dump_sha256 is malformed"
}

# The restore prints one `verified ...` line per property. Asserting on those
# lines tests what the restore actually checked, instead of re-implementing the
# checks here and only proving that two implementations agree with each other.
assert_restore_output() {
  expect_line() {
    printf '%s\n' "$RESTORE_OUT" | grep -qE "$1" && ok "$2" || no "$2"
  }
  expect_line '^restore=ok ' 'restore reported restore=ok'
  expect_line '^verified organizations=[0-9]+$' 'restore verified the organizations count'
  expect_line '^verified sources=[0-9]+$' 'restore verified the sources count'
  expect_line '^verified findings=[0-9]+$' 'restore verified the findings count'
  expect_line '^verified scans=[0-9]+$' 'restore verified the scans count'
  local rls
  rls="$(printf '%s\n' "$RESTORE_OUT" | grep -c '^verified rls .* enable+force$' || true)"
  if [[ "$rls" == 7 ]]; then
    ok "restore verified RLS on all 7 protected tables"
  else
    no "restore verified RLS on $rls tables, expected 7"
  fi
  expect_line '^verified role app_role bypassrls=f$' 'app_role does not bypass RLS'
  expect_line '^verified role bg_role bypassrls=t$' 'bg_role bypasses RLS'
  expect_line '^verified migration journal sha256=[0-9a-f]{64}$' 'restore verified the migration journal digest'
  expect_line '^key_check_fingerprint=match$' 'restore matched the key fingerprint'
  expect_line '^key_check_verified=true$' 'restore decrypted a stored credential'
  expect_line '^key_check_encrypted_sources=[1-9]' 'restored database still holds an encrypted source'
  # A restore that "succeeds" while printing any of these is a false green.
  local bad
  for bad in 'fingerprint mismatch' 'decryption failed' 'row-count mismatch' \
             'checksum mismatch' 'migration journal mismatch'; do
    printf '%s\n' "$RESTORE_OUT" | grep -qF "$bad" \
      && no "restore output contains a failure: $bad" \
      || ok "restore output free of: $bad"
  done
}
# Proves the BYTES are there, read independently from the restored database.
# The assertions above only prove the restore verified things; these prove the
# data actually arrived.
assert_restored_data() {
  local table expected actual
  for table in organizations users sources scans findings audit_events; do
    expected="$(mfv "count_$table")"
    actual="$(TGT_Q "SELECT count(*) FROM $table;")"
    if [[ "$actual" == "$expected" ]]; then
      ok "restored $table holds $expected rows"
    else
      no "restored $table holds ${actual:-<none>}, expected $expected"
    fi
  done
  [[ "$(TGT_Q "SELECT count(*) FROM organizations WHERE id = 'drill-org-1';")" == "1" ]] \
    && ok "the drill's rows are present in the restored database" \
    || no "drill-org-1 not found in the restored database"
}

# The strongest single assertion: the encrypted credential is still decryptable
# in the RESTORED database with the key this process generated. If the dump had
# lost the blob, or the key were wrong, this fails.
assert_decrypts_after_restore() {
  if [[ -n "$RESTORED_BLOB" ]] && node -e '
const c = require("crypto");
const [iv, tag, data] = process.argv[1].split(":");
const decipher = c.createDecipheriv("aes-256-gcm", c.createHash("sha256").update(process.argv[2]).digest(), Buffer.from(iv, "base64"));
decipher.setAuthTag(Buffer.from(tag, "base64"));
const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8"));
if (!parsed.dsn || !parsed.dsn.includes("drill")) { process.exit(1); }
' "$RESTORED_BLOB" "$DRILL_KEY" 2>/dev/null; then
    ok "the encrypted source credential still decrypts in the restored database"
  else
    no "the encrypted source credential did not decrypt after restore"
  fi
}
assert_bundle_contents() {
  local dir="$1" name
  for name in scripts/ops/postgres-restore.sh scripts/ops/common.sh \
             scripts/ops/verify-source-key.cjs scripts/ops/restore-roles.sql \
             scripts/ops/docker-compose.restore.yml MANIFEST.bundle \
             MANIFEST.bundle.sha256 INSTRUCCIONES.md; do
    [[ -f "$dir/$name" ]] || { no "bundle missing $name"; return; }
  done
  ok "bundle contains every required file"
  compgen -G "$dir/lib/db/drizzle/*.sql" >/dev/null \
    && ok "bundle includes the migrations" \
    || no "bundle has no migrations"
  for name in '.env' 'SOURCE_ENCRYPTION_KEY' 'credentials' 'b2-credentials'; do
    if [[ -n "$(find "$dir" -name "$name" -print -quit 2>/dev/null)" ]]; then
      no "bundle contains $name"
    else
      ok "bundle excludes $name"
    fi
  done
  grep -q '^contains_source_encryption_key=no$' "$dir/MANIFEST.bundle" \
    && ok "bundle manifest declares the encryption key is absent" \
    || no "bundle manifest does not declare the key absent"
  # The expanded seed carries a real ciphertext; if the key ever reached the
  # bundle the drill would leak what it exists to protect.
  grep -rqF "$DRILL_KEY" "$dir" 2>/dev/null \
    && no "the drill key appears inside the bundle" \
    || ok "drill key does not appear anywhere in the bundle"
}

assert_summary() {
  printf '\n  %d ok, %d fail\n' "$PASS" "$FAIL"
  note "NOT covered: Backblaze B2, Object Lock, lifecycle, and recovery on a"
  note "separate physical host. Those remain BLOCKED pending a VPS."
  [[ "$FAIL" == 0 ]] || return 1
}
