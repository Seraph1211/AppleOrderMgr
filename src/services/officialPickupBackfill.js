const { validateOfficialStatusResult } = require('./officialOrderStatusSync');
const { deriveOfficialPickupDate } = require('./officialPickupDate');
const { fault } = require('./officialOrderSupport');

const CUTOFF = '2026-09-23';
const MAX_BATCH_AGE_MS = 86400000;
const FULL_SCOPE_VERSION = 2;
const MISSING_SCOPE_VERSION = 3;
const PROXY_541_LIMIT = 3;
const FREEZE_PAGE_SIZE = 50;

function missingScope(plan) {
  return (
    plan?.schemaVersion === MISSING_SCOPE_VERSION &&
    plan.scope === 'missing-fields' &&
    plan.cutoff === null &&
    plan.policy?.loginCooldown === true &&
    plan.policy?.apiHealthCheck === true &&
    plan.policy?.proxy541Limit === PROXY_541_LIMIT
  );
}

function fullScope(plan) {
  return (
    plan?.schemaVersion === FULL_SCOPE_VERSION &&
    plan.scope === 'all-picked-up' &&
    plan.cutoff === null
  );
}

function validScope(plan) {
  return missingScope(plan) || fullScope(plan) || (!plan?.scope && plan?.cutoff === CUTOFF);
}

function validMissingEntry(entry) {
  return (
    typeof entry?.dateMissing === 'boolean' &&
    typeof entry.serialsMissing === 'boolean' &&
    (entry.dateMissing || entry.serialsMissing) &&
    Array.isArray(entry.previousDevices)
  );
}

/** 固化用户批准的补录范围，只读返回身份、账号摘要与原行校验值。 */
async function freezePickupBackfill(client, { allPickedUp = false, missingFields = false } = {}) {
  try {
    if (allPickedUp && missingFields) throw fault('BACKFILL_SCOPE_INVALID');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='8s'");
    const backupFields = missingFields
      ? `, actual_pickup_date::text AS "previousDate",
         official_raw_status AS "previousOfficialStatus",
         official_status_observed_at AS "previousObservedAt",
         actual_pickup_date IS NULL AS "dateMissing",
         NOT EXISTS (SELECT 1 FROM pickup_devices d WHERE d.order_id=o.id) AS "serialsMissing",
         (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb)
          FROM pickup_devices d WHERE d.order_id=o.id) AS "previousDevices"`
      : '';
    const predicate = missingFields
      ? `AND (actual_pickup_date IS NULL OR
          NOT EXISTS (SELECT 1 FROM pickup_devices d WHERE d.order_id=o.id))`
      : allPickedUp
        ? ''
        : 'AND email_pickup_date<$1 AND actual_pickup_date IS NULL';
    const rows = [];
    let lastId = 0;
    for (;;) {
      const values = allPickedUp || missingFields ? [lastId] : [CUTOFF, lastId];
      const page = await client.query(
        `SELECT id,order_number AS "orderNumber",md5(lower(btrim(apple_id))) AS "accountKey",
         md5((to_jsonb(o)-'actual_pickup_date')::text) AS "rowHash" ${backupFields}
       FROM orders o WHERE email_order_status='picked_up'
         ${predicate} AND o.id>$${values.length} ORDER BY id LIMIT ${FREEZE_PAGE_SIZE}`,
        values
      );
      rows.push(...page.rows);
      if (page.rows.length < FREEZE_PAGE_SIZE) break;
      lastId = page.rows[page.rows.length - 1].id;
    }
    const scope = {};
    if (allPickedUp) {
      scope.schemaVersion = FULL_SCOPE_VERSION;
      scope.scope = 'all-picked-up';
      scope.policy = {
        loginCooldown: false,
        apiHealthCheck: false,
        proxy541Limit: PROXY_541_LIMIT,
      };
    }
    if (missingFields) {
      scope.schemaVersion = MISSING_SCOPE_VERSION;
      scope.scope = 'missing-fields';
      scope.policy = { loginCooldown: true, apiHealthCheck: true, proxy541Limit: PROXY_541_LIMIT };
    }
    return {
      startedAt: new Date().toISOString(),
      cutoff: allPickedUp || missingFields ? null : CUTOFF,
      ...scope,
      entries: rows,
    };
  } catch (error) {
    error.component = 'officialPickupBackfill';
    throw error;
  } finally {
    await client.query('ROLLBACK');
  }
}

/** 从原始冻结计划派生状态同步校验值；不改范围、期限或原始摘要。 */
async function preparePickupStatusPlan(client, plan) {
  try {
    if (
      !validScope(plan) ||
      !Number.isFinite(Date.parse(plan?.startedAt)) ||
      Date.parse(plan.startedAt) > Date.now() ||
      Date.now() - Date.parse(plan.startedAt) > MAX_BATCH_AGE_MS ||
      !Array.isArray(plan.entries) ||
      !plan.entries.length ||
      (missingScope(plan) && plan.entries.some(entry => !validMissingEntry(entry)))
    )
      throw fault('BACKFILL_SCOPE_INVALID');
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(
      `SELECT id,md5((to_jsonb(o)-'actual_pickup_date')::text) AS hash,
       md5((to_jsonb(o)-ARRAY['actual_pickup_date','official_raw_status','official_status_observed_at'])::text) AS stable
       FROM orders o WHERE id=ANY($1::int[])`,
      [plan.entries.map(entry => entry.id)]
    );
    const records = new Map(rows.map(row => [row.id, row]));
    const entries = plan.entries.map(entry => {
      const row = records.get(entry.id);
      if (!row || row.hash !== entry.rowHash) throw fault('BACKFILL_ORDER_CHANGED');
      return { ...entry, stableRowHash: row.stable };
    });
    return { ...plan, statusSync: true, entries };
  } catch (error) {
    error.component = 'officialPickupBackfill';
    throw error;
  } finally {
    await client.query('ROLLBACK');
  }
}

/** 校验本轮官网证据，按冻结计划填空或刷新日期；不改邮件状态和 updated_at。 */
async function applyPickupBackfill(client, plan, entry, result) {
  const observed = Date.parse(result?.source?.observedAt);
  const started = Date.parse(plan?.startedAt);
  if (
    !validScope(plan) ||
    !Number.isFinite(started) ||
    !Number.isFinite(observed) ||
    (missingScope(plan) && !validMissingEntry(entry)) ||
    observed < started ||
    observed > Date.now() ||
    Date.now() - started > MAX_BATCH_AGE_MS ||
    !plan.entries?.some(
      item =>
        item.id === entry?.id &&
        item.rowHash === entry.rowHash &&
        item.stableRowHash === entry.stableRowHash &&
        item.orderNumber === entry.orderNumber
    )
  )
    throw fault('BACKFILL_SCOPE_INVALID');
  // 此入口消费同一授权批次的已加密保存证据，可在发布后回写；不接收历史批次或缓存观测。
  const checked = validateOfficialStatusResult(
    result,
    {
      orderId: entry.id,
      orderNumber: entry.orderNumber,
      startedAt: plan.startedAt,
    },
    observed
  );
  const syncStatus = plan.statusSync === true;
  const refreshDate = fullScope(plan) || missingScope(plan);
  if (refreshDate && !syncStatus) throw fault('BACKFILL_SCOPE_INVALID');
  if (syncStatus && !/^[a-f0-9]{32}$/.test(entry.stableRowHash || ''))
    throw fault('BACKFILL_SCOPE_INVALID');
  const hashSql = syncStatus
    ? "md5((to_jsonb(o)-ARRAY['actual_pickup_date','official_raw_status','official_status_observed_at'])::text)"
    : "md5((to_jsonb(o)-'actual_pickup_date')::text)";
  const expectedHash = syncStatus ? entry.stableRowHash : entry.rowHash;
  if (!checked.actualPickupDate && !syncStatus)
    return {
      orderId: entry.id,
      outcome: deriveOfficialPickupDate(result, result.source.observedAt).reason,
    };
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='8s'");
    const { rows } = await client.query(
      `SELECT actual_pickup_date::text AS date,official_raw_status AS status,official_status_observed_at AS observed,${hashSql} AS hash
       FROM orders o WHERE id=$1 AND order_number=$2 AND email_order_status='picked_up'
         ${refreshDate ? '' : 'AND email_pickup_date<$3'} FOR UPDATE`,
      refreshDate ? [entry.id, entry.orderNumber] : [entry.id, entry.orderNumber, CUTOFF]
    );
    if (!rows.length || rows[0].hash !== expectedHash) throw fault('BACKFILL_ORDER_CHANGED');
    if (rows[0].date && !syncStatus) {
      await client.query('ROLLBACK');
      return { orderId: entry.id, outcome: 'ALREADY_HAS_DATE' };
    }
    const statusSaved =
      syncStatus && (!rows[0].observed || new Date(rows[0].observed).getTime() <= observed);
    const expectedDate = refreshDate
      ? statusSaved && checked.actualPickupDate
        ? checked.actualPickupDate
        : rows[0].date
      : rows[0].date || checked.actualPickupDate;
    if (syncStatus) {
      await client.query(
        `UPDATE orders SET actual_pickup_date=${
          refreshDate
            ? 'CASE WHEN $4 AND $1::date IS NOT NULL THEN $1::date ELSE actual_pickup_date END'
            : 'coalesce(actual_pickup_date,$1::date)'
        },
         official_raw_status=CASE WHEN $4 THEN $2 ELSE official_raw_status END,
         official_status_observed_at=CASE WHEN $4 THEN $3::timestamptz ELSE official_status_observed_at END
         WHERE id=$5`,
        [checked.actualPickupDate, checked.status, checked.observedAt, statusSaved, entry.id]
      );
    } else {
      await client.query('UPDATE orders SET actual_pickup_date=$1 WHERE id=$2', [
        checked.actualPickupDate,
        entry.id,
      ]);
    }
    const { rows: after } = await client.query(
      `SELECT actual_pickup_date::text AS date,official_raw_status AS status,official_status_observed_at AS observed,${hashSql} AS hash
       FROM orders o WHERE id=$1`,
      [entry.id]
    );
    if (
      after[0].hash !== expectedHash ||
      after[0].date !== expectedDate ||
      (statusSaved &&
        (after[0].status !== checked.status || new Date(after[0].observed).getTime() !== observed))
    )
      throw fault('BACKFILL_INVARIANCE_FAILED');
    await client.query('COMMIT');
    return {
      orderId: entry.id,
      outcome:
        rows[0].date && rows[0].date !== after[0].date
          ? 'UPDATED'
          : rows[0].date
            ? 'ALREADY_HAS_DATE'
            : checked.actualPickupDate
              ? 'FILLED'
              : deriveOfficialPickupDate(result, result.source.observedAt).reason,
      date: after[0].date,
      previousDate: rows[0].date,
      dateVerified:
        !!checked.actualPickupDate && after[0].date === checked.actualPickupDate && statusSaved,
      statusSaved,
      ...(statusSaved
        ? { officialRawStatus: checked.status, officialStatusObservedAt: checked.observedAt }
        : {}),
      beforeHash: expectedHash,
      afterHash: after[0].hash,
      runId: checked.runId,
      sha256: checked.sha256,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    error.component = 'officialPickupBackfill';
    throw error;
  }
}

module.exports = { freezePickupBackfill, preparePickupStatusPlan, applyPickupBackfill };
