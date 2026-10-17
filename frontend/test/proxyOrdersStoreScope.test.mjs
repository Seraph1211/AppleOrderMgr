import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStoreScope,
  pickupCities,
  storeScopeSummary,
  updateStoreScope,
} from '../src/pages/proxyOrders/storeScope.js';

const stores = [
  { code: 'R577', city: '广州', name: '天环广场' },
  { code: 'R639', city: '广州', name: '珠江新城' },
  { code: 'R484', city: '深圳', name: '益田假日广场' },
  { code: 'R761', city: '深圳', name: '深圳万象城' },
  { code: 'R793', city: '深圳', name: '前海壹方城' },
  { code: 'R617', city: '长沙', name: '长沙' },
];
const guangzhou = {
  storeMode: 'city_any',
  storeCity: '广州',
  storeCodes: ['R577', 'R639'],
};

test('登记解析多城市与旧版单城市均正确回填，保留固定门店范围', () => {
  const parsed = normalizeStoreScope(
    {
      storeMode: 'city_any',
      storeCities: ['广州', '深圳'],
      storeCity: '广州、深圳',
      storeCodes: ['R577', 'R639', 'R484', 'R761', 'R793'],
    },
    stores
  );
  assert.deepEqual(parsed.storeCities, ['广州', '深圳']);
  assert.equal(parsed.storeCity, '广州、深圳');
  assert.equal(parsed.storeCodes.length, 5);
  assert.deepEqual(normalizeStoreScope(guangzhou, stores).storeCities, ['广州']);
  assert.deepEqual(pickupCities({ storeCity: '广州、深圳' }, stores), ['广州', '深圳']);
});

test('历史跨城指定门店推导全部已知城市，含未知代码时不推测城市', () => {
  assert.deepEqual(pickupCities({ storeCodes: ['R577', 'R484'] }, stores), ['广州', '深圳']);
  assert.deepEqual(pickupCities({ storeCodes: ['R577', 'unknown'] }, stores), []);
  assert.deepEqual(pickupCities({ storeCodes: [] }, stores), []);
});

test('从单城市增加第二和第三座城市时选择每座城市全部门店', () => {
  const two = updateStoreScope(guangzhou, { storeCities: ['广州', '深圳'] }, stores);
  assert.deepEqual(two.storeCodes, ['R577', 'R639', 'R484', 'R761', 'R793']);
  assert.equal(two.storeCity, '广州、深圳');
  const three = updateStoreScope(two, { storeCities: ['广州', '深圳', '长沙'] }, stores);
  assert.equal(three.storeCodes.length, 6);
  const single = updateStoreScope(three, { storeCities: ['深圳'] }, stores);
  assert.deepEqual(single.storeCodes, ['R484', 'R761', 'R793']);
  const empty = updateStoreScope(single, { storeCities: [] }, stores);
  assert.deepEqual(empty.storeCodes, []);
  assert.equal(empty.storeCity, '');
});

test('未改变城市的编辑不因目录新增门店而扩张，保留账单地址', () => {
  const saved = {
    ...guangzhou,
    billing: { referenceStoreCode: 'R577', streetAddress: '保留地址' },
  };
  const expanded = [...stores, { code: 'new', city: '广州' }];
  assert.deepEqual(normalizeStoreScope(saved, expanded).storeCodes, ['R577', 'R639']);
  const next = updateStoreScope(saved, { storeCities: ['广州'] }, expanded);
  assert.deepEqual(next.storeCodes, ['R577', 'R639']);
  assert.deepEqual(next.billing, saved.billing);
  assert.deepEqual(saved.storeCodes, ['R577', 'R639']);
});

test('指定门店可跨城市选择，添加城市保留现有选择，移除城市只去掉该城门店', () => {
  const selected = updateStoreScope(guangzhou, { storeMode: 'selected' }, stores);
  assert.deepEqual(selected.storeCodes, ['R577', 'R639']);
  const two = updateStoreScope(selected, { storeCities: ['广州', '深圳'] }, stores);
  assert.deepEqual(two.storeCodes, ['R577', 'R639']);
  const edited = updateStoreScope(two, { storeCodes: ['R577', 'R793'] }, stores);
  assert.equal(edited.storeMode, 'selected');
  assert.deepEqual(edited.storeCities, ['广州', '深圳']);
  assert.deepEqual(updateStoreScope(edited, { storeCities: ['深圳'] }, stores).storeCodes, [
    'R793',
  ]);
  assert.equal(edited.storeCodes.length, 2);
});

test('从跨城指定门店切为城市全店重新展开，范围文案区分指定与全店', () => {
  const selected = {
    storeMode: 'selected',
    storeCities: ['广州', '深圳'],
    storeCodes: ['R577', 'R793'],
  };
  const all = updateStoreScope(selected, { storeMode: 'city_any' }, stores);
  assert.equal(all.storeCodes.length, 5);
  assert.equal(storeScopeSummary(all), '城市全店范围 · 已确认 5 家');
  assert.equal(storeScopeSummary(selected), '指定门店 · 已确认 2 家');
  assert.equal(storeScopeSummary({ storeCodes: [] }), '尚未确认门店');
});

test('编辑城市列表去重并保留选择顺序，API兼容城市串与数组一致', () => {
  const next = updateStoreScope(guangzhou, { storeCities: ['深圳', '广州', '深圳'] }, stores);
  assert.deepEqual(next.storeCities, ['深圳', '广州']);
  assert.equal(next.storeCity, '深圳、广州');
  assert.deepEqual(next.storeCodes, ['R484', 'R761', 'R793', 'R577', 'R639']);
});
