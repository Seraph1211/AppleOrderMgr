const fs = require('fs');
const path = require('path');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

test('有货记录与监控变更使用独立受权页面和导航入口', () => {
  const app = read('frontend/src/App.jsx');
  const navigation = read('frontend/src/constants/navigation.js');
  expect(app).toContain('path="/apple-purchase-inventory"');
  expect(app).toContain('path="/apple-purchase-monitor-changes"');
  expect(app).toContain('path="/apple-purchase-terminals"');
  expect(app.match(/PERMISSIONS\.INVENTORY_READ/g).length).toBeGreaterThanOrEqual(2);
  expect(navigation).toContain("href: '/apple-purchase-inventory'");
  expect(navigation).toContain("href: '/apple-purchase-monitor-changes'");
  expect(navigation).toContain("href: '/apple-purchase-terminals'");
});

test('受保护 SSE 使用 Header，不把网页 JWT 或完整事件放进 URL', () => {
  const api = read('frontend/src/api/applePurchaseInventoryApi.js');
  expect(api).toContain("Authorization: `Bearer ${authToken() || ''}`");
  expect(api).toContain("fetch('/api/apple-purchase-inventory/v1/events'");
  expect(api).not.toMatch(/events\?[^'"`]*(token|authorization)/i);
  expect(api).toContain("event !== 'inventory-version'");
});

test('页面明确使用北京时间并保持 bigint 序号为文本渲染', () => {
  for (const page of [
    'frontend/src/pages/ApplePurchaseInventory.jsx',
    'frontend/src/pages/ApplePurchaseMonitorChanges.jsx',
  ]) {
    const source = read(page);
    expect(source).toContain("timeZone: 'Asia/Shanghai'");
    expect(source).toContain('item.sequence');
  }
});
