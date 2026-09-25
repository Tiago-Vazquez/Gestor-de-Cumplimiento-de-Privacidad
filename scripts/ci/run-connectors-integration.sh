#!/usr/bin/env bash
# M24 CI: run the real M23.1 connector suite against disposable engines.
# This script only creates/removes the explicitly named CI project and volumes.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/scripts/ci/docker-compose.connectors.yml"
PROJECT_NAME="${M24_CI_PROJECT:-m24-connectors-ci}"
export M24_PG_PORT="${M24_PG_PORT:-55432}"
export M24_MYSQL_PORT="${M24_MYSQL_PORT:-33306}"

REPORT_FILE="$(mktemp -t m24-connectors-report.XXXXXX.json)"

cleanup() {
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [[ -n "${REPORT_FILE:-}" ]]; then
    rm -f "$REPORT_FILE"
  fi
}
trap cleanup EXIT

cd "$ROOT_DIR"
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --wait

export M23_MYSQL_HOST=127.0.0.1
export M23_MYSQL_PORT="$M24_MYSQL_PORT"
export M23_MYSQL_USER=m23user
export M23_MYSQL_PASSWORD=m23-secret-pass
export M23_MYSQL_DATABASE=m23crm
export M23_MYSQL_OTHER_DATABASE=m23other
export M23_PG_HOST=127.0.0.1
export M23_PG_PORT="$M24_PG_PORT"
export M23_PG_USER=m23user
export M23_PG_PASSWORD=m23-secret-pass
export M23_PG_DATABASE=m23app
export M23_PG_OTHER_SCHEMA=otros

# The M23.1 suite self-gates on the M23_* variables (describe.skipIf). Without an
# explicit check, a missing variable silently skips every test, vitest still exits 0,
# and CI goes green with zero real engine coverage. Run the human-readable reporter
# and also emit JSON so the result can be verified instead of assumed.
# `pnpm exec` is used instead of the package script because a `--` separator passed
# through `pnpm run` reaches vitest literally and is parsed as a file filter, which
# silently discards the reporter flags.
suite_status=0
pnpm --filter @workspace/api-server exec vitest run \
  src/__tests__/connectors-integration.test.ts \
  --reporter=default --reporter=json --outputFile.json="$REPORT_FILE" || suite_status=$?
if [[ "$suite_status" != 0 ]]; then
  echo "connectors-integration: vitest failed with status $suite_status" >&2
  exit "$suite_status"
fi

guard_status=0
node -e '
const fs = require("node:fs");
const file = process.argv[1];
let report;
try {
  report = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  console.error("connectors-integration: no readable vitest JSON report at " + file);
  process.exit(1);
}
const suites = report.testResults ?? [];
let total = 0, passed = 0, failed = 0, skipped = 0;
for (const suite of suites) {
  for (const t of suite.assertionResults ?? []) {
    total += 1;
    if (t.status === "passed") passed += 1;
    else if (t.status === "failed") failed += 1;
    else skipped += 1;
  }
}
console.log(
  "connectors-integration: files=" + suites.length +
  " total=" + total + " passed=" + passed +
  " failed=" + failed + " skipped=" + skipped
);
const problems = [];
if (suites.length === 0) problems.push("no test file produced a result");
if (total === 0) problems.push("0 tests executed");
if (passed === 0) problems.push("0 tests passed");
if (skipped > 0) problems.push(skipped + " tests skipped: the M23_* engine gate did not activate");
if (problems.length > 0) {
  console.error("connectors-integration guard FAILED: " + problems.join("; "));
  process.exit(1);
}
console.log("connectors-integration guard OK: the suite executed against real engines");
' "$REPORT_FILE" || guard_status=$?

if [[ "$guard_status" != 0 ]]; then
  echo "connectors-integration: refusing a green run in which the connector suite did not execute" >&2
  exit 1
fi

