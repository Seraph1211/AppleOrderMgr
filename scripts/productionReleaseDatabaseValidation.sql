WITH business_tables AS (
  SELECT schemaname, tablename
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename <> 'monitor_log_entries'
    AND tablename NOT LIKE 'monitor_log_entries\_%' ESCAPE '\'
    AND tablename <> 'monitor_log_files'
    AND tablename <> 'monitor_log_blocks'
    AND tablename NOT LIKE 'monitor_log_blocks\_%' ESCAPE '\'
    AND tablename <> 'monitor_log_block_accounts'
    AND tablename NOT LIKE 'monitor_log_block_accounts\_%' ESCAPE '\'
    AND tablename <> 'monitor_log_receipts'
), summaries AS (
  SELECT schemaname, tablename,
    ((xpath('/row/count/text()', query_to_xml(
      format('SELECT count(*) AS count FROM %I.%I', schemaname, tablename),
      false, true, '')))[1]::text)::bigint AS row_count,
    (xpath('/row/digest/text()', query_to_xml(
      format('SELECT md5(COALESCE(string_agg(row_digest, '''' ORDER BY row_digest), '''')) AS digest FROM (SELECT md5(to_jsonb(t)::text) AS row_digest FROM %I.%I AS t) AS rows', schemaname, tablename),
      false, true, '')))[1]::text AS row_digest
  FROM business_tables
), schema_parts AS (
  SELECT md5(COALESCE(string_agg(
    table_schema || '.' || table_name || '.' || ordinal_position::text || ':' ||
    column_name || ':' || data_type || ':' || is_nullable || ':' ||
    COALESCE(column_default, '') || ':' || COALESCE(udt_schema, '') || ':' ||
    COALESCE(udt_name, '') || ':' || COALESCE(character_maximum_length::text, '') || ':' ||
    COALESCE(numeric_precision::text, '') || ':' || COALESCE(numeric_scale::text, '') || ':' ||
    COALESCE(datetime_precision::text, '') || ':' || COALESCE(collation_name, ''),
    E'\n' ORDER BY table_schema, table_name,
    ordinal_position), '')) AS columns_digest
  FROM information_schema.columns
  WHERE table_schema = 'public'
), constraint_parts AS (
  SELECT md5(COALESCE(string_agg(
    n.nspname || '.' || c.relname || ':' || con.conname || ':' ||
    pg_get_constraintdef(con.oid, true), E'\n' ORDER BY n.nspname, c.relname,
    con.conname), '')) AS constraints_digest
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
), index_parts AS (
  SELECT md5(COALESCE(string_agg(
    schemaname || '.' || tablename || ':' || indexname || ':' || indexdef,
    E'\n' ORDER BY schemaname, tablename, indexname), '')) AS indexes_digest
  FROM pg_indexes
  WHERE schemaname = 'public'
), type_parts AS (
  SELECT md5(COALESCE(string_agg(
    n.nspname || '.' || t.typname || ':' || t.typtype::text || ':' ||
    t.typcategory::text || ':' ||
    COALESCE(e.enumsortorder::text, '') || ':' || COALESCE(e.enumlabel, ''),
    E'\n' ORDER BY n.nspname, t.typname, e.enumsortorder), '')) AS types_digest
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  LEFT JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE n.nspname = 'public'
), sequence_owners AS (
  SELECT sn.nspname AS sequence_schema, s.relname AS sequence_name,
    tn.nspname AS table_schema, t.relname AS table_name, a.attname AS column_name
  FROM pg_class s
  JOIN pg_namespace sn ON sn.oid = s.relnamespace
  LEFT JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
  LEFT JOIN pg_class t ON t.oid = d.refobjid
  LEFT JOIN pg_namespace tn ON tn.oid = t.relnamespace
  LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
  WHERE s.relkind = 'S' AND sn.nspname = 'public'
), sequence_raw AS (
  SELECT p.schemaname, p.sequencename,
    (xpath('/row/last_value/text()', query_to_xml(
      format('SELECT last_value, is_called FROM %I.%I', p.schemaname, p.sequencename),
      false, true, '')))[1]::text AS last_value,
    (xpath('/row/is_called/text()', query_to_xml(
      format('SELECT last_value, is_called FROM %I.%I', p.schemaname, p.sequencename),
      false, true, '')))[1]::text AS is_called,
    p.data_type, p.start_value, p.min_value, p.max_value, p.increment_by,
    p.cycle, p.cache_size, o.table_schema, o.table_name, o.column_name,
    CASE WHEN o.table_name IS NULL THEN NULL ELSE
      (xpath('/row/max_value/text()', query_to_xml(
        format('SELECT max(%I)::text AS max_value FROM %I.%I',
          o.column_name, o.table_schema, o.table_name), false, true, '')))[1]::text
    END AS owned_max_value
  FROM pg_sequences p
  LEFT JOIN sequence_owners o ON o.sequence_schema = p.schemaname
    AND o.sequence_name = p.sequencename
  WHERE p.schemaname = 'public'
), sequence_summaries AS (
  SELECT *, CASE
    WHEN table_name IS NULL OR owned_max_value IS NULL THEN true
    WHEN is_called::boolean THEN last_value::numeric >= owned_max_value::numeric
    ELSE last_value::numeric > owned_max_value::numeric
  END AS safe_for_nextval
  FROM sequence_raw
), sequence_parts AS (
  SELECT md5(COALESCE(string_agg(
    schemaname || '.' || sequencename || ':' || data_type || ':' || start_value::text || ':' ||
    min_value::text || ':' || max_value::text || ':' || increment_by::text || ':' ||
    cycle::text || ':' || cache_size::text,
    E'\n' ORDER BY schemaname, sequencename), '')) AS sequences_digest
  FROM sequence_summaries
)
SELECT json_build_object(
  'passed', true,
  'validationVersion', 1,
  'businessTableCount', (SELECT count(*) FROM summaries),
  'businessTables', (SELECT json_object_agg(
    schemaname || '.' || tablename,
    json_build_object('rowCount', row_count, 'rowDigest', row_digest)
    ORDER BY schemaname, tablename) FROM summaries),
  'schemaDigest', (SELECT md5(columns_digest || constraints_digest || indexes_digest ||
    types_digest || sequences_digest)
    FROM schema_parts, constraint_parts, index_parts, type_parts, sequence_parts),
  'sequenceStates', (SELECT COALESCE(json_object_agg(
    schemaname || '.' || sequencename,
    json_build_object('lastValue', last_value, 'isCalled', is_called,
      'ownedBy', CASE WHEN table_name IS NULL THEN NULL ELSE
        table_schema || '.' || table_name || '.' || column_name END,
      'ownedColumnMax', owned_max_value, 'safeForNextval', safe_for_nextval)
    ORDER BY schemaname, sequencename), '{}'::json) FROM sequence_summaries),
  'sequenceStatesSnapshotAligned', false,
  'sequenceSafetyPassed', (SELECT COALESCE(bool_and(safe_for_nextval), true)
    FROM sequence_summaries),
  'migrationDigest', COALESCE((SELECT row_digest FROM summaries
    WHERE schemaname = 'public' AND tablename = 'SequelizeMeta'), md5('missing')),
  'migrationCount', COALESCE((SELECT row_count FROM summaries
    WHERE schemaname = 'public' AND tablename = 'SequelizeMeta'), 0),
  'excludedTableData', ARRAY[
    'public.monitor_log_entries', 'public.monitor_log_entries_*',
    'public.monitor_log_files', 'public.monitor_log_blocks',
    'public.monitor_log_blocks_*', 'public.monitor_log_block_accounts',
    'public.monitor_log_block_accounts_*', 'public.monitor_log_receipts'
  ]
);
