-- Bazaar discovered_resources: initial schema.
--
-- Hand-written rather than drizzle-kit generated because we need:
--   1. A maintained tsvector column for full-text search
--   2. A unique index with NULLS NOT DISTINCT semantics (Postgres 15+) so that
--      (resource_url, NULL method, NULL tool_name) deduplicates correctly.
--
-- We use a BEFORE INSERT/UPDATE trigger to populate `search_vector` rather
-- than a STORED generated column. The trigger version sidesteps Postgres'
-- immutability check on generated expressions that involve `to_tsvector`
-- under certain configurations, and is the canonical PG pattern for FTS.

CREATE TABLE IF NOT EXISTS discovered_resources (
  id              bigserial PRIMARY KEY,
  resource_url    text NOT NULL,
  type            text NOT NULL CHECK (type IN ('http', 'mcp')),
  method          text,
  tool_name       text,
  route_template  text,
  description     text,
  mime_type       text,
  service_name    text,
  tags            text[],
  icon_url        text,
  x402_version    integer NOT NULL,
  discovery_info  jsonb NOT NULL,
  accepts         jsonb NOT NULL DEFAULT '[]'::jsonb,
  extensions      jsonb,
  first_seen_at   timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at    timestamptz NOT NULL DEFAULT NOW(),
  -- Populated by `discovered_resources_search_vector_update`. Weighted:
  -- serviceName (A) > description (B) > tags (C). Mirrors the in-memory
  -- catalog's searchScore() so behavior is consistent across backends.
  search_vector   tsvector
);

CREATE OR REPLACE FUNCTION discovered_resources_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.service_name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', array_to_string(COALESCE(NEW.tags, '{}'), ' ')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS discovered_resources_search_vector_trg ON discovered_resources;
CREATE TRIGGER discovered_resources_search_vector_trg
  BEFORE INSERT OR UPDATE OF service_name, description, tags
  ON discovered_resources
  FOR EACH ROW
  EXECUTE FUNCTION discovered_resources_search_vector_update();

-- HTTP rows are keyed by (resource_url, method); MCP rows by (resource_url, tool_name).
-- NULLS NOT DISTINCT (Postgres 15+) makes (url, NULL method, NULL tool_name) collide as expected
-- for legacy entries where the resource server extension never enriched a method.
CREATE UNIQUE INDEX IF NOT EXISTS discovered_resources_catalog_key
  ON discovered_resources (resource_url, method, tool_name)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS discovered_resources_type_idx
  ON discovered_resources (type);

CREATE INDEX IF NOT EXISTS discovered_resources_last_seen_idx
  ON discovered_resources (last_seen_at);

CREATE INDEX IF NOT EXISTS discovered_resources_resource_url_idx
  ON discovered_resources (resource_url);

-- GIN index for the tsvector — what makes `websearch_to_tsquery` fast at scale.
CREATE INDEX IF NOT EXISTS discovered_resources_search_idx
  ON discovered_resources USING GIN (search_vector);

-- jsonb_path_ops GIN over `accepts` lets filters by payTo/scheme/network use the index
-- via @> containment queries.
CREATE INDEX IF NOT EXISTS discovered_resources_accepts_idx
  ON discovered_resources USING GIN (accepts jsonb_path_ops);
