/** 原取货接口控制器与真实PG兼容回归；仅专用合成库。 */
const crypto = require('crypto');
const { spawn } = require('child_process');
const enabled = process.env.RUN_STOCK_INTEGRATION === 'true';
if (
  enabled &&
  (!/^apple_order_mgr_stock_test_\d+$/.test(process.env.DB_NAME || '') ||
    process.env.DATABASE_URL ||
    process.env.DB_NAME_TEST !== process.env.DB_NAME)
)
  throw new Error('拒绝非独立数据库');
(enabled ? describe : describe.skip)('旧取货与库存故障恢复', () => {
  const db = require('../src/models');
  const controller = require('../src/controllers/pickupDeviceController');
  const command = require('../src/services/stockCommandService');
  const unitService = require('../src/services/stockUnitService');
  let user, limited, orderA, orderB, product, location, settingsBefore;
  const suffix = crypto.randomBytes(4).toString('hex');
  const serial = `L${suffix}0`.toUpperCase();
  function response() {
    return {
      statusCode: 200,
      setHeader() {
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        return this;
      },
    };
  }
  const request = (who, orderId, body = {}, deviceId) => ({
    user: who,
    params: { orderId, deviceId },
    body,
  });
  beforeAll(async () => {
    user = await db.User.create({
      username: `legacy_${suffix}`,
      password: crypto.randomBytes(20).toString('hex'),
      role: 'admin',
    });
    limited = await db.User.create({
      username: `limited_${suffix}`,
      password: crypto.randomBytes(20).toString('hex'),
      role: 'operator',
      orderAccess: { mode: 'tags', tags: [`A${suffix}`] },
    });
    await db.UserPermission.bulkCreate(
      ['pickups.read', 'pickups.edit'].map(permissionCode => ({
        userId: limited.id,
        permissionCode,
      }))
    );
    orderA = await db.Order.create({
      orderNumber: `W${Date.now().toString().slice(-9)}1`,
      products: [{ name: '合成手机', quantity: 1 }],
      tag: `A${suffix}`,
    });
    orderB = await db.Order.create({
      orderNumber: `W${Date.now().toString().slice(-9)}2`,
      products: [{ name: '合成手机', quantity: 1 }],
      tag: `B${suffix}`,
    });
    product = await db.StockProduct.create({
      modelKey: `legacy${suffix}`,
      modelName: '故障恢复合成手机',
      storageGb: 128,
      colorKey: 'white',
      colorName: '白色',
    });
    location = await db.StockLocation.create({
      name: `恢复库${suffix}`,
      kind: 'warehouse',
      city: '重庆',
    });
    settingsBefore = (await db.StockSetting.findByPk(1)).toJSON();
    await db.StockSetting.update({ enabled: false }, { where: { id: 1 } });
  });
  afterAll(async () => {
    await db.StockSetting.update({ enabled: settingsBefore.enabled }, { where: { id: 1 } });
    await db.sequelize.close();
  });
  test('禁用新模块仍可旧扫码；同单幂等/跨单冲突/解绑再绑旧UUID安全', async () => {
    const first = response();
    await controller.create(request(user, orderA.id, { serialBarcode: serial }), first);
    const oldId = first.payload.data.device.id;
    const second = response();
    await controller.create(request(user, orderA.id, { serialBarcode: serial }), second);
    expect(second.payload.data.alreadyBound).toBe(true);
    expect(second.payload.data.device.id).toBe(oldId);
    await expect(
      controller.create(request(user, orderB.id, { serialBarcode: serial }), response())
    ).rejects.toMatchObject({ code: 'DEVICE_ALREADY_BOUND' });
    const binding = await db.PickupDevice.findByPk(oldId);
    const unitId = binding.stockUnitId;
    expect((await db.StockUnit.findByPk(unitId)).state).toBe('registered');
    await controller.remove(request(user, orderA.id, {}, oldId), response());
    expect(await db.StockUnit.findByPk(unitId)).not.toBeNull();
    const next = response();
    await controller.create(request(user, orderA.id, { serialBarcode: serial }), next);
    expect(next.payload.data.device.id).not.toBe(oldId);
    const retry = response();
    await controller.remove(request(user, orderA.id, {}, oldId), retry);
    expect(retry.payload.data.removed).toBe(false);
    expect(await db.PickupDevice.findByPk(next.payload.data.device.id)).not.toBeNull();
    await expect(controller.list(request(limited, orderB.id), response())).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      controller.create(request(limited, orderB.id, { serialBarcode: `L${suffix}1` }), response())
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  test('模拟旧应用可空桥接行，明确修复保留原UUID/SN/订单/时间', async () => {
    const row = await db.PickupDevice.create({
      orderId: orderA.id,
      serialNumber: `R${suffix}0`.toUpperCase(),
      serialBarcode: `R${suffix}0`,
      stockUnitId: null,
      scannedBy: user.id,
    });
    const before = row.toJSON();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['scripts/repairPickupStockBridge.js', '--apply', `--actor-id=${user.id}`],
        { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let error = '';
      child.stderr.on('data', data => {
        error += data;
      });
      child.on('error', reject);
      child.on('exit', code => (code === 0 ? resolve(true) : reject(new Error(error))));
    });
    expect(result).toBe(true);
    const after = (await db.PickupDevice.findByPk(row.id)).toJSON();
    for (const field of ['id', 'serialNumber', 'orderId']) expect(after[field]).toBe(before[field]);
    expect(+after.createdAt).toBe(+before.createdAt);
    expect(after.stockUnitId).not.toBeNull();
    expect((await db.StockUnit.findByPk(after.stockUnitId)).state).toBe('registered');
  }, 15000);
  test('真实模块锁超时后事务无残留；原请求键可恢复', async () => {
    await db.StockSetting.update({ enabled: true }, { where: { id: 1 } });
    const lock = await db.sequelize.transaction();
    await command.lockStock(lock);
    const input = {
      requestKey: crypto.randomUUID(),
      units: [
        {
          serialBarcode: `W${suffix}0`,
          productId: product.id,
          locationId: location.id,
          receivedAt: '2026-10-04T08:00:00+08:00',
        },
      ],
    };
    try {
      await expect(
        command.runCommand(user, input, 'timeout.receive', ['stock.receive'], ctx =>
          unitService.receiveUnits(ctx, input)
        )
      ).rejects.toMatchObject({ code: 'STOCK_BUSY' });
      expect(await db.StockOperation.count({ where: { requestKey: input.requestKey } })).toBe(0);
    } finally {
      await lock.rollback();
    }
    const result = await command.runCommand(
      user,
      input,
      'timeout.receive',
      ['stock.receive'],
      ctx => unitService.receiveUnits(ctx, input)
    );
    expect(result.unitIds).toHaveLength(1);
  }, 15000);
  test('进程在写入后提交前被杀，实物/事件/幂等记录全部回滚', async () => {
    const input = {
      requestKey: crypto.randomUUID(),
      units: [
        {
          serialBarcode: `K${suffix}0`,
          productId: product.id,
          locationId: location.id,
          receivedAt: '2026-10-04T08:00:00+08:00',
        },
      ],
    };
    const code = `const db=require('./src/models');const c=require('./src/services/stockCommandService');const u=require('./src/services/stockUnitService');(async()=>{const user=await db.User.findByPk(${user.id});const input=${JSON.stringify(input)};await c.runCommand(user,input,'crash.receive',['stock.receive'],async ctx=>{await u.receiveUnits(ctx,input);process.stdout.write('STOCK_PENDING_COMMIT\\n');await new Promise(()=>{});});})().catch(()=>process.exit(1));`;
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', code], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let killed = false;
      child.stdout.on('data', data => {
        output += data;
        if (output.includes('STOCK_PENDING_COMMIT') && !killed) {
          killed = true;
          child.kill('SIGKILL');
        }
      });
      child.on('error', reject);
      child.on('exit', () => (killed ? resolve() : reject(new Error('子进程未到达提交前故障点'))));
    });
    expect(await db.StockOperation.count({ where: { requestKey: input.requestKey } })).toBe(0);
    expect(
      await db.StockUnit.count({
        where: { serialNumber: input.units[0].serialBarcode.toUpperCase() },
      })
    ).toBe(0);
    expect(
      (
        await command.runCommand(user, input, 'crash.receive', ['stock.receive'], ctx =>
          unitService.receiveUnits(ctx, input)
        )
      ).unitIds
    ).toHaveLength(1);
  }, 15000);
});
