---
name: MySQL connector details
description: Non-obvious behaviours of the MySQL source connector (M23.1): information_schema casing, default namespace and query timeouts.
---

Three MySQL-specific details worth remembering when touching `connectors/mysql.ts`:

1. MySQL 8 returns `information_schema` column names in UPPERCASE (`TABLE_NAME`). Listing queries must alias explicitly (`SELECT TABLE_NAME AS \`table_name\``) or the driver maps rows to `undefined`.
2. There is no cross-database "schema" concept: the namespace IS the database. The connector defaults the namespace to `config.schema ?? config.database` and lists tables with the schema as a bound parameter — never interpolate it, and never fall back to listing all databases.
3. `mysql2` has no per-statement timeout: the connector wraps every query in a watchdog that destroys the connection and rejects with `ConnectorError("timeout")` when `SOURCE_QUERY_TIMEOUT_MS` expires (PostgreSQL uses server-side `statement_timeout` instead), so a hung source never waits for the scanner reaper.

Identifiers are quoted with backticks via `quoteIdent` (PG uses double quotes); extend that helper rather than building SQL by hand.
