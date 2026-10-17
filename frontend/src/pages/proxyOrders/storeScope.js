const unique = values => [
  ...new Set(
    values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim())
  ),
];

/** 回填多城市、旧版城市字符串或可完整识别的历史门店集合，不扩张保存范围。 */
export function pickupCities(order, stores = []) {
  const explicit = unique(Array.isArray(order.storeCities) ? order.storeCities : []);
  if (explicit.length) return explicit;
  if (order.storeCity?.trim()) return unique(order.storeCity.split(/[、,，|/]/));
  const codes = order.storeCodes || [];
  const known = codes.map(code => stores.find(store => store.code === code));
  if (!codes.length || known.some(store => !store?.city)) return [];
  return unique(known.map(store => store.city));
}

/** 补齐编辑态城市并保留已登记的固定门店代码。 */
export function normalizeStoreScope(order, stores = []) {
  const storeCities = pickupCities(order, stores);
  return {
    ...order,
    storeCodes: [...(order.storeCodes || [])],
    storeCities,
    storeCity: storeCities.join('、'),
  };
}

/** 仅明确修改城市或切回城市全店模式时展开当前目录，其他编辑保留固定代码。 */
export function updateStoreScope(order, updates, stores) {
  const previous = normalizeStoreScope(order, stores);
  const next = normalizeStoreScope({ ...previous, ...updates }, stores);
  if (Object.hasOwn(updates, 'storeCities')) {
    next.storeCities = unique(updates.storeCities);
    next.storeCity = next.storeCities.join('、');
  }
  const citiesChanged = next.storeCities.join('|') !== previous.storeCities.join('|');
  if (next.storeMode === 'city_any' && (citiesChanged || previous.storeMode !== 'city_any')) {
    next.storeCodes = next.storeCities.flatMap(city =>
      stores.filter(store => store.city === city).map(store => store.code)
    );
  } else if (citiesChanged && next.storeMode === 'selected') {
    next.storeCodes = next.storeCodes.filter(code => {
      const store = stores.find(item => item.code === code);
      return !store || next.storeCities.includes(store.city);
    });
  }
  return next;
}

/** 展示已保存的范围类型和实际门店数量；不把未知模式推测为全店。 */
export function storeScopeSummary(order) {
  const count = new Set(order.storeCodes || []).size;
  if (!count) return '尚未确认门店';
  return `${order.storeMode === 'city_any' ? '城市全店范围' : '指定门店'} · 已确认 ${count} 家`;
}
