# M24 — CI reproducible

## Toolchain

- Node.js: `22.22.2` (also the runtime used by the Docker images).
- pnpm: `10.18.3` (declared in the root `package.json` and used by the Dockerfiles).
- Install with `pnpm install --frozen-lockfile`; never regenerate the lockfile in CI.

## Product quality gate

`pnpm run typecheck:product` covers the shared libraries, API and frontend. The
product build is `pnpm run build:product`, and the unit suites are run separately
for the API and frontend so a failure is attributable to a package. The required
dependency gate is:

```bash
pnpm audit --audit-level high
```

It fails the workflow for high or critical advisories. The validated baseline has
no high/critical findings. The remaining findings are development/test-only and
remain visible in the audit output:

| Package | Severity | Path | Mitigation / next action |
| --- | --- | --- | --- |
| `esbuild` | low | API development tooling | Not shipped as a runtime service; upgrade to `>=0.28.1` when the direct tool upgrade is validated. |
| `qs` (2 advisories) | moderate | `supertest`/`superagent` test dependency | Test-only; do not expose the test server. Upgrade via `supertest` when a compatible release is available. |
| `vitest` / `@vitest/mocker` | moderate | API/frontend test runner | Test-only; upgrade to `>=4.1.11` as a separately reviewed dependency change. |

These residual advisories do not weaken the required high/critical gate.

## Docker connector integration

`connectors-integration` starts isolated PostgreSQL 16 and MySQL 8.4 services,
mounts the deterministic SQL seeds, waits for both health checks, and runs:

```bash
pnpm --filter @workspace/api-server run test:integration
```

The integration job is **not allowed to pass by skipping its engine tests**. The
M23.1 suite self-gates on those variables (`describe.skipIf`), so a missing value
would skip every test while vitest still exits 0 — the job would look green with
zero real engine coverage. `scripts/ci/run-connectors-integration.sh` therefore runs
the suite with a second JSON reporter and enforces a guard that fails the job unless
the report shows at least one executed test, at least one passing test, and **zero
skipped tests**:

```text
connectors-integration: files=1 total=19 passed=19 failed=0 skipped=0
connectors-integration guard OK: the suite executed against real engines
```

A run reporting `total=0`, `passed=0` or any `skipped` is a failure, not a pass.
The guard is what makes a green integration job evidence of real PostgreSQL and
MySQL coverage rather than an assumption. Containers and volumes of the CI project
are removed on exit, including on failure or when the guard aborts.

## `mockup-sandbox` boundary

`artifacts/mockup-sandbox` is a non-production prototype: it is not copied into
`Dockerfile.api` or `Dockerfile.web`, is not a dependency of the API/frontend
runtime, and is not included in the product quality job. It remains a workspace
package and can be checked explicitly with:

```bash
pnpm run typecheck:sandbox
```

Its current failure is an existing Vite 5/7 plugin type incompatibility in
`artifacts/mockup-sandbox/vite.config.ts`; it is not hidden with `continue-on-error`
inside the product workflow. Any future sandbox fix must be reviewed separately
and must not weaken the API, frontend or library gates.
