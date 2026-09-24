---
name: Source connection discriminated union
description: How the multi-engine source connection contract (M23.1) is defined and extended in OpenAPI/Zod, and how the server validates it.
---

`SourceConnectionInput` is a `oneOf` (discriminated by `kind`) of one schema per engine: `PostgresConnectionInput` (`kind: postgresql`) and `MySqlConnectionInput` (`kind: mysql`). `SourceKind` still lists `mongodb | snowflake | bigquery`, but those engines have NO connection schema and NO connector yet.

**Why:** the connection payload must never be ambiguous once several engines exist, and a source must never be scanned with a different engine than the one it declares.

**How to apply:** to add an engine (e.g. MongoDB in M23.2) add (1) `<Engine>ConnectionInput` + a branch of the `oneOf`, (2) a connector module implementing `SourceConnector`, (3) its entry in `connectors/registry.ts` and its branch in `normalizeConnectionConfig`. Routes/repos/UI must keep the `connection.kind === source.kind` invariant: create/PATCH reject mismatches with 400 and `normalizeConnectionConfig` returns `null` (fail-closed) on decrypt, kind mismatch or missing fields. Never let a route import `connectors/*` directly.
