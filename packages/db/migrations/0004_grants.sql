-- The web app connects as decode_web and may only read.
-- The role itself is created outside migrations (see packages/db/docker/init-roles.sql)
-- because CREATE ROLE needs elevated privileges most managed databases restrict.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'decode_web') THEN
    GRANT USAGE ON SCHEMA public TO decode_web;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO decode_web;
    -- Partitions created later by the loader inherit read access.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO decode_web;
  ELSE
    RAISE NOTICE 'Role decode_web does not exist; skipping read-only grants.';
  END IF;
END
$$;
