const { isDeepStrictEqual } = require('util');
const { hash, fault } = require('../../src/services/officialOrderSupport');
const { deriveOfficialPickupDate } = require('../../src/services/officialPickupDate');

const CASE_ORDER_ID = 605;
const CASE_RUN_ID = 47;
const CASE_BODY_HASH = '67ac30a975598bd02dfe0ddf0932f8bdaa68ceb082f60fa72a6d2ecc821ea6b0';
const CASE_OBSERVED_AT = '2026-10-03T17:06:42.294Z';
const SHA256 = /^[a-f0-9]{64}$/;
const MD5 = /^[a-f0-9]{32}$/;

function validatePayload(payload) {
  const source = payload?.sourceResult;
  const date = deriveOfficialPickupDate(source, CASE_OBSERVED_AT).date;
  if (
    payload?.version !== 1 ||
    payload.kind !== 'VERIFIED_LEGACY_PICKUP_DATE' ||
    payload.orderId !== CASE_ORDER_ID ||
    payload.sourceRunId !== CASE_RUN_ID ||
    payload.sourceBodySha256 !== CASE_BODY_HASH ||
    payload.sourceObservedAt !== CASE_OBSERVED_AT ||
    !SHA256.test(payload.planSha256 || '') ||
    !SHA256.test(payload.proofSha256 || '') ||
    !MD5.test(payload.priorHttpAfterHash || '') ||
    !/^W\d{10}$/.test(payload.orderNumber || '') ||
    source?.orderNumber !== payload.orderNumber ||
    source.identityMatched !== true ||
    source.sourceModel !== 'orderDetail' ||
    source.completeItemCount !== source.products?.length ||
    !date ||
    payload.proposedDate !== date
  )
    throw fault('HISTORICAL_DATE_PAYLOAD_INVALID');
  return hash(JSON.stringify(payload));
}

async function snapshot(client, payload, lock) {
  try {
    const { rows } = await client.query(
      `SELECT to_jsonb(o) AS snapshot, actual_pickup_date::text AS date,
       md5(to_jsonb(o)::text) AS hash,
       (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb)
        FROM pickup_devices d WHERE d.order_id=o.id) AS devices
       FROM orders o WHERE id=$1 AND order_number=$2 AND email_order_status='picked_up'
       ${lock ? 'FOR UPDATE' : ''}`,
      [payload.orderId, payload.orderNumber]
    );
    if (rows.length !== 1) throw fault('HISTORICAL_DATE_ORDER_CHANGED');
    return rows[0];
  } catch (error) {
    error.component = 'historicalDateSnapshot';
    throw error;
  }
}

/**
 * 消费独立核验器的历史605/run47证据，只填空日期；不接收外部API输入。
 * 宿主调用者须持三锁、保存STOP及意图，并在成功后独立核验变更链。
 * @param {object} client 已连接的业务PostgreSQL客户端。
 * @param {object} payload 原文核验后生成并持久化的载荷。
 * @param {object} options mode=dry-run/apply，apply必须传入已保存preview。
 * @returns {Promise<object>} 私密前后快照和提交审计，禁止原样展示。
 */
async function applyHistoricalDate(client, payload, { mode, preview } = {}) {
  let transactionStarted = false;
  let commitStarted = false;
  try {
    const payloadSha256 = validatePayload(payload);
    if (!['dry-run', 'apply'].includes(mode)) throw fault('HISTORICAL_DATE_MODE_INVALID');
    if (
      mode === 'apply' &&
      (preview?.version !== 1 ||
        preview.mode !== 'dry-run' ||
        preview.orderId !== payload.orderId ||
        preview.payloadSha256 !== payloadSha256 ||
        preview.beforeHash !== payload.priorHttpAfterHash ||
        preview.previousDate !== null ||
        preview.proposedDate !== payload.proposedDate ||
        preview.businessWrites !== 0 ||
        preview.dateFilled !== false)
    )
      throw fault('HISTORICAL_DATE_PREVIEW_INVALID');
    await client.query(mode === 'apply' ? 'BEGIN' : 'BEGIN READ ONLY');
    transactionStarted = true;
    await client.query("SET LOCAL statement_timeout='8s'");
    await client.query("SET LOCAL TIME ZONE 'Asia/Shanghai'");
    const before = await snapshot(client, payload, mode === 'apply');
    if (before.date !== null || before.hash !== payload.priorHttpAfterHash)
      throw fault('HISTORICAL_DATE_ORDER_CHANGED');
    if (
      mode === 'apply' &&
      (!isDeepStrictEqual(before.snapshot, preview.beforeSnapshot) ||
        !isDeepStrictEqual(before.devices, preview.devices))
    )
      throw fault('HISTORICAL_DATE_PREVIEW_CHANGED');
    const result = {
      version: 1,
      mode,
      orderId: payload.orderId,
      payloadSha256,
      proofSha256: payload.proofSha256,
      beforeHash: before.hash,
      afterHash: before.hash,
      previousDate: null,
      proposedDate: payload.proposedDate,
      dateFilled: false,
      businessWrites: 0,
      beforeSnapshot: before.snapshot,
      afterSnapshot: before.snapshot,
      devices: before.devices,
      devicesHash: hash(JSON.stringify(before.devices)),
    };
    if (mode === 'apply') {
      const updated = await client.query(
        'UPDATE orders SET actual_pickup_date=$1::date WHERE id=$2 AND actual_pickup_date IS NULL',
        [payload.proposedDate, payload.orderId]
      );
      if (updated.rowCount !== 1) throw fault('HISTORICAL_DATE_WRITE_COUNT_INVALID');
      const after = await snapshot(client, payload, false);
      if (
        after.date !== payload.proposedDate ||
        after.hash === before.hash ||
        !isDeepStrictEqual(after.snapshot, {
          ...before.snapshot,
          ['actual_pickup_date']: payload.proposedDate,
        }) ||
        !isDeepStrictEqual(after.devices, before.devices)
      )
        throw fault('HISTORICAL_DATE_AFTER_CHANGED');
      Object.assign(result, {
        afterHash: after.hash,
        afterSnapshot: after.snapshot,
        dateFilled: true,
        businessWrites: 1,
      });
      commitStarted = true;
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
    return result;
  } catch (error) {
    error.rollbackConfirmed = !transactionStarted;
    if (transactionStarted && !commitStarted) {
      try {
        await client.query('ROLLBACK');
        error.rollbackConfirmed = true;
      } catch (_rollbackError) {
        error.rollbackConfirmed = false;
      }
    }
    if (commitStarted) error.rollbackConfirmed = false;
    error.component = 'historicalDateApply';
    throw error;
  }
}

module.exports = { applyHistoricalDate };
