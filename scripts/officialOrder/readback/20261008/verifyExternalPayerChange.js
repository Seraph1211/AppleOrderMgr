const { isDeepStrictEqual } = require('util');

const PAYER_IDS = [220, 298, 366, 403, 677, 1113, 300, 301, 806, 1114];
const HASH_PATTERN = /^[a-f0-9]{32}$/;

/** 核验固定付款变更证明；原整行、付款事件和设备均由当前数据库重算。 */
async function verifyExternalPayerRecord(client, record, allowLaterHttp = false) {
  try {
    const r = record;
    if (
      !PAYER_IDS.includes(r?.id) ||
      r.entry?.id !== r.id ||
      r.kind !== (r.id === 1113 ? 'ORIGINAL' : 'AFTER_HTTP') ||
      ['beforeHash', 'acceptedFullHash', 'acceptedStableHash', 'acceptedOriginalHash'].some(
        key => !HASH_PATTERN.test(r[key] || '')
      ) ||
      !r.acceptedSnapshot ||
      !r.beforePayer ||
      !r.payerEvent ||
      !Array.isArray(r.devices) ||
      (allowLaterHttp && r.id !== 1113) ||
      r.acceptedSnapshot.payer_version !== r.beforePayer.payer_version + 1 ||
      r.payerEvent.before_version !== r.beforePayer.payer_version ||
      r.payerEvent.after_version !== r.acceptedSnapshot.payer_version ||
      r.payerEvent.order_id !== r.id
    )
      throw new Error('HTTP_APPLY_PAYER_CHANGE_INVALID');
    const b = r.beforePayer;
    const { rows } = await client.query(
      `WITH current_row AS (
         SELECT to_jsonb(o) AS live,
           (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb)
            FROM pickup_devices d WHERE d.order_id=o.id) AS devices
         FROM orders o WHERE id=$1 AND order_number=$2 AND email_order_status='picked_up'
       ), normalized AS (
         SELECT live,devices,live||jsonb_build_object(
           'actual_pickup_date',($3::jsonb->>'actual_pickup_date')::date,
           'official_raw_status',$3::jsonb->>'official_raw_status',
           'official_status_observed_at',($3::jsonb->>'official_status_observed_at')::timestamptz
         ) AS accepted FROM current_row
       ) SELECT
         md5(accepted::text) AS accepted_hash,
         md5((accepted-'actual_pickup_date')::text) AS original_hash,
         md5((live-ARRAY['actual_pickup_date','official_raw_status','official_status_observed_at'])::text) AS stable_hash,
         md5(((accepted||jsonb_build_object('payer_name',$4::text,'payer_version',$5::integer,
           'updated_at',$6::timestamptz))-CASE WHEN $7='ORIGINAL' THEN ARRAY['actual_pickup_date']::text[]
           ELSE ARRAY[]::text[] END)::text) AS reconstructed_hash,
         accepted=$3::jsonb AS snapshot_equal,
         live=accepted AS no_later_http,
         devices=$8::jsonb AS devices_equal,
         (SELECT count(*)=1 AND bool_and(to_jsonb(e)=$9::jsonb)
          FROM order_payer_events e WHERE e.order_id=$1 AND e.after_version>$5::integer) AS event_equal
       FROM normalized`,
      [
        r.id,
        r.entry.orderNumber,
        JSON.stringify(r.acceptedSnapshot),
        b.payer_name,
        b.payer_version,
        b.updated_at,
        r.kind,
        JSON.stringify(r.devices),
        JSON.stringify(r.payerEvent),
      ]
    );
    if (
      rows.length !== 1 ||
      rows[0].accepted_hash !== r.acceptedFullHash ||
      rows[0].original_hash !== r.acceptedOriginalHash ||
      rows[0].stable_hash !== r.acceptedStableHash ||
      rows[0].reconstructed_hash !== r.beforeHash ||
      rows[0].snapshot_equal !== true ||
      rows[0].devices_equal !== true ||
      rows[0].event_equal !== true ||
      (!allowLaterHttp && rows[0].no_later_http !== true)
    )
      throw new Error('HTTP_APPLY_PAYER_CHANGE_INVALID');
    return true;
  } catch (error) {
    error.code = 'HTTP_APPLY_PAYER_CHANGE_INVALID';
    throw error;
  }
}

/** 只为尚未写入的1113建立附加basis；原计划身份及证据摘要保持。 */
function buildExternalPayerBasis(record, payload, previousBasis = null) {
  if (
    record?.id !== 1113 ||
    record.kind !== 'ORIGINAL' ||
    !isDeepStrictEqual(record.entry, payload?.entry) ||
    !Number.isSafeInteger(payload?.result?.source?.runId) ||
    !/^[a-f0-9]{64}$/.test(payload?.evidence?.auditSha256 || '')
  )
    throw new Error('HTTP_APPLY_PAYER_CHANGE_INVALID');
  const basis = {
    version: 1,
    planSha256: payload.planSha256,
    orderId: record.id,
    originalRowHash: record.entry.rowHash,
    runId: payload.result.source.runId,
    auditSha256: payload.evidence.auditSha256,
    stableRowHash: record.acceptedStableHash,
  };
  if (previousBasis && !isDeepStrictEqual(previousBasis, basis))
    throw new Error('HTTP_APPLY_PAYER_CHANGE_INVALID');
  return basis;
}

module.exports = { verifyExternalPayerRecord, buildExternalPayerBasis };
