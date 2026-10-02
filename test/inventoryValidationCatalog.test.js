const {
  parseProductCatalog,
  parseStoreCatalog,
} = require('../src/services/inventoryValidationCatalog');
const product = { partNumber: 'TEST1CH/A', name: 'iPhone 17 256GB Black', category: 'iphone' };
const productHtml = (products, category = 'iphone_17') =>
  `<script id="metrics" type="application/json">${JSON.stringify({ data: { category, products } })}</script>`;
const store = { id: 'R001', name: '合成店', address: { city: '合成城', postalCode: '100000' } };
const storeHtml = data =>
  `<a data-store-number="R001">合成店</a><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
describe('官方目录范围', () => {
  test('精确提取iPhone，排除配件并去重', () => {
    expect(parseProductCatalog(productHtml([product, product, { category: 'accessory' }]))).toEqual(
      [{ sku: 'TEST1CH/A', title: product.name, family: 'iphone_17' }]
    );
  });
  test('未核验系列、缺SKU、冲突和空目录拒绝', () => {
    expect(() => parseProductCatalog(productHtml([product], 'iphone_duo'))).toThrow('UNVERIFIED');
    expect(() => parseProductCatalog(productHtml([{ ...product, partNumber: 'OTHER' }]))).toThrow(
      'INVALID'
    );
    expect(() =>
      parseProductCatalog(productHtml([product, { ...product, name: 'iPhone 其他' }]))
    ).toThrow('CONFLICTING');
    expect(() => parseProductCatalog(productHtml([]))).toThrow('EMPTY');
  });
  test('全球结构化数据不扩展大陆可见清单', () => {
    const rows = parseStoreCatalog(
      storeHtml({
        countries: [
          { stores: [store, { id: 'R999', name: '海外店', address: { postalCode: 'US' } }] },
        ],
      })
    );
    expect(rows).toEqual([
      { storeCode: 'R001', storeName: '合成店', city: '合成城', location: '100000' },
    ]);
  });
  test('门店清单缺失、名称或地址冲突不缩小范围', () => {
    expect(() => parseStoreCatalog(storeHtml([]))).toThrow('INCOMPLETE');
    expect(() => parseStoreCatalog(storeHtml({ store: { ...store, name: '其他店' } }))).toThrow(
      'CONFLICTING'
    );
    expect(() =>
      parseStoreCatalog(
        storeHtml([store, { ...store, address: { city: '其他城', postalCode: '200000' } }])
      )
    ).toThrow('CONFLICTING');
  });
});

describe('正式 SKU 规格选择数据', () => {
  const {
    parseDetailedProductCatalog,
    discoverProductPaths,
  } = require('../src/services/inventoryValidationCatalog');
  const html = comingSoon =>
    `${productHtml([{ ...product, name: 'iPhone 18 Pro 256GB Black' }], 'iphone_18_pro')}<script>window.PRODUCT_SELECTION_BOOTSTRAP = { productSelectionData: ${JSON.stringify({ products: [{ partNumber: 'TEST1CH/A', dimensionScreensize: 'max', dimensionCapacity: '256gb', dimensionColor: 'black', comingSoon }], displayValues: { dimensionScreensize: { max: { value: 'iPhone&nbsp;18&nbsp;Pro&nbsp;Max<span class="form-label-small">6.9英寸</span>' } }, dimensionColor: { black: { value: '黑色' } } } })} };</script>`;
  test('统计标题相同的 Pro Max 以精确 SKU 选择器核对', () => {
    expect(parseDetailedProductCatalog(html(false))[0]).toMatchObject({
      model: 'iPhone 18 Pro Max',
      capacity: '256GB',
      color: '黑色',
      title: 'iPhone 18 Pro Max 256GB 黑色',
    });
  });
  test('未开售排除，选择数据缺失拒绝而非猜测', () => {
    expect(parseDetailedProductCatalog(html(true))).toEqual([]);
    expect(() => parseDetailedProductCatalog(productHtml([product]))).toThrow('SELECTION_MISSING');
    expect(() => parseDetailedProductCatalog(html(false).replace('"256gb"', '"invalid"'))).toThrow(
      'INCOMPLETE'
    );
  });
  test('发现系列限制官方购买路径，不采集外站或配件', () => {
    expect(
      discoverProductPaths(
        '<a href="/shop/buy-iphone/iphone-18-pro">Pro</a><a href="https://evil.test/shop/buy-iphone/iphone-18">外站</a><a href="/shop/accessories">配件</a>'
      )
    ).toEqual(['/shop/buy-iphone/iphone-18-pro']);
  });
});
