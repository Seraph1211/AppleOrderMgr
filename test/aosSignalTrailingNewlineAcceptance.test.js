/* eslint-disable no-magic-numbers */
const { Op } = require('sequelize');
const fs = require('fs');
const path = require('path');
const policy = require('../src/services/aosSignalPolicy');
const AosSignalService = require('../src/services/aosSignalService');
const InventoryNotifier = require('../src/services/inventoryNotifier');
const { encrypt } = require('../src/utils/fieldEncryption');

const NOW = Date.parse('2026-10-25T17:34:41.982+08:00');
const SOURCE = { key: 'device:instance', server: 'US Server 21', instance: '心蓝21' };
const total = groups => Object.values(groups).reduce((sum, group) => sum + group.count, 0);
const item = (patch = {}) => ({
  city: '深圳',
  storeCode: 'R577',
  storeName: 'Apple 前海壹方城',
  model: 'iPhone Duo',
  color: '星光白色',
  capacity: '512G',
  source: SOURCE,
  observedAt: NOW,
  ...patch,
});

/** 使用真实服务与策略，仓库模拟JSON持久化，不运行外部采集或网络发送。 */
function harness() {
  const inbox = [];
  const contexts = new Map();
  const deliveries = new Map();
  const context = {
    state: {},
    settings: {
      config: { aosSignalsEnabled: true },
      aosSignalsSince: NOW - 1,
      destinationId: 'synthetic',
      testedDestination: 'synthetic',
      webhookCipher: 'synthetic-encrypted-placeholder',
    },
    now: NOW,
    transaction: {},
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const store = {
    locked: work => Promise.resolve(work(context)),
    rows: (name, options = {}) => {
      if (name !== 'InventoryDelivery') return Promise.resolve([]);
      const rows = [...deliveries.values()].filter(row =>
        Object.entries(options.where || {}).every(([key, value]) =>
          key.startsWith('body.') ? row[key.slice(5)] === value : true
        )
      );
      return Promise.resolve(rows.map(clone));
    },
    put: (_name, rows) => {
      for (const row of rows) deliveries.set(row.id, clone(row));
      return Promise.resolve();
    },
    db: { query: () => Promise.resolve([]) },
    m: {
      AosSignalInbox: {
        findAll: options =>
          Promise.resolve(
            inbox.filter(row => {
              const keys = options.where?.['body.taskKey']?.[Op.in];
              return !keys || keys.includes(row.body.taskKey);
            })
          ),
        destroy: () => {
          inbox.length = 0;
          return Promise.resolve();
        },
      },
      AosSignalContext: {
        findAll: options =>
          Promise.resolve(
            options.where.updatedAt
              ? []
              : [...contexts.values()].filter(row => options.where.id[Op.in].includes(row.id))
          ),
        bulkCreate: rows => {
          for (const row of rows) contexts.set(row.id, clone(row));
          return Promise.resolve();
        },
      },
      AosDevice: {
        findAll: () => Promise.resolve([{ id: 'device', name: SOURCE.server, enabled: true }]),
      },
      MonitorInstance: {
        findAll: () =>
          Promise.resolve([{ deviceId: 'device', localId: 'instance', label: SOURCE.instance }]),
      },
      MonitorLogState: { findAll: () => Promise.resolve([]) },
    },
  };
  let sequence = 0;
  const feed = (texts, at = context.now, offsets = []) => {
    for (const [index, text] of texts.entries()) {
      sequence += 1;
      const parsed = policy.parseEntry(
        {
          id: `entry-${sequence}`,
          deviceId: 'device',
          localId: 'instance',
          fileId: 'file',
          byteOffset: offsets[index] ?? sequence,
          loggedAt: new Date(at).toISOString(),
          parseState: 'parsed',
          partIndex: 0,
          message: `2026-10-25 17:34:41.982 [2][013]A77-${text}`,
        },
        context.now
      );
      if (parsed) {
        const { id, ...body } = parsed;
        inbox.push({ id, body });
      }
    }
  };
  const rows = () => [...deliveries.values()];
  return { context, store, feed, rows, deliveries, service: () => new AosSignalService(store) };
}

/** 直接核对原始字符串及末尾码点，不用trim隐藏产品尾换行。 */
function expectNoTrailingNewline(value) {
  expect(typeof value).toBe('string');
  expect(value.endsWith('\n')).toBe(false);
  expect(value.endsWith('\r')).toBe(false);
  expect([10, 13]).not.toContain(value.codePointAt(value.length - 1));
}

/** 构造门店/来源和长度边界；所有数据均为合成。 */
function groupsFor(shape) {
  const groups = {};
  if (shape === '单来源') return policy.addGroup(groups, item());
  if (shape === '未知门店')
    return policy.addGroup(groups, item({ city: '未知', storeCode: '未知', storeName: '未知' }));
  const size = shape === '长消息' ? 150 : 3;
  for (let index = 0; index < size; index += 1)
    policy.addGroup(
      groups,
      item({
        ...(shape === '多来源' ? {} : { storeCode: `R${index}`, storeName: `Apple 门店${index}` }),
        source: { key: `source-${index}`, server: `US${index + 1}`, instance: `实例${index + 1}` },
      })
    );
  return groups;
}

const SHAPES = ['单来源', '多来源', '多门店', '长消息', '未知门店'];

describe.each([true, false])('首次=%s的policy和实际claim原文', immediate => {
  test.each(SHAPES)('%s：两级均无尾CRLF且内部原文保持', async shape => {
    try {
      const groups = groupsFor(shape);
      const body = policy.content(groups, immediate);
      expectNoTrailingNewline(body);
      expect(body).toContain('\n\n');
      const h = harness();
      await h.service().queue(groups, h.context, immediate, NOW, NOW + 180000);
      h.context.now += policy.LOCATION_WAIT_MS + 1;
      const claim = await new InventoryNotifier(h.store, jest.fn()).claim();
      expectNoTrailingNewline(claim.content);
      expect(claim.content).toBe(`【AOS 放货信号】\n${body}`);
      expect(Buffer.byteLength(claim.content, 'utf8')).toBeLessThanOrEqual(1600);
    } catch (error) {
      throw new Error('policy和claim尾字符验收失败', { cause: error });
    }
  });
});

test.each([true, false])('首次=%s：内部段落空行逐字保留，只去掉末尾换行', immediate => {
  const body = policy.content(groupsFor('单来源'), immediate);
  expect(body).toBe(
    [
      `${immediate ? '首次信号' : '3分钟汇总'}｜1次命中｜1家门店`,
      '',
      '深圳 · Apple 前海壹方城',
      'iPhone Duo',
      '星光白色 · 512G｜1次',
      '',
      '时间：10-25 17:34:41',
      '',
      '来源：US_21 / 心蓝21｜1次',
    ].join('\n')
  );
});

test.each([true, false])('首次=%s：tick传输替身实际收到的完整正文无末尾CRLF', async immediate => {
  const previousKey = process.env.FIELD_ENCRYPTION_KEY;
  process.env.FIELD_ENCRYPTION_KEY = '11'.repeat(32);
  try {
    const h = harness();
    h.context.settings.webhookCipher = encrypt(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-no-tail-only'
    );
    const groups = groupsFor('多门店');
    await h.service().queue(groups, h.context, immediate, NOW, NOW + 180000);
    const send = jest.fn().mockResolvedValue({ status: 'accepted' });
    const result = await new InventoryNotifier(h.store, send).tick();
    expect(result.status).toBe('accepted');
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][1];
    expectNoTrailingNewline(message);
    expect(message).toBe(`【AOS 放货信号】\n${policy.content(groups, immediate)}`);
    expect(h.rows()[0].status).toBe('accepted');
    const evidenceDirectory = process.env.AOS_NO_TAIL_EVIDENCE_DIR;
    if (evidenceDirectory) {
      fs.mkdirSync(evidenceDirectory, { recursive: true });
      const name = immediate ? '首次' : '汇总';
      fs.writeFileSync(path.join(evidenceDirectory, `${name}传输正文.txt`), message);
      fs.writeFileSync(
        path.join(evidenceDirectory, `${name}尾字符.json`),
        JSON.stringify(
          {
            tail: message.slice(-32),
            lastCodePoints: [...message.slice(-5)].map(char => char.codePointAt(0)),
            endsWithCR: message.endsWith('\r'),
            endsWithLF: message.endsWith('\n'),
            bytes: Buffer.byteLength(message, 'utf8'),
          },
          null,
          2
        )
      );
    }
  } catch (error) {
    throw new Error('实际模拟传输尾字符验收失败', { cause: error });
  } finally {
    if (previousKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
    else process.env.FIELD_ENCRYPTION_KEY = previousKey;
  }
});

test.each(['\n', '\r\n', '\r\n\n\r\n'])(
  '旧pending无groups仅保守剥尾%j，正文内部CRLF/空行不改',
  async tail => {
    try {
      const h = harness();
      const raw =
        '首次信号｜1次命中｜1家门店\r\n\r\n深圳 · Apple 前海壹方城\n\niPhone Duo\r\n星光白色 · 512G｜1次';
      h.deliveries.set('legacy', {
        id: 'legacy',
        kind: 'aos_signal',
        status: 'pending',
        destinationId: 'synthetic',
        aosSignalsSince: NOW - 1,
        content: raw + tail,
        notBefore: NOW,
        expiresAt: NOW + 180000,
        attempts: 0,
      });
      const claim = await new InventoryNotifier(h.store, jest.fn()).claim();
      expect(claim.content).toBe(`【AOS 放货信号】\n${raw}`);
      expectNoTrailingNewline(claim.content);
    } catch (error) {
      throw new Error('旧无groups正文保守剥尾验收失败', { cause: error });
    }
  }
);

test('旧pending有groups从结构化数据重建，无尾换行且已发送历史不变', async () => {
  try {
    const h = harness();
    const groups = groupsFor('多来源');
    await h.service().queue(groups, h.context, false, NOW, NOW + 180000);
    const pending = h.rows()[0];
    pending.content = '旧消息\r\n\r\n';
    const history = { ...pending, id: 'history', status: 'accepted', content: '历史消息\r\n\r\n' };
    h.deliveries.set(pending.id, pending);
    h.deliveries.set(history.id, history);
    const before = JSON.stringify(history);
    const claim = await new InventoryNotifier(h.store, jest.fn()).claim();
    expect(claim.content).toBe(`【AOS 放货信号】\n${policy.content(groups, false)}`);
    expectNoTrailingNewline(claim.content);
    expect(JSON.stringify(h.deliveries.get(history.id))).toBe(before);
  } catch (error) {
    throw new Error('旧groups与历史兼容验收失败', { cause: error });
  }
});

test.each(['test', 'health'])('非AOS %s：原正文换行、末尾换行及链接保持', async kind => {
  const previousUrl = process.env.INVENTORY_PUBLIC_URL;
  process.env.INVENTORY_PUBLIC_URL = 'https://signal.example.invalid';
  try {
    const h = harness();
    h.context.settings.config.notificationsEnabled = true;
    h.context.state.healthAlerts = { lastAttempts: {} };
    const body = '普通消息第一段\n\n普通消息第二段\n';
    h.deliveries.set('ordinary', {
      id: 'ordinary',
      kind,
      healthKey: 'manual:NO_HEALTHY_PROXY',
      status: 'pending',
      destinationId: 'synthetic',
      content: body,
      notBefore: NOW,
      expiresAt: NOW + 180000,
      attempts: 0,
    });
    const notifier = new InventoryNotifier(h.store, jest.fn());
    // 此项只验证包装兼容；健康事件的排队/撤销由原PG回归覆盖。
    notifier.reconcileHealth = jest.fn().mockResolvedValue();
    const claim = await notifier.claim();
    const title = kind === 'test' ? '库存机器人合成测试' : '库存监控运行提醒';
    const link = kind === 'test' ? '/inventory-monitor' : '/inventory-monitor/manage?tab=settings';
    expect(claim.content).toBe(
      `【${title}】\n${body}\n详情（需登录）：https://signal.example.invalid${link}\n`
    );
    expect(claim.content.endsWith('\n')).toBe(true);
  } catch (error) {
    throw new Error('非AOS消息包装兼容验收失败', { cause: error });
  } finally {
    if (previousUrl === undefined) delete process.env.INVENTORY_PUBLIC_URL;
    else process.env.INVENTORY_PUBLIC_URL = previousUrl;
  }
});

test('尾换行修复不改变首条入汇总：首次1次，第一汇总2次', async () => {
  try {
    const h = harness();
    h.feed([
      '消息20110501',
      '尝试预约: Apple 前海壹方城, 日期',
      '商品: iPhone Duo 512GB 星光白色 x 1, RMB 1',
      '取货信息: 取货日期待付款完成后确定',
      '取货信息: 取货日期待付款完成后确定',
    ]);
    await h.service().tick();
    expect(total(h.rows()[0].aosGroups)).toBe(1);
    expectNoTrailingNewline(h.rows()[0].content);
    h.context.now += 180000;
    await h.service().tick();
    const summary = h.rows().find(row => !row.aosImmediate);
    expect(total(summary.aosGroups)).toBe(2);
    expectNoTrailingNewline(summary.content);
  } catch (error) {
    throw new Error('首次计数保全验收失败', { cause: error });
  }
});
