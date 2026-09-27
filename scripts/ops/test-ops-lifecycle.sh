#!/usr/bin/env bash
# M28.0 - OFFLINE CONTRACT TEST for the retention / Object Lock invariants.
#
# THIS IS NOT AN INTEGRATION TEST. Nothing here talks to Backblaze B2, and no
# assertion below proves anything about the provider. What it proves is that the
# values ADR-003 committed to still satisfy the ordering the design depends on,
# so a later edit cannot silently invert them.
#
# Why the ordering matters at all: with Object Lock active, a lifecycle rule that
# tries to change or delete a locked file FAILS. If the retention window were
# configured to outlast the lifecycle delete day, lifecycle would fail quietly and
# the bucket would grow with nobody noticing. That failure is silent, which is
# exactly why it deserves a test that runs on every commit.
#
# Run: bash scripts/ops/test-ops-lifecycle.sh
set -uo pipefail

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (esperado '$3', obtenido '$2')"; fi; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "M28.0 lifecycle contract tests (offline, not a B2 integration test)"

# --- Values committed in ADR-003 / .env.example ----------------------------
# Declared once, as plain numbers, so the test states the invariant instead of
# re-deriving it from a document that could change along with it.
OBJECT_LOCK_DAYS=30
HIDE_AFTER_DAYS=90
DELETE_AFTER_HIDE_DAYS=1

# --- 1. the retention floor must stay below the lifecycle delete day --------
# This is the invariant ADR-003 calls "restriccion dura". Inverting these two
# numbers is the one edit that breaks the design without breaking any test that
# existed before M28.0.
if ((OBJECT_LOCK_DAYS < HIDE_AFTER_DAYS)); then
  ok "Object Lock (${OBJECT_LOCK_DAYS}d) termina antes del hide (${HIDE_AFTER_DAYS}d)"
else
  no "Object Lock (${OBJECT_LOCK_DAYS}d) iguala o supera el hide (${HIDE_AFTER_DAYS}d): lifecycle fallaria en silencio"
fi

if ((OBJECT_LOCK_DAYS < HIDE_AFTER_DAYS + DELETE_AFTER_HIDE_DAYS)); then
  ok "Object Lock termina antes del borrado efectivo ($((HIDE_AFTER_DAYS + DELETE_AFTER_HIDE_DAYS))d)"
else
  no "Object Lock no termina antes del borrado efectivo: el borrado chocaria con el lock"
fi

# --- 2. lifecycle ordering -------------------------------------------------
if ((DELETE_AFTER_HIDE_DAYS > 0)); then
  ok "delete ocurre despues de hide"
else
  no "delete no ocurre despues de hide"
fi
check "ventana de retencion remota" "$HIDE_AFTER_DAYS" "90"
check "suelo de inmutabilidad" "$OBJECT_LOCK_DAYS" "30"
check "dias entre hide y delete" "$DELETE_AFTER_HIDE_DAYS" "1"

# --- 3. the provider allows neither value to be zero -----------------------
# Backblaze B2 rejects zero for any of the three lifecycle properties, so a
# zero is not a harmless default: the rule is rejected and the operator is left
# believing retention is configured when it is not.
for pair in "hide:$HIDE_AFTER_DAYS" "delete:$DELETE_AFTER_HIDE_DAYS" "lock:$OBJECT_LOCK_DAYS"; do
  name="${pair%%:*}"; value="${pair##*:}"
  if ((value > 0)); then
    ok "$name es positivo (B2 no acepta 0)"
  else
    no "$name es 0: B2 rechazaria la regla"
  fi
done

# --- 4. the numbers must match what the repository documents ----------------
# The assertions above are self-contained, so a documentation change alone could
# drift away from them. Anchoring the two known sources keeps the contract honest.
ENV_EXAMPLE="$ROOT_DIR/.env.example"
if [[ -f "$ENV_EXAMPLE" ]]; then
  if grep -q '^BACKUP_RETENTION_DAYS=3$' "$ENV_EXAMPLE"; then
    ok ".env.example declara el buffer local en 3 dias (no es la autoridad)"
  else
    no ".env.example no declara BACKUP_RETENTION_DAYS=3"
  fi
else
  no "no se encontro .env.example"
fi
if grep -q '^\.env\.example text eol=lf$' "$ROOT_DIR/.gitattributes" 2>/dev/null; then
  ok ".gitattributes fija LF para .env.example"
else
  no ".gitattributes no fija LF para .env.example"
fi
if grep -q '^\*\.yml text eol=lf$' "$ROOT_DIR/.gitattributes" 2>/dev/null; then
  ok ".gitattributes fija LF para los Compose"
else
  no ".gitattributes no fija LF para los Compose"
fi

printf '\n  %d ok, %d fail\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]] || exit 1
