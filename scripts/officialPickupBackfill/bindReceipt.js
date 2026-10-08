/* global PAYLOAD */
const db = require('./src/models');
const { create } = require('./src/controllers/pickupDeviceController');
const { getEffectivePermissions } = require('./src/services/permissionService');
const { Op } = require('sequelize');
const crypto = require('crypto');
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pickRecord = value =>
  value &&
  Object.fromEntries(
    ['status', 'pickedUpAt', 'settlementAmount', 'settlementPerson', 'notes'].map(k => [
      k,
      value[k],
    ])
  );
const pickUnit = value =>
  value &&
  Object.fromEntries(
    Object.entries(value).filter(([k]) => !['version', 'updatedAt', 'updatedBy'].includes(k))
  );
async function main(payload) {
  const bound = [];
  try {
    const { entry, receipt, parsed } = payload;
    const allPickedUp =
      payload.scope === 'all-picked-up' && payload.schemaVersion === 2 && payload.cutoff === null;
    const missingFields =
      payload.scope === 'missing-fields' &&
      payload.schemaVersion === 3 &&
      payload.cutoff === null &&
      typeof entry.dateMissing === 'boolean' &&
      typeof entry.serialsMissing === 'boolean' &&
      (entry.dateMissing || entry.serialsMissing) &&
      Array.isArray(entry.previousDevices);
    const withoutCutoff = allPickedUp || missingFields;
    if (
      (!withoutCutoff && (payload.scope || payload.cutoff !== '2026-09-23')) ||
      !Number.isFinite(Date.parse(payload.startedAt)) ||
      Date.parse(payload.startedAt) > Date.now() ||
      Date.now() - Date.parse(payload.startedAt) > 86400000 ||
      parsed.orderNumber !== entry.orderNumber ||
      receipt.orderNumber !== entry.orderNumber ||
      receipt.status !== 200 ||
      !receipt.egressVerifiedAfter
    )
      throw Error('SCOPE_INVALID');
    const serials = parsed.items.map(item => item.serialNumber);
    if (
      !serials.length ||
      new Set(serials).size !== serials.length ||
      serials.some(s => !/^(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/.test(s))
    )
      throw Error('SERIALS_INVALID');
    const user = await db.User.findOne({
      where: { username: 'admin', role: 'admin', status: 'active' },
    });
    if (!user) throw Error('ACTOR_INVALID');
    const permissions = await getEffectivePermissions(user);
    if (!['orders.read', 'pickups.read', 'pickups.edit'].every(p => permissions.includes(p)))
      throw Error('PERMISSION_DENIED');
    const before = await snapshot(entry.id, serials);
    if (
      (entry.stableRowHash
        ? before.order.stableHash !== entry.stableRowHash
        : before.order.hash !== entry.rowHash) ||
      before.order.orderNumber !== entry.orderNumber ||
      before.order.status !== 'picked_up' ||
      (!withoutCutoff && before.order.pickupDate >= payload.cutoff)
    )
      throw Error('ORDER_CHANGED');
    if (
      before.devices.some(
        device => device.orderId !== entry.id || !serials.includes(device.serialNumber)
      )
    )
      throw Error('DEVICE_BINDING_CONFLICT');
    if (before.units.some(unit => unit.orderNumberText)) throw Error('STOCK_SOURCE_TEXT_PRESENT');
    for (const serial of serials) {
      if (before.devices.some(device => device.serialNumber === serial && device.stockUnitId))
        continue;
      let response;
      const res = {
        setHeader() {},
        status() {
          return this;
        },
        json(value) {
          response = value;
        },
      };
      await create({ user, params: { orderId: entry.id }, body: { serialBarcode: serial } }, res);
      if (
        !response?.success ||
        response.data.device.orderId !== entry.id ||
        response.data.device.serialNumber !== serial
      )
        throw Error('BIND_RESPONSE_INVALID');
      if (!response.data.alreadyBound) bound.push(response.data.device.id);
    }
    const after = await snapshot(entry.id, serials);
    if (
      after.order.fullHash !== before.order.fullHash ||
      after.devices.length !== serials.length ||
      after.devices.some(
        device => device.orderId !== entry.id || !serials.includes(device.serialNumber)
      ) ||
      (before.record && sha(pickRecord(before.record)) !== sha(pickRecord(after.record))) ||
      (!before.record &&
        (after.record.status !== 'pending' ||
          after.record.pickedUpAt ||
          after.record.settlementAmount))
    )
      throw Error('READBACK_MISMATCH');
    for (const unit of after.units) {
      const old = before.units.find(item => item.id === unit.id);
      if (
        old
          ? sha(pickUnit(old)) !== sha(pickUnit(unit))
          : unit.state !== 'registered' ||
            unit.firstReceivedAt ||
            unit.officialCostAmount ||
            unit.originMode !== 'legacy_binding'
      )
        throw Error('STOCK_INVARIANCE_FAILED');
    }
    process.stdout.write(
      JSON.stringify({
        orderId: entry.id,
        outcome: 'SERIALS_VERIFIED',
        serialCount: serials.length,
        newBindings: bound.length,
        serialsHash: sha([...serials].sort()),
        deviceIds: after.devices.map(d => d.id),
        actorUserId: user.id,
        receiptRunId: receipt.runId,
        receiptSha256: receipt.sha256,
        detailSha256: receipt.detailSha256,
        orderBeforeHash: before.order.fullHash,
        orderAfterHash: after.order.fullHash,
        manualPickupUnchanged: true,
        inventoryReceiveCreated: false,
      })
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        orderId: payload?.entry?.id,
        outcome: /^[A-Z_0-9]+$/.test(error.code || error.message)
          ? error.code || error.message
          : 'BIND_FAILED',
        newBindings: bound.length,
      })
    );
    process.exitCode = 1;
  } finally {
    await db.sequelize.close();
  }
}
async function snapshot(orderId, serials) {
  try {
    return await db.sequelize.transaction(async transaction => {
      await db.sequelize.query("SET LOCAL TIME ZONE 'Asia/Shanghai'", { transaction });
      const [rows] = await db.sequelize.query(
        'SELECT order_number AS "orderNumber", email_order_status AS status,email_pickup_date::text AS "pickupDate",md5((to_jsonb(o)-\'actual_pickup_date\')::text) AS hash,md5((to_jsonb(o)-ARRAY[\'actual_pickup_date\',\'official_raw_status\',\'official_status_observed_at\'])::text) AS "stableHash",md5(to_jsonb(o)::text) AS "fullHash" FROM orders o WHERE id=:id',
        { replacements: { id: orderId }, transaction }
      );
      if (rows.length !== 1) throw Error('ORDER_MISSING');
      return {
        order: rows[0],
        record: await db.PickupRecord.findOne({ where: { orderId }, raw: true, transaction }),
        devices: await db.PickupDevice.findAll({
          where: { [Op.or]: [{ orderId }, { serialNumber: { [Op.in]: serials } }] },
          raw: true,
          transaction,
        }),
        units: await db.StockUnit.findAll({
          where: { serialNumber: { [Op.in]: serials } },
          raw: true,
          transaction,
        }),
      };
    });
  } catch (error) {
    error.component = 'receiptBindingSnapshot';
    throw error;
  }
}
main(PAYLOAD).catch(() => {
  process.exitCode = 1;
});
