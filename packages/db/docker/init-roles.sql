-- Runs once when the local Docker Postgres volume is first created.
-- In production, create these roles with your provider's tooling and real secrets.
CREATE ROLE decode_web LOGIN PASSWORD 'decode_web' NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE decode_web SET default_transaction_read_only = on;
ALTER ROLE decode_web SET statement_timeout = '5s';
