DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bg_role') THEN
    CREATE ROLE bg_role LOGIN;
  END IF;
  -- The dump may contain ACLs referring to the deployment's administrative role.
  -- It is recreated as a non-privileged compatibility role; the restore
  -- administrator remains the separate superuser created by PostgreSQL.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'privacy') THEN
    CREATE ROLE privacy LOGIN;
  END IF;
END
$$;

ALTER ROLE app_role NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS LOGIN NOREPLICATION PASSWORD NULL;
ALTER ROLE bg_role NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS LOGIN NOREPLICATION PASSWORD NULL;
ALTER ROLE privacy NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS LOGIN NOREPLICATION PASSWORD NULL;
