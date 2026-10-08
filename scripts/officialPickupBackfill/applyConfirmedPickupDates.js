const { isDeepStrictEqual } = require('util');
const { hash, fault } = require('../../src/services/officialOrderSupport');

const CASES = [
  [1093, 'W1553961157', '2026-09-27', 1417, '2026年9月28日'],
  [1094, 'W1458808592', '2026-09-27', 1419, '2026年9月28日'],
  [1099, 'W1439008871', '2026-09-28', 1421, '2026年9月29日'],
  [1183, 'W1493825639', '2026-09-29', 1476, '2026年9月30日'],
];
const AUTHORIZATION = '这4单按照原样保存即可';

function validate(payload) {
  if (
    payload?.version !== 1 ||
    payload.authorization !== AUTHORIZATION ||
    !/^[a-f0-9]{64}$/.test(payload.planSha256 || '') ||
    !Array.isArray(payload.entries) ||
    payload.entries.length !== CASES.length
  )
    throw fault('CONFIRMED_DATE_PAYLOAD_INVALID');
  for (const [index, [id, orderNumber, date, runId, placed]] of CASES.entries()) {
    const entry = payload.entries[index];
    const source = entry?.sourceResult;
    if (
      entry?.orderId !== id ||
      entry.orderNumber !== orderNumber ||
      entry.proposedDate !== date ||
      entry.runId !== runId ||
      !/^[a-f0-9]{32}$/.test(entry.priorHttpAfterHash || '') ||
      source?.orderNumber !== orderNumber ||
      source.identityMatched !== true ||
      source.sourceModel !== 'orderDetail' ||
      source.orderPlacedDateText !== placed ||
      source.source?.runId !== runId ||
      !/^[a-f0-9]{64}$/.test(source.source?.sha256 || '') ||
      source.completeItemCount !== 2 ||
      source.products?.length !== 2 ||
      source.products.some(
        item =>
          item.quantity !== 1 ||
          item.rawStatus !== 'PICKED_UP' ||
          item.pickupDateText?.replace(/\s/g, '').replace(/日$/, '') !==
            `已取货9月${Number(date.slice(-2))}`
      )
    )
      throw fault('CONFIRMED_DATE_PAYLOAD_INVALID');
  }
  return hash(JSON.stringify(payload));
}

async function readRows(client, entries, lock) {
  try {
    const { rows } = await client.query(
      `SELECT id,to_jsonb(o) AS snapshot,
      md5(to_jsonb(o)::text) AS hash,
      (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb)
       FROM pickup_devices d WHERE d.order_id=o.id) AS devices
      FROM orders o WHERE id=ANY($1::int[]) ORDER BY id ${lock ? 'FOR UPDATE' : ''}`,
      [entries.map(entry => entry.orderId)]
    );
    if (rows.length !== entries.length) throw fault('CONFIRMED_DATE_ORDER_CHANGED');
    return rows;
  } catch (error) {
    error.component = 'confirmedDateRead';
    throw error;
  }
}

/** 仅接受用户明确确认的四笔原文日期，同事务填空；宿主须持锁并保存持久提交意图。 */
async function applyConfirmedPickupDates(client, payload, { mode, preview } = {}) {
  let started = false;
  let commitStarted = false;
  try {
    const payloadSha256 = validate(payload);
    if (!['dry-run', 'apply'].includes(mode)) throw fault('CONFIRMED_DATE_MODE_INVALID');
    if (
      mode === 'apply' &&
      (preview?.mode !== 'dry-run' ||
        preview.businessWrites !== 0 ||
        preview.payloadSha256 !== payloadSha256 ||
        preview.rows?.length !== CASES.length)
    )
      throw fault('CONFIRMED_DATE_PREVIEW_INVALID');
    await client.query(mode === 'apply' ? 'BEGIN' : 'BEGIN READ ONLY');
    started = true;
    await client.query("SET LOCAL statement_timeout='8s'");
    await client.query("SET LOCAL TIME ZONE 'Asia/Shanghai'");
    const before = await readRows(client, payload.entries, mode === 'apply');
    for (const [index, row] of before.entries()) {
      const entry = payload.entries[index];
      if (
        row.id !== entry.orderId ||
        row.hash !== entry.priorHttpAfterHash ||
        row.snapshot.order_number !== entry.orderNumber ||
        row.snapshot.email_order_status !== 'picked_up' ||
        row.snapshot.official_raw_status !== 'PICKED_UP' ||
        row.snapshot.actual_pickup_date !== null ||
        (mode === 'apply' &&
          (!isDeepStrictEqual(row.snapshot, preview.rows[index].beforeSnapshot) ||
            !isDeepStrictEqual(row.devices, preview.rows[index].devices)))
      )
        throw fault('CONFIRMED_DATE_ORDER_CHANGED');
    }
    if (mode === 'apply') {
      for (const entry of payload.entries) {
        const result = await client.query(
          'UPDATE orders SET actual_pickup_date=$1::date WHERE id=$2 AND actual_pickup_date IS NULL',
          [entry.proposedDate, entry.orderId]
        );
        if (result.rowCount !== 1) throw fault('CONFIRMED_DATE_WRITE_COUNT_INVALID');
      }
    }
    const after = mode === 'apply' ? await readRows(client, payload.entries, false) : before;
    const rows = before.map((row, index) => {
      const expected = { ...row.snapshot };
      if (mode === 'apply') expected['actual_pickup_date'] = payload.entries[index].proposedDate;
      if (
        !isDeepStrictEqual(after[index].snapshot, expected) ||
        !isDeepStrictEqual(after[index].devices, row.devices)
      )
        throw fault('CONFIRMED_DATE_AFTER_CHANGED');
      return {
        orderId: row.id,
        beforeHash: row.hash,
        afterHash: after[index].hash,
        beforeSnapshot: row.snapshot,
        afterSnapshot: after[index].snapshot,
        devices: row.devices,
        devicesHash: hash(JSON.stringify(row.devices)),
        proposedDate: payload.entries[index].proposedDate,
      };
    });
    if (mode === 'apply') {
      commitStarted = true;
      await client.query('COMMIT');
    } else await client.query('ROLLBACK');
    return {
      version: 1,
      mode,
      payloadSha256,
      businessWrites: mode === 'apply' ? CASES.length : 0,
      rows,
    };
  } catch (error) {
    error.rollbackConfirmed = !started;
    if (started && !commitStarted) {
      try {
        await client.query('ROLLBACK');
        error.rollbackConfirmed = true;
      } catch (_) {
        error.rollbackConfirmed = false;
      }
    }
    if (commitStarted) error.rollbackConfirmed = false;
    error.component = 'confirmedDateApply';
    throw error;
  }
}

module.exports = { applyConfirmedPickupDates };
