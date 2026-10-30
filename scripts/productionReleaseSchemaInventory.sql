WITH RECURSIVE constraint_roots AS (
  SELECT con.oid, con.oid AS root_oid
  FROM pg_constraint con
  WHERE con.conparentid = 0
  UNION ALL
  SELECT child.oid, parent.root_oid
  FROM pg_constraint child
  JOIN constraint_roots parent ON parent.oid = child.conparentid
), schemas_component AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', n.nspname, 'owner', pg_get_userbyid(n.nspowner),
    'acl', COALESCE(to_jsonb(n.nspacl), '[]'::jsonb)
  ) ORDER BY n.nspname), '[]'::jsonb) AS value
  FROM pg_namespace n
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
), columns_component AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'relation', c.relname,
    'relationKind', c.relkind,
    'position', row_data.dense_position,
    'name', a.attname,
    'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
    'notNull', a.attnotnull,
    'default', pg_get_expr(ad.adbin, ad.adrelid, true),
    'identity', a.attidentity,
    'generated', a.attgenerated,
    'collation', CASE WHEN a.attcollation = 0 THEN NULL ELSE
      (SELECT cn.nspname || '.' || co.collname
       FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace
       WHERE co.oid = a.attcollation) END
  ) ORDER BY n.nspname, c.relname, row_data.dense_position), '[]'::jsonb) AS value
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
    AND NOT a.attisdropped
  JOIN LATERAL (
    SELECT count(*)::int AS dense_position
    FROM pg_attribute prior
    WHERE prior.attrelid = a.attrelid AND prior.attnum > 0
      AND NOT prior.attisdropped AND prior.attnum <= a.attnum
  ) row_data ON true
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
), types_component AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname, 'name', t.typname, 'kind', t.typtype,
    'category', t.typcategory, 'notNull', t.typnotnull,
    'baseType', CASE WHEN t.typbasetype = 0 THEN NULL ELSE
      pg_catalog.format_type(t.typbasetype, t.typtypmod) END,
    'enumOrder', e.enumsortorder, 'enumLabel', e.enumlabel
  ) ORDER BY n.nspname, t.typname, e.enumsortorder NULLS FIRST), '[]'::jsonb) AS value
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  LEFT JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
), sequences_component AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname, 'name', c.relname,
    'dataType', pg_catalog.format_type(s.seqtypid, NULL),
    'start', s.seqstart::text, 'increment', s.seqincrement::text,
    'min', s.seqmin::text, 'max', s.seqmax::text,
    'cache', s.seqcache::text, 'cycle', s.seqcycle,
    'ownedSchema', owner_ns.nspname, 'ownedTable', owner_table.relname,
    'ownedColumn', owner_column.attname, 'dependencyType', dep.deptype
  ) ORDER BY n.nspname, c.relname), '[]'::jsonb) AS value
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_sequence s ON s.seqrelid = c.oid
  LEFT JOIN pg_depend dep ON dep.classid = 'pg_class'::regclass
    AND dep.objid = c.oid AND dep.objsubid = 0 AND dep.deptype IN ('a', 'i')
  LEFT JOIN pg_class owner_table ON owner_table.oid = dep.refobjid
  LEFT JOIN pg_namespace owner_ns ON owner_ns.oid = owner_table.relnamespace
  LEFT JOIN pg_attribute owner_column ON owner_column.attrelid = dep.refobjid
    AND owner_column.attnum = dep.refobjsubid
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
), constraints_component AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname, 'relation', c.relname,
    'name', CASE WHEN con.conparentid = 0 THEN con.conname ELSE NULL END,
    'type', con.contype,
    'rootSchema', root_ns.nspname, 'rootRelation', root_table.relname,
    'rootName', root_con.conname,
    'keyColumns', COALESCE((SELECT jsonb_agg(att.attname ORDER BY key.ord)
      FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord)
      JOIN pg_attribute att ON att.attrelid = con.conrelid
        AND att.attnum = key.attnum), '[]'::jsonb),
    'referencedSchema', ref_ns.nspname, 'referencedRelation', ref_table.relname,
    'referencedColumns', COALESCE((SELECT jsonb_agg(att.attname ORDER BY key.ord)
      FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, ord)
      JOIN pg_attribute att ON att.attrelid = con.confrelid
        AND att.attnum = key.attnum), '[]'::jsonb),
    'updateAction', con.confupdtype, 'deleteAction', con.confdeltype,
    'matchType', con.confmatchtype, 'deferrable', con.condeferrable,
    'deferred', con.condeferred, 'validated', con.convalidated,
    'local', con.conislocal, 'inheritCount', con.coninhcount,
    'noInherit', con.connoinherit,
    'definition', pg_get_constraintdef(con.oid, true)
  ) ORDER BY n.nspname, c.relname,
    CASE WHEN con.conparentid = 0 THEN con.conname ELSE '' END,
    root_ns.nspname, root_table.relname, root_con.conname,
    pg_get_constraintdef(con.oid, true)), '[]'::jsonb) AS value
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN constraint_roots roots ON roots.oid = con.oid
  JOIN pg_constraint root_con ON root_con.oid = roots.root_oid
  LEFT JOIN pg_class root_table ON root_table.oid = root_con.conrelid
  LEFT JOIN pg_namespace root_ns ON root_ns.oid = root_table.relnamespace
  LEFT JOIN pg_class ref_table ON ref_table.oid = con.confrelid
  LEFT JOIN pg_namespace ref_ns ON ref_ns.oid = ref_table.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
), indexes_component AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname, 'relation', t.relname, 'name', i.relname,
    'accessMethod', am.amname, 'unique', x.indisunique,
    'primary', x.indisprimary, 'exclusion', x.indisexclusion,
    'immediate', x.indimmediate, 'valid', x.indisvalid,
    'ready', x.indisready, 'live', x.indislive,
    'replicaIdentity', x.indisreplident, 'clustered', x.indisclustered,
    'keyAttributeCount', x.indnkeyatts, 'attributeCount', x.indnatts,
    'attributes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'position', pos, 'definition', pg_get_indexdef(x.indexrelid, pos, true),
      'included', pos > x.indnkeyatts,
      'opclass', CASE WHEN pos > x.indnkeyatts THEN NULL ELSE
        opn.nspname || '.' || opc.opcname END,
      'collation', CASE WHEN col.oid IS NULL THEN NULL ELSE
        coln.nspname || '.' || col.collname END,
      'option', CASE WHEN pos > x.indnkeyatts THEN NULL ELSE x.indoption[pos - 1] END
    ) ORDER BY pos)
      FROM generate_series(1, x.indnatts) pos
      LEFT JOIN pg_opclass opc ON opc.oid = x.indclass[pos - 1]
      LEFT JOIN pg_namespace opn ON opn.oid = opc.opcnamespace
      LEFT JOIN pg_collation col ON col.oid = x.indcollation[pos - 1]
      LEFT JOIN pg_namespace coln ON coln.oid = col.collnamespace), '[]'::jsonb),
    'predicate', pg_get_expr(x.indpred, x.indrelid, true),
    'expressions', pg_get_expr(x.indexprs, x.indrelid, true),
    'tablespace', ts.spcname, 'reloptions', COALESCE(to_jsonb(i.reloptions), '[]'::jsonb),
    'definition', pg_get_indexdef(x.indexrelid, 0, true)
  ) ORDER BY n.nspname, t.relname, i.relname), '[]'::jsonb) AS value
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_class t ON t.oid = x.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_am am ON am.oid = i.relam
  LEFT JOIN pg_tablespace ts ON ts.oid = i.reltablespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
), partitions_component AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'parentSchema', parent_ns.nspname, 'parent', parent.relname,
    'childSchema', child_ns.nspname, 'child', child.relname,
    'childKind', child.relkind,
    'bound', pg_get_expr(child.relpartbound, child.oid, true)
  ) ORDER BY parent_ns.nspname, parent.relname, child_ns.nspname, child.relname),
  '[]'::jsonb) AS value
  FROM pg_inherits inh
  JOIN pg_class parent ON parent.oid = inh.inhparent
  JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
  JOIN pg_class child ON child.oid = inh.inhrelid
  JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
  WHERE (parent_ns.nspname NOT IN ('pg_catalog', 'information_schema')
      AND parent_ns.nspname NOT LIKE 'pg_toast%'
      AND parent_ns.nspname NOT LIKE 'pg_temp_%')
    OR (child_ns.nspname NOT IN ('pg_catalog', 'information_schema')
      AND child_ns.nspname NOT LIKE 'pg_toast%'
      AND child_ns.nspname NOT LIKE 'pg_temp_%')
), functions_component AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname, 'name', p.proname, 'kind', p.prokind,
    'identityArguments', pg_get_function_identity_arguments(p.oid),
    'arguments', pg_get_function_arguments(p.oid),
    'result', pg_get_function_result(p.oid),
    'language', language.lanname, 'volatility', p.provolatile,
    'strict', p.proisstrict, 'securityDefiner', p.prosecdef,
    'leakproof', p.proleakproof, 'parallel', p.proparallel,
    'cost', p.procost, 'rows', p.prorows,
    'support', CASE WHEN p.prosupport = 0 THEN NULL ELSE
      p.prosupport::regproc::text END,
    'config', COALESCE(to_jsonb(p.proconfig), '[]'::jsonb),
    'body', pg_get_functiondef(p.oid),
    'acl', COALESCE(to_jsonb(p.proacl), '[]'::jsonb),
    'owner', pg_get_userbyid(p.proowner)
  ) ORDER BY n.nspname, p.proname,
    pg_get_function_identity_arguments(p.oid)), '[]'::jsonb) AS value
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language language ON language.oid = p.prolang
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
), triggers_component AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname, 'relation', c.relname, 'name', trigger.tgname,
    'enabled', trigger.tgenabled, 'typeBits', trigger.tgtype,
    'functionSchema', fn_ns.nspname, 'functionName', fn.proname,
    'functionIdentityArguments', pg_get_function_identity_arguments(fn.oid),
    'argumentsHex', encode(trigger.tgargs, 'hex'),
    'condition', pg_get_expr(trigger.tgqual, trigger.tgrelid, true),
    'constraintSchema', constraint_ns.nspname,
    'constraintRelation', constraint_table.relname,
    'constraintName', con_obj.conname,
    'deferrable', trigger.tgdeferrable,
    'initiallyDeferred', trigger.tginitdeferred,
    'parentTrigger', CASE WHEN trigger.tgparentid = 0 THEN NULL ELSE
      parent_trigger.tgname END,
    'definition', pg_get_triggerdef(trigger.oid, true)
  ) ORDER BY n.nspname, c.relname, trigger.tgname), '[]'::jsonb) AS value
  FROM pg_trigger trigger
  JOIN pg_class c ON c.oid = trigger.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc fn ON fn.oid = trigger.tgfoid
  JOIN pg_namespace fn_ns ON fn_ns.oid = fn.pronamespace
  LEFT JOIN pg_constraint con_obj ON con_obj.oid = trigger.tgconstraint
  LEFT JOIN pg_class constraint_table ON constraint_table.oid = con_obj.conrelid
  LEFT JOIN pg_namespace constraint_ns ON constraint_ns.oid = constraint_table.relnamespace
  LEFT JOIN pg_trigger parent_trigger ON parent_trigger.oid = trigger.tgparentid
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
    AND NOT trigger.tgisinternal
), relations_component AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname, 'name', c.relname, 'kind', c.relkind,
    'persistence', c.relpersistence, 'accessMethod', am.amname,
    'replicaIdentity', c.relreplident, 'rowSecurity', c.relrowsecurity,
    'forceRowSecurity', c.relforcerowsecurity,
    'owner', pg_get_userbyid(c.relowner),
    'acl', COALESCE(to_jsonb(c.relacl), '[]'::jsonb),
    'tablespace', tablespace.spcname,
    'reloptions', COALESCE(to_jsonb(c.reloptions), '[]'::jsonb),
    'partitionStrategy', partitioned.partstrat,
    'partitionKeyDefinition', CASE WHEN c.relkind = 'p' THEN
      pg_get_partkeydef(c.oid) ELSE NULL END,
    'partitionExpressions', CASE WHEN partitioned.partrelid IS NULL THEN NULL ELSE
      pg_get_expr(partitioned.partexprs, c.oid, true) END,
    'partitionAttributes', CASE WHEN partitioned.partrelid IS NULL THEN '[]'::jsonb
      ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'position', position + 1,
        'column', CASE WHEN partitioned.partattrs[position] = 0 THEN NULL ELSE
          attribute.attname END,
        'opclass', opclass_ns.nspname || '.' || opclass.opcname,
        'collation', CASE WHEN coll_obj.oid IS NULL THEN NULL ELSE
          coll_ns.nspname || '.' || coll_obj.collname END
      ) ORDER BY position)
        FROM generate_series(0, partitioned.partnatts - 1) position
        LEFT JOIN pg_attribute attribute ON attribute.attrelid = c.oid
          AND attribute.attnum = partitioned.partattrs[position]
        JOIN pg_opclass opclass ON opclass.oid = partitioned.partclass[position]
        JOIN pg_namespace opclass_ns ON opclass_ns.oid = opclass.opcnamespace
        LEFT JOIN pg_collation coll_obj
          ON coll_obj.oid = partitioned.partcollation[position]
        LEFT JOIN pg_namespace coll_ns
          ON coll_ns.oid = coll_obj.collnamespace), '[]'::jsonb) END,
    'defaultPartition', CASE WHEN partitioned.partdefid = 0 THEN NULL ELSE
      default_ns.nspname || '.' || default_partition.relname END
  ) ORDER BY n.nspname, c.relname), '[]'::jsonb) AS value
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_am am ON am.oid = c.relam
  LEFT JOIN pg_tablespace tablespace ON tablespace.oid = c.reltablespace
  LEFT JOIN pg_partitioned_table partitioned ON partitioned.partrelid = c.oid
  LEFT JOIN pg_class default_partition ON default_partition.oid = partitioned.partdefid
  LEFT JOIN pg_namespace default_ns ON default_ns.oid = default_partition.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
), comments_component AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname, 'relation', c.relname,
    'objectType', CASE WHEN description.objsubid = 0 THEN 'relation' ELSE 'column' END,
    'column', attribute.attname, 'comment', description.description
  ) ORDER BY n.nspname, c.relname, description.objsubid), '[]'::jsonb) AS value
  FROM pg_description description
  JOIN pg_class c ON description.classoid = 'pg_class'::regclass
    AND description.objoid = c.oid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attribute attribute ON attribute.attrelid = c.oid
    AND attribute.attnum = description.objsubid
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
)
SELECT jsonb_build_object(
  'passed', true, 'inventoryVersion', 1,
  'serverVersionNum', current_setting('server_version_num')::int,
  'components', jsonb_build_object(
    'schemas', schemas_component.value,
    'columns', columns_component.value,
    'types', types_component.value,
    'sequences', sequences_component.value,
    'constraints', constraints_component.value,
    'indexes', indexes_component.value,
    'partitions', partitions_component.value,
    'functions', functions_component.value,
    'triggers', triggers_component.value,
    'relations', relations_component.value,
    'comments', comments_component.value
  )
)
FROM schemas_component, columns_component, types_component, sequences_component,
  constraints_component, indexes_component, partitions_component,
  functions_component, triggers_component, relations_component,
  comments_component;
