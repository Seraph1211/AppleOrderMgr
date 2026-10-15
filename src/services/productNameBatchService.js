const { isDeepStrictEqual } = require('node:util');
/** 有界、原子且保留非目标字段的业务名称批处理。 */
const { randomUUID, createHash } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { resolveProductName, PRODUCT_NAME_RULE_VERSION } = require('../utils/productNaming');
const logger = require('../utils/logger');
const TABLES = ['orders', 'inventory_products'];
const LOCK_ID = 2026101502;

/** 逐页计算所有非名称字段摘要，不在报告输出完整业务行。 @param {Object} db 连接 @returns {Promise<Object>} 摘要 */
async function protectedSnapshot(db) {
  try {
    const result = {};
    for (const table of TABLES) {
      const hash = createHash('sha256');
      let cursor = '';
      let count = 0;
      for (;;) {
        const rows = await db.query(
          `SELECT id::text AS id, (to_jsonb(t)-'${table === 'orders' ? 'products' : 'body'}') AS protected, ${table === 'orders' ? "(SELECT jsonb_agg(value-'name' ORDER BY ordinality) FROM jsonb_array_elements(t.products) WITH ORDINALITY)" : "body-'title'"} AS specs FROM ${table} t WHERE id::text > :cursor ORDER BY id::text LIMIT 100`,
          { replacements: { cursor }, type: QueryTypes.SELECT }
        );
        if (!rows.length) break;
        for (const row of rows) hash.update(JSON.stringify(row));
        cursor = rows[rows.length - 1].id;
        count += rows.length;
      }
      result[table] = { count, sha256: hash.digest('hex') };
    }
    return result;
  } catch (error) {
    logger.debug('名称批处理保护摘要未完成', { code: error.code || error.name });
    throw error;
  }
}

/** 扫描／修改明确名称，不写未知项或冲突项。 @param {Object} db Sequelize @param {Object} options 参数 @returns {Promise<Object>} 汇总 */
async function runProductNameBatch(
  db,
  { mode = 'dry-run', batchId = randomUUID(), batchSize = 100 } = {}
) {
  try {
    if (!['dry-run', 'apply', 'verify'].includes(mode))
      throw new Error('mode 必须为 dry-run/apply/verify');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId))
      throw new Error('batchId 必须为 UUID');
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500)
      throw new Error('batchSize 必须在 1..500');
    const report = {
      mode,
      batchId,
      ruleVersion: PRODUCT_NAME_RULE_VERSION,
      scanned: 0,
      candidates: 0,
      changed: 0,
      needsReview: 0,
      conflicts: 0,
      ruleMismatches: 0,
      examples: [],
      exceptions: [],
    };
    if (mode === 'verify') {
      const [summary] = await db.query(
        "SELECT count(*)::integer AS audited, count(*) FILTER (WHERE original_name=normalized_name OR normalize_business_product_name(identity||jsonb_build_object('name',original_name))<>normalized_name)::integer AS invalid FROM product_name_changes WHERE batch_id=:batchId",
        { replacements: { batchId }, type: QueryTypes.SELECT }
      );
      const [pending] = await db.query(
        "SELECT (SELECT count(*) FROM orders o WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(o.products) p WHERE p->>'name' IS NOT NULL AND p->>'name' IS DISTINCT FROM normalize_business_product_name(p))) + (SELECT count(*) FROM inventory_products WHERE body->>'title' IS NOT NULL AND body->>'title' IS DISTINCT FROM normalize_business_product_name(body)) AS pending",
        { type: QueryTypes.SELECT }
      );
      const [current] = await db.query(
        `SELECT count(*) FILTER (WHERE current_name IS DISTINCT FROM normalized_name OR current_identity IS DISTINCT FROM identity)::integer AS current_mismatches FROM (
          SELECT a.*,
            CASE WHEN a.entity_type='orders' THEN o.products->(split_part(a.field_path,'.',2)::int)->>'name' ELSE i.body->>'title' END AS current_name,
            CASE WHEN a.entity_type='orders' THEN product_name_identity(o.products->(split_part(a.field_path,'.',2)::int),'name') ELSE product_name_identity(i.body,'title') END AS current_identity
          FROM product_name_changes a
          LEFT JOIN orders o ON a.entity_type='orders' AND o.id::text=a.entity_id
          LEFT JOIN inventory_products i ON a.entity_type='inventory_products' AND i.id=a.entity_id
          WHERE a.batch_id=:batchId
        ) checked`,
        { replacements: { batchId }, type: QueryTypes.SELECT }
      );
      return {
        ...report,
        ...summary,
        batchFound: summary.audited > 0,
        currentMismatches: current.current_mismatches,
        pending: Number(pending.pending),
        protected: await protectedSnapshot(db),
      };
    }
    report.before = await protectedSnapshot(db);
    for (const table of TABLES) {
      let cursor = '';
      for (;;) {
        const field = table === 'orders' ? 'products' : 'body';
        const rows = await db.query(
          `SELECT id::text AS id, ${field} AS value FROM ${table} WHERE id::text>:cursor ORDER BY id::text LIMIT :batchSize`,
          { replacements: { cursor, batchSize }, type: QueryTypes.SELECT }
        );
        if (!rows.length) break;
        const candidates = [];
        for (const row of rows) {
          report.scanned++;
          let changed = false;
          const products = table === 'orders' ? row.value : [row.value];
          if (!Array.isArray(products)) continue;
          const mapped = products.map((product, index) => {
            const result = resolveProductName(product);
            const key = table === 'orders' ? 'name' : 'title';
            if (!result.matched) {
              report.needsReview++;
              if (report.exceptions.length < 100)
                report.exceptions.push({ table, id: row.id, index, reason: result.reason });
              return product;
            }
            if (typeof product[key] !== 'string' || product[key] === result.name) return product;
            report.candidates++;
            changed = true;
            if (report.examples.length < 100)
              report.examples.push({
                table,
                id: row.id,
                index,
                oldName: product[key],
                newName: result.name,
              });
            return { ...product, [key]: result.name };
          });
          if (changed) candidates.push({ ...row, next: table === 'orders' ? mapped : mapped[0] });
        }
        if (mode === 'apply' && candidates.length) {
          await db.transaction(async transaction => {
            try {
              const [{ locked }] = await db.query(
                'SELECT pg_try_advisory_xact_lock(:lockId) AS locked',
                { replacements: { lockId: LOCK_ID }, transaction, type: QueryTypes.SELECT }
              );
              if (!locked) throw new Error('另一个名称批次正在修改，请稍后重试');
              await db.query(
                "SELECT set_config('apple.product_name_batch',:batchId,true),set_config('apple.product_name_source','historical_batch',true)",
                { replacements: { batchId }, transaction }
              );
              for (const row of candidates) {
                // 传回原始 JSON，让数据库触发器执行并审计；CAS 拒绝覆盖并发修改。
                const [updated] = await db.query(
                  `UPDATE ${table} SET ${field}=CAST(:value AS jsonb) WHERE id::text=:id AND ${field}=CAST(:value AS jsonb) RETURNING ${field} AS value`,
                  { replacements: { id: row.id, value: JSON.stringify(row.value) }, transaction }
                );
                // orders 触发器对相同 JSON 仍须显式执行历史转换。
                if (!updated.length) report.conflicts++;
                else if (!isDeepStrictEqual(updated[0].value, row.next)) {
                  report.ruleMismatches++;
                  throw new Error(`JS/数据库规范规则不一致：${table}/${row.id}`);
                } else report.changed++;
              }
            } catch (error) {
              logger.debug('商品名称批次事务未完成', { code: error.code || error.name });
              throw error;
            }
          });
        }
        cursor = rows[rows.length - 1].id;
      }
    }
    report.after = await protectedSnapshot(db);
    report.protectedUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
    return report;
  } catch (error) {
    logger.debug('商品名称批处理未完成', { code: error.code || error.name });
    throw error;
  }
}
module.exports = { runProductNameBatch, protectedSnapshot };
