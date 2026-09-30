-- M28.0 - DR drill seed.
--
-- Inserts deterministic rows into the tables postgres-backup.sh records counts
-- for, so the drill can prove the data SURVIVED the backup/restore cycle
-- rather than merely proving the scripts exited 0.
--
-- Column names and value domains were read from the real schema
-- (information_schema plus the distinct values actually stored), not guessed:
-- users has no `id` (the PK is `sub`), sources requires environment/status/
-- tables/records/last_scan_at, findings requires title/data_type/location/
-- severity/records/detected_at/regulation/recommendation/sample/fingerprint/
-- first_seen_at/last_seen_at, and scans requires started_at/completed_at/
-- heartbeat_at. A seed that invented these would fail at initdb and the drill
-- would report a false cause.
--
-- ORDER MATTERS: findings has FKs to BOTH sources and scans, and audit_events to
-- organizations, so the insert order below is dependency order, not cosmetic.
-- PostgreSQL aborts the whole initdb script on the first violation, so a wrong
-- order produces an empty source database and a confusing later failure.
--
-- The encrypted source row is the interesting one. Its blob is NOT written
-- here: the drill generates the ciphertext at runtime with a key that exists
-- only inside the harness process, and substitutes it into the
-- __DRILL_BLOB_JSON__ placeholder below (cast to jsonb, since the column is
-- jsonb). Committing a blob would mean committing a key or a ciphertext, both of
-- which must never enter the repository.
--
-- That row must decrypt with the SAME key the restore is given, otherwise the
-- restore's M25.3 check fails with decryption_failed. That is the assertion:
-- it proves the restored database holds a real, decryptable credential.

-- Counts recorded by postgres-backup.sh: organizations, users, sources,
-- findings, scans, audit_events. Every table below is one of those.
INSERT INTO organizations (id, name, slug, status, created_at) VALUES
  ('drill-org-1', 'Drill Org One',   'drill-org-one',   'active',    now()),
  ('drill-org-2', 'Drill Org Two',   'drill-org-two',   'active',    now()),
  ('drill-org-3', 'Drill Org Three', 'drill-org-three', 'suspended', now()),
  ('drill-org-4', 'Drill Org Four',  'drill-org-four',  'active',    now());

INSERT INTO users (sub, email, name, password_hash, last_login_at, created_at) VALUES
  ('drill-user-1', 'drill-a@example.com', 'Drill A', 'x', now(), now()),
  ('drill-user-2', 'drill-b@example.com', 'Drill B', 'x', now(), now());

-- One source WITH a connection_config (encrypted, substituted at runtime) and
-- one with NULL. The NULL row proves the restore distinguishes "absent" from
-- "present", which is what the M25.3 no_encrypted_sources state depends on.
INSERT INTO sources (id, tenant_id, name, kind, environment, status, tables, records, last_scan_at, connection_config, created_at) VALUES
  ('drill-src-1', 'drill-org-1', 'Drill Encrypted Source', 'postgresql', 'development', 'healthy', 4, 100, now(), '__DRILL_BLOB_JSON__'::jsonb, now()),
  ('drill-src-2', 'drill-org-1', 'Drill Plain Source',     'postgresql', 'development', 'healthy', 2, 50,  now(), NULL,           now());

-- Before findings: findings.scan_id and findings.last_seen_scan_id both FK to
-- scans, so the scan rows must already exist.
INSERT INTO scans (id, source_id, status, started_at, completed_at, heartbeat_at, findings_created, tables_scanned, records_read) VALUES
  ('drill-scan-1', 'drill-src-1', 'completed', now(), now(), now(), 2, 4, 150),
  ('drill-scan-2', 'drill-src-1', 'completed', now(), now(), now(), 0, 4, 150),
  ('drill-scan-3', 'drill-src-2', 'failed',    now(), now(), now(), 0, 2, 50),
  ('drill-scan-4', 'drill-src-1', 'completed', now(), now(), now(), 0, 4, 150);

INSERT INTO findings (id, tenant_id, source_id, source_name, title, data_type, location, severity, status, records, detected_at, regulation, recommendation, sample, scan_id, last_seen_scan_id, fingerprint, first_seen_at, last_seen_at, created_at) VALUES
  ('drill-find-1', 'drill-org-1', 'drill-src-1', 'Drill Encrypted Source', 'Email', 'pii', 'users.email', 'high', 'open', 10, now(), 'GDPR', 'Cifrar la columna', 'a***@example.com', 'drill-scan-1', 'drill-scan-1', 'fp-drill-1', now(), now(), now()),
  ('drill-find-2', 'drill-org-1', 'drill-src-1', 'Drill Encrypted Source', 'Phone', 'pii', 'users.phone', 'low',  'open', 5,  now(), 'GDPR', 'Revisar',          '****123456',     'drill-scan-1', 'drill-scan-1', 'fp-drill-2', now(), now(), now());

INSERT INTO audit_events (id, tenant_id, actor_user_id, action, resource_type, resource_id, result, request_id, created_at) VALUES
  ('drill-audit-1', 'drill-org-1', 'drill-user-1', 'drill.seeded', 'source', 'drill-src-1', 'success', 'drill-request-1', now());

