/* eslint-disable no-magic-numbers -- 隔离 PostgreSQL 集成验收的合成样本。 */
const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
const {
  bindOfficialReceipt,
  reconcileOfficialReceipt,
  deviceSetHash,
} = require('../src/services/officialReceiptBinding');

/** 只对指定的空白验收库执行；使用生产同版模型、服务和 schema，不执行 sync。 */
async function main() {
  let db;
  try {
    if (
      process.env.DB_NAME !== 'receipt_binding_test' ||
      process.env.DB_HOST !== 'receipt-binding-test-db'
    )
      throw new Error('ISOLATED_DATABASE_REQUIRED');
    const runtime = process.env.RECEIPT_TEST_RUNTIME;
    db = require(path.join(runtime, 'src/models'));
    const deps = {
      db,
      Op: require('sequelize').Op,
      stock: require(path.join(runtime, 'src/services/stockCommandService')),
      units: require(path.join(runtime, 'src/services/stockUnitService')),
      getEffectivePermissions: require(path.join(runtime, 'src/services/permissionService'))
        .getEffectivePermissions,
    };
    const user = await db.User.create({
      username: 'receipt_test_' + Date.now(),
      password: crypto.randomBytes(24).toString('hex'),
      role: 'admin',
      status: 'active',
    });
    let counter = 0;
    const prefix = String(Date.now()).slice(-7);
    const fixture = async () => {
      try {
        counter += 1;
        const order = await db.Order.create({
          orderNumber: 'W' + prefix + String(counter).padStart(3, '0'),
          products: [{ name: 'TEST PHONE', quantity: 2 }],
          emailOrderStatus: 'picked_up',
          actualPickupDate: '2026-10-01',
        });
        const [rows] = await db.sequelize.query(
          'SELECT md5(to_jsonb(o)::text) AS hash FROM orders o WHERE id=:id',
          { replacements: { id: order.id } }
        );
        return {
          version: 1,
          requestKey: crypto.randomUUID(),
          batchId: crypto.randomUUID(),
          actorUserId: user.id,
          orderId: order.id,
          orderNumber: order.orderNumber,
          orderBeforeHash: rows[0].hash,
          devicesBeforeHash: deviceSetHash([]),
          receipt: {
            runId: counter,
            observedAt: new Date().toISOString(),
            sha256: 'a'.repeat(64),
            detailSha256: 'b'.repeat(64),
            egressVerified: true,
            requestCoverageVerified: true,
          },
          items: [1, 2].map(index => ({
            serialNumber: 'T' + prefix + counter + index,
            partNumber: 'TEST/A',
            productName: 'TEST PHONE',
          })),
        };
      } catch (error) {
        error.component = 'fixture';
        throw error;
      }
    };
    const cases = [];
    const payload = await fixture();
    const result = await bindOfficialReceipt(payload, deps);
    assert.equal(result.newBindings, 2);
    assert.equal(result.orderBeforeHash, result.orderAfterHash);
    assert.equal(
      (await reconcileOfficialReceipt(payload, deps)).outcome,
      'RECEIPT_READBACK_VERIFIED'
    );
    assert.equal((await bindOfficialReceipt(payload, deps)).idempotent, true);
    assert.equal(await db.PickupDevice.count({ where: { orderId: payload.orderId } }), 2);
    const units = await db.StockUnit.findAll({
      where: { serialNumber: payload.items.map(item => item.serialNumber) },
    });
    assert.ok(units.every(unit => unit.state === 'registered' && !unit.orderNumberText));
    cases.push('atomic-bind-readback-idempotency-no-receive');
    await assert.rejects(
      bindOfficialReceipt({ ...payload, batchId: crypto.randomUUID() }, deps),
      error => error.code === 'IDEMPOTENCY_CONFLICT'
    );
    cases.push('same-key-different-content-rejected');
    const conflict = await fixture();
    conflict.items[1] = payload.items[0];
    await assert.rejects(
      bindOfficialReceipt(conflict, deps),
      error => error.code === 'RECEIPT_DEVICE_CONFLICT'
    );
    assert.equal(await db.PickupDevice.count({ where: { orderId: conflict.orderId } }), 0);
    assert.equal((await reconcileOfficialReceipt(conflict, deps)).outcome, 'RECEIPT_NOT_APPLIED');
    cases.push('cross-order-conflict-entire-order-rejected');
    const rollback = await fixture();
    let calls = 0;
    const failing = {
      ...deps,
      units: {
        ...deps.units,
        bindSource: async (...args) => {
          try {
            calls += 1;
            if (calls === 2)
              throw Object.assign(new Error('TEST_ROLLBACK'), { code: 'TEST_ROLLBACK' });
            return await deps.units.bindSource(...args);
          } catch (error) {
            error.component = 'injectedFailure';
            throw error;
          }
        },
      },
    };
    await assert.rejects(
      bindOfficialReceipt(rollback, failing),
      error => error.code === 'TEST_ROLLBACK'
    );
    assert.equal(await db.PickupDevice.count({ where: { orderId: rollback.orderId } }), 0);
    assert.equal(
      await db.StockUnit.count({
        where: { serialNumber: rollback.items.map(item => item.serialNumber) },
      }),
      0
    );
    assert.equal((await reconcileOfficialReceipt(rollback, deps)).outcome, 'RECEIPT_NOT_APPLIED');
    cases.push('second-device-failure-rolls-back-all');
    const source = await fixture();
    await db.StockUnit.create({
      serialNumber: source.items[0].serialNumber,
      state: 'registered',
      originMode: 'legacy_binding',
      orderNumberText: 'W9999999999',
      createdBy: user.id,
      updatedBy: user.id,
    });
    await assert.rejects(
      bindOfficialReceipt(source, deps),
      error => error.code === 'RECEIPT_STOCK_SOURCE_CONFLICT'
    );
    cases.push('manual-stock-source-protected');
    const race = await fixture();
    const other = { ...race, requestKey: crypto.randomUUID() };
    const settled = await Promise.allSettled([
      bindOfficialReceipt(race, deps),
      bindOfficialReceipt(other, deps),
    ]);
    assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(await db.PickupDevice.count({ where: { orderId: race.orderId } }), 2);
    cases.push('concurrent-writers-one-atomic-result');
    const currentDevices = await db.PickupDevice.findAll({ where: { orderId: payload.orderId } });
    const repeat = {
      ...payload,
      requestKey: crypto.randomUUID(),
      devicesBeforeHash: deviceSetHash(currentDevices),
    };
    assert.equal((await bindOfficialReceipt(repeat, deps)).newBindings, 0);
    assert.equal(
      (await reconcileOfficialReceipt(repeat, deps)).outcome,
      'RECEIPT_READBACK_VERIFIED'
    );
    cases.push('fresh-proof-existing-devices-no-duplicate');
    const pending = await fixture();
    let releasePending;
    let enteredPending;
    const release = new Promise(resolve => {
      releasePending = resolve;
    });
    const entered = new Promise(resolve => {
      enteredPending = resolve;
    });
    const pendingDeps = {
      ...deps,
      units: {
        ...deps.units,
        ensureUnit: async (...args) => {
          try {
            const unit = await deps.units.ensureUnit(...args);
            if (unit.serialNumber === pending.items[0].serialNumber) {
              enteredPending();
              await release;
            }
            return unit;
          } catch (error) {
            error.component = 'pendingTest';
            throw error;
          }
        },
      },
    };
    const writing = bindOfficialReceipt(pending, pendingDeps);
    await entered;
    let readFinished = false;
    const reading = reconcileOfficialReceipt(pending, deps).finally(() => {
      readFinished = true;
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(readFinished, false);
    releasePending();
    await writing;
    assert.equal((await reading).outcome, 'RECEIPT_READBACK_VERIFIED');
    cases.push('unknown-commit-readback-waits-for-inflight-transaction');
    await user.update({ status: 'locked' });
    await assert.rejects(
      bindOfficialReceipt(payload, deps),
      error => error.code === 'RECEIPT_ACTOR_INVALID'
    );
    cases.push('revoked-actor-denied-before-idempotent-replay');
    const report = { outcome: 'PASSED', cases, realPostgres: true, productionData: false };
    process.stdout.write(JSON.stringify(report) + '\n');
    return report;
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        outcome: 'FAILED',
        code: error.code || error.name,
        message: error.message,
        stack: error.stack,
      }) + '\n'
    );
    process.exitCode = 1;
  } finally {
    if (db) await db.sequelize.close().catch(() => {});
  }
}
if (require.main === module)
  main().catch(() => {
    process.exitCode = 1;
  });
module.exports = { runReceiptBindingAcceptance: main };
