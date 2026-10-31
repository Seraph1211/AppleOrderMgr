/* eslint-env node */
const input = require('../../../src/utils/proxyOrderInput');
const { normalizeProxyFee } = require('../../../src/utils/proxyFee');

/** 只在本机预览/浏览器验收中使用的独立合成数据，所有变更仅存在于内存。 */
module.exports = function createProxyUiFixture() {
  const source =
    '姓名：陈晓\n身份证后四位：0123\n手机号：13800000001\n邮箱：customer@example.test\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：闲鱼';
  const base = input.parseProxyText(source).draft;
  const names = ['陈晓', '林悦', '周宁', '许安', '沈言', '陆青', '顾明', '苏禾'];
  const accounts = Array.from({ length: 8 }, (_, index) => ({
    id: index + 101,
    appleId: `pickup${index + 1}@example.test`,
    status: ['使用中', '未使用', '使用中', '未使用', '已下架', '异常', '未使用', '使用中'][index],
    isProxyPool: true,
    notes: index === 5 ? '待核对登录状态' : '代抢专用',
    updatedAt: '2026-10-31T01:00:00Z',
    assignment: null,
  }));
  const assignmentsFor = index => {
    if (index !== 1 && index !== 5) return [];
    return [
      {
        id: index + 501,
        accountEmail: accounts[index === 1 ? 0 : 2].appleId,
        startedAt: '2026-10-31T01:15:00Z',
        endedAt: null,
      },
    ];
  };
  const officialOrdersFor = index => {
    if (index !== 2 && index !== 6) return [];
    return [
      {
        id: 3100 + index,
        orderNumber: `W102700000${index}`,
        status: 'PROCESSING',
        products: [{ name: 'iPhone Duo 星光白色 256G', quantity: 1 }],
        pickupStore: 'Apple 重庆解放碑',
        officialStatusObservedAt: '2026-10-31T02:00:00Z',
      },
    ];
  };
  let orders = names.map((name, index) => ({
    ...structuredClone(base),
    id: 2101 + index,
    version: 1,
    lastName: name.slice(0, 1),
    firstName: name.slice(1),
    phone: `1380000000${index + 1}`,
    email: `customer${index + 1}@example.test`,
    orderSource: index % 2 ? '淘宝' : '闲鱼',
    platformOrderNumber: `WT-20261031-${index + 1}`,
    status: [
      'pending',
      'rushing',
      'succeeded',
      'pending',
      'cancelled',
      'rushing',
      'succeeded',
      'pending',
    ][index],
    notes: [
      '联系客户后再确认支付',
      '两个候选商品任选其一',
      '',
      '等待补充取货安排',
      '',
      '可接受所选城市任一门店',
      '',
      '',
    ][index],
    // 本机UI预览使用合成金额；真实数据库保存通过独立API测试验证。
    proxyFee: ['120.00', '180.00', '0.00', '90.00', null, '150.00', '260.00', null][index],
    assignments: assignmentsFor(index),
    officialOrders: officialOrdersFor(index),
    createdAt: `2026-10-31T0${index + 1}:10:00Z`,
    events: [{ id: index + 900, action: 'create', actorId: 1, createdAt: '2026-10-31T01:00:00Z' }],
    rawText: source,
    links: [],
  }));
  accounts[0].assignment = { id: 502, proxyOrderId: 2102 };
  accounts[2].assignment = { id: 506, proxyOrderId: 2106 };
  const calls = [];
  return {
    calls,
    handle(method, url, body = {}) {
      const path = url.pathname.replace(/^\/api/, '');
      calls.push({ method, path, body });
      if (path === '/auth/me')
        return {
          id: 900,
          username: 'UI预览',
          nickname: '演示管理员',
          role: 'admin',
          availableHome: '/proxy-orders',
          permissions: ['proxy_orders.read', 'orders.read'],
        };
      if (path === '/proxy-orders/stores') return input.STORES;
      if (path === '/proxy-orders/catalog')
        return {
          productCandidates: input.PRODUCT_CANDIDATES,
          paymentMethods: input.PAYMENT_METHODS,
        };
      if (path === '/proxy-orders/parse') return input.parseProxyText(body.text);
      if (path === '/proxy-orders/address') return input.generateProxyAddress(body.storeCode);
      if (path === '/proxy-orders/copy')
        return {
          text: body.ids
            .map(id => `preview-${id}@example.test — 合成模板，仅用于界面预览`)
            .join('\n'),
          count: body.ids.length,
        };
      if (path === '/proxy-orders/accounts' && method === 'GET') {
        const available = accounts.filter(
          a => !a.assignment && ['未使用', '使用中'].includes(a.status)
        );
        let rows = url.searchParams.get('availableOnly') === 'true' ? available : accounts;
        const keyword = url.searchParams.get('keyword');
        if (keyword) rows = rows.filter(a => a.appleId.includes(keyword));
        return { rows, count: rows.length, availableCount: available.length };
      }
      if (path === '/proxy-orders/accounts/status') {
        body.accounts.forEach(a => {
          const account = accounts.find(item => item.id === a.id);
          account.status = body.status;
        });
        return { updated: body.accounts.length };
      }
      if (/^\/proxy-orders\/accounts\/\d+$/.test(path)) {
        Object.assign(
          accounts.find(a => a.id === Number(path.split('/').at(-1))),
          { status: body.status, notes: body.notes }
        );
        return {};
      }
      if (path === '/proxy-orders/accounts/import' || path === '/proxy-orders/accounts/adopt')
        return { imported: 1 };
      if (path === '/proxy-orders' && method === 'GET') {
        let rows = orders;
        const keyword = url.searchParams.get('keyword'),
          status = url.searchParams.get('status');
        if (keyword)
          rows = rows.filter(o =>
            `${o.id}${o.lastName}${o.firstName}${o.platformOrderNumber}`.includes(keyword)
          );
        if (status) rows = rows.filter(o => o.status === status);
        return { rows, count: rows.length };
      }
      if (path === '/proxy-orders' && method === 'POST') {
        const row = {
          ...body,
          proxyFee: normalizeProxyFee(body.proxyFee),
          id: 2200 + orders.length,
          version: 1,
          assignments: [],
          officialOrders: [],
          events: [],
          status: 'pending',
          createdAt: '2026-10-31T08:00:00Z',
        };
        orders.push(row);
        return { ...row, assigned: false };
      }
      const match = path.match(/^\/proxy-orders\/(\d+)(?:\/(\w+))?$/);
      if (match) {
        const row = orders.find(o => o.id === Number(match[1]));
        const action = match[2];
        if (!row) throw new Error('合成订单不存在');
        if (method === 'GET') return row;
        if (!action) {
          Object.assign(row, body);
          row.proxyFee = normalizeProxyFee(row.proxyFee);
        }
        if (action === 'notes') row.notes = body.notes;
        if (action === 'status') row.status = body.status;
        if (action === 'delete') orders = orders.filter(o => o.id !== row.id);
        if (action === 'accounts') {
          const available = accounts.filter(
            a => !a.assignment && ['未使用', '使用中'].includes(a.status)
          );
          const chosen = body.accountIds
            ? available.filter(a => body.accountIds.includes(a.id))
            : available.slice(0, body.count);
          chosen.forEach(a => {
            a.assignment = { id: a.id, proxyOrderId: row.id };
            row.assignments.push({
              id: a.id,
              accountEmail: a.appleId,
              startedAt: '2026-10-31T08:00:00Z',
              endedAt: null,
            });
          });
          return { assigned: chosen.length };
        }
        row.version += 1;
        return { released: 0, id: row.id, version: row.version };
      }
      return {};
    },
  };
};
