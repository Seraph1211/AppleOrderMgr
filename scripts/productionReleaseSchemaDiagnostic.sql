WITH column_rows AS (
  SELECT table_schema, table_name, ordinal_position, column_name, data_type,
    is_nullable, column_default, udt_schema, udt_name,
    character_maximum_length, numeric_precision, numeric_scale,
    datetime_precision, collation_name,
    row_number() OVER (
      PARTITION BY table_schema, table_name ORDER BY ordinal_position
    ) AS dense_position
  FROM information_schema.columns
  WHERE table_schema = 'public'
), column_parts AS (
  SELECT md5(COALESCE(string_agg(
      table_schema || '.' || table_name || '.' || ordinal_position::text || ':' ||
      column_name || ':' || data_type || ':' || is_nullable || ':' ||
      COALESCE(column_default, '') || ':' || COALESCE(udt_schema, '') || ':' ||
      COALESCE(udt_name, '') || ':' ||
      COALESCE(character_maximum_length::text, '') || ':' ||
      COALESCE(numeric_precision::text, '') || ':' ||
      COALESCE(numeric_scale::text, '') || ':' ||
      COALESCE(datetime_precision::text, '') || ':' ||
      COALESCE(collation_name, ''), E'\n'
      ORDER BY table_schema, table_name, ordinal_position), '')) AS raw_digest,
    md5(COALESCE(string_agg(
      table_schema || '.' || table_name || '.' || dense_position::text || ':' ||
      column_name || ':' || data_type || ':' || is_nullable || ':' ||
      COALESCE(column_default, '') || ':' || COALESCE(udt_schema, '') || ':' ||
      COALESCE(udt_name, '') || ':' ||
      COALESCE(character_maximum_length::text, '') || ':' ||
      COALESCE(numeric_precision::text, '') || ':' ||
      COALESCE(numeric_scale::text, '') || ':' ||
      COALESCE(datetime_precision::text, '') || ':' ||
      COALESCE(collation_name, ''), E'\n'
      ORDER BY table_schema, table_name, ordinal_position), '')) AS dense_digest
  FROM column_rows
), constraint_parts AS (
  SELECT md5(COALESCE(string_agg(
    n.nspname || '.' || c.relname || ':' || con.conname || ':' ||
    pg_get_constraintdef(con.oid, true), E'\n'
    ORDER BY n.nspname, c.relname, con.conname), '')) AS digest
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
), index_parts AS (
  SELECT md5(COALESCE(string_agg(
    schemaname || '.' || tablename || ':' || indexname || ':' || indexdef,
    E'\n' ORDER BY schemaname, tablename, indexname), '')) AS digest
  FROM pg_indexes
  WHERE schemaname = 'public'
), type_parts AS (
  SELECT md5(COALESCE(string_agg(
    n.nspname || '.' || t.typname || ':' || t.typtype::text || ':' ||
    t.typcategory::text || ':' || COALESCE(e.enumsortorder::text, '') || ':' ||
    COALESCE(e.enumlabel, ''), E'\n'
    ORDER BY n.nspname, t.typname, e.enumsortorder), '')) AS digest
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  LEFT JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE n.nspname = 'public'
), sequence_parts AS (
  SELECT md5(COALESCE(string_agg(
    schemaname || '.' || sequencename || ':' || data_type || ':' ||
    start_value::text || ':' || min_value::text || ':' || max_value::text || ':' ||
    increment_by::text || ':' || cycle::text || ':' || cache_size::text,
    E'\n' ORDER BY schemaname, sequencename), '')) AS digest
  FROM pg_sequences
  WHERE schemaname = 'public'
), ordinal_gaps AS (
  SELECT COALESCE(json_agg(json_build_object(
    'table', table_schema || '.' || table_name,
    'column', column_name,
    'ordinalPosition', ordinal_position,
    'densePosition', dense_position
  ) ORDER BY table_schema, table_name, ordinal_position), '[]'::json) AS details
  FROM column_rows
  WHERE ordinal_position <> dense_position
)
SELECT json_build_object(
  'passed', true,
  'columnsRawDigest', column_parts.raw_digest,
  'columnsDenseDigest', column_parts.dense_digest,
  'constraintsDigest', constraint_parts.digest,
  'indexesDigest', index_parts.digest,
  'typesDigest', type_parts.digest,
  'sequencesDigest', sequence_parts.digest,
  'ordinalGaps', ordinal_gaps.details
)
FROM column_parts, constraint_parts, index_parts, type_parts, sequence_parts,
  ordinal_gaps;
