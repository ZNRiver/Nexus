-- 002: database description + engine db name (distinct from resource name)

ALTER TABLE databases ADD COLUMN description TEXT;
ALTER TABLE databases ADD COLUMN db_name TEXT;
