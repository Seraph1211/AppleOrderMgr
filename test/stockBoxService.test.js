jest.mock('../src/models', () => ({ StockProduct: { findAll: jest.fn() } }));
jest.mock('../src/services/pickupOcrService', () => ({ recognize: jest.fn() }));
jest.mock('../src/services/stockCommandService', () => ({
  createReadContext: jest.fn(),
  requirePermissions: jest.fn(),
}));
const db = require('../src/models');
const ocr = require('../src/services/pickupOcrService');
const command = require('../src/services/stockCommandService');
const { recognizeBox } = require('../src/services/stockBoxService');
const { fixedCost, CATALOG, specification } = require('../src/services/stockFixedCatalog');
const logger = require('../src/utils/logger');
const product = { ...CATALOG[0], id: 'product-1' };
beforeEach(() => {
  jest.clearAllMocks();
  command.createReadContext.mockResolvedValue({
    permissions: new Set(['stock.read', 'stock.receive']),
    user: { id: 1 },
  });
  db.StockProduct.findAll.mockResolvedValue([product]);
  ocr.recognize.mockImplementation(async (_file, parser) => {
    try {
      await Promise.resolve();
      return parser({
        data: JSON.stringify({ content: 'MJY64CH/A\nSerial No. AB12CD34EF' }),
        requestId: 'synthetic',
      });
    } catch (error) {
      logger.debug('合成OCR', { code: error.code });
      throw error;
    }
  });
});
test('无成本读取权限的候选无价格数据，清理buffer', async () => {
  try {
    const file = { buffer: Buffer.from('fake') };
    const result = await recognizeBox({ id: 1 }, file);
    expect(result.candidates[0].productId).toBe(product.id);
    expect(result.candidates[0]).not.toHaveProperty('fixedCostAmount');
    expect(file.buffer).toBeNull();
  } catch (error) {
    logger.debug('合成OCR', { code: error.code });
    throw error;
  }
});
test('合法历史补录权限及成本投影', async () => {
  try {
    command.createReadContext.mockResolvedValue({
      permissions: new Set([
        'stock.read',
        'stock.import',
        'stock.sales.edit',
        'stock.sales.ship',
        'stock.cost.read',
      ]),
    });
    const result = await recognizeBox({ id: 1 }, {});
    expect(result.candidates[0].fixedCostAmount).toBe('10999.00');
  } catch (error) {
    logger.debug('合成OCR', { code: error.code });
    throw error;
  }
});
test('无录入权限拒绝且不调用云端', async () => {
  try {
    command.createReadContext.mockResolvedValue({ permissions: new Set(['stock.read']) });
    await expect(recognizeBox({ id: 1 }, {})).rejects.toMatchObject({ statusCode: 403 });
    expect(ocr.recognize).not.toHaveBeenCalled();
  } catch (error) {
    logger.debug('合成OCR', { code: error.code });
    throw error;
  }
});
test.each(['invalid', '{}', '[1]', JSON.stringify(Array(21).fill('A'))])(
  '非法条码输入拒绝 %s',
  async input => {
    try {
      await expect(recognizeBox({ id: 1 }, {}, input)).rejects.toMatchObject({ statusCode: 400 });
      expect(ocr.recognize).not.toHaveBeenCalled();
    } catch (error) {
      logger.debug('合成OCR', { code: error.code });
      throw error;
    }
  }
);
test('合法条码参与交叉核对且目录失效需核对', async () => {
  try {
    db.StockProduct.findAll.mockResolvedValue([]);
    const result = await recognizeBox({ id: 1 }, {}, '["SAB12CD34EF"]');
    expect(result.candidates[0].reviewReasons).toContain('规格目录不可用，请核对');
  } catch (error) {
    logger.debug('合成OCR', { code: error.code });
    throw error;
  }
});
test('异常云端结果转化安全错误', async () => {
  try {
    ocr.recognize.mockImplementation(async (_file, parser) => {
      try {
        await Promise.resolve();
        return parser({ code: 'Failed' });
      } catch (error) {
        logger.debug('合成OCR', { code: error.code });
        throw error;
      }
    });
    await expect(recognizeBox({ id: 1 }, {})).rejects.toMatchObject({ code: 'OCR_FAILED' });
  } catch (error) {
    logger.debug('合成OCR', { code: error.code });
    throw error;
  }
});
test('固定价重新读取可信版本，停用或改价拒绝', async () => {
  try {
    const model = {
      StockOfficialPrice: {
        findOne: jest.fn().mockResolvedValue({ id: 'price', amount: '10999.00' }),
      },
    };
    expect(await fixedCost(model, product)).toMatchObject({
      priceId: 'price',
      costSource: 'fixed_catalog',
    });
    model.StockOfficialPrice.findOne.mockResolvedValue({ amount: '1.00' });
    await expect(fixedCost(model, product)).rejects.toMatchObject({
      code: 'FIXED_PRICE_UNAVAILABLE',
    });
    expect(await fixedCost(model, { ...product, modelName: 'other' })).toEqual({});
    expect(specification({ ...product, skuCode: 'UNKNOWN' })).toBeNull();
  } catch (error) {
    logger.debug('合成OCR', { code: error.code });
    throw error;
  }
});
