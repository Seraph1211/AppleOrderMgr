jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { parseOrderEmail, parseProducts } = require('../src/services/emailParser');
const { EMAIL_ERROR_CODES } = require('../src/services/emailErrors');
const {
  buildHtmlBody,
  buildMime,
  singleHtml,
  multipleHtml,
  plainText,
  base64Html,
} = require('./fixtures/emailMessages');

describe('邮件解析器严格契约', () => {
  test('准确解析单商品并限制标签边界', async () => {
    const result = await parseOrderEmail(singleHtml);
    expect(result.appleId).toBe('test@hotmail.com');
    expect(result.orderNumber).toBe('W1234567890');
    expect(result.products).toEqual([
      {
        model: 'MG0A4CH/A',
        name: 'iPhone 17 Pro Max 星宇橙色 1T',
        quantity: 2,
        image: null,
      },
    ]);
    expect(result.recipient).toEqual({ name: '李浩', idLast4: '603X', tag: '天津' });
  });

  test('多商品必须全部解析且 Apple ID 中的 @ 不参与商品分割', async () => {
    const result = await parseOrderEmail(multipleHtml);
    expect(result.appleId).toBe('tzvcantetc8k@hotmail.com');
    expect(result.products).toHaveLength(2);
    expect(result.products[1]).toMatchObject({ model: 'HNPW2ZM/A', quantity: 1 });
    expect(result.recipient.tag).toBe('水果惠');
  });

  test('正文时间明确按中国 +08:00 解析', async () => {
    const result = await parseOrderEmail(singleHtml);
    expect(result.orderDate.toISOString()).toBe('2025-10-08T12:21:58.000Z');
  });

  test('支持纯文本、换行以及包含斜杠的商品型号和名称', async () => {
    const result = await parseOrderEmail(plainText);
    expect(result.products[0]).toMatchObject({
      model: 'MY/123',
      name: 'iPhone 测试款 / 256G',
      quantity: 1,
    });
    expect(result.recipient.tag).toBe('北京');
  });

  test('支持 MIME Base64 与 HTML 实体', async () => {
    const result = await parseOrderEmail(base64Html);
    expect(result.products[0].name).toBe('iPhone & 配件');
  });

  test('字符串输入按 UTF-8 MIME 处理且原文统一保存为 Base64', async () => {
    const result = await parseOrderEmail(singleHtml);
    expect(Buffer.from(result.rawContent, 'base64').toString('utf8')).toBe(singleHtml);
  });

  test('任一商品片段失败时整封邮件失败', () => {
    expect(() => parseProducts('MG0A4CH/A-iPhone x 1@无法识别商品')).toThrow(
      expect.objectContaining({ code: EMAIL_ERROR_CODES.PRODUCT_INVALID })
    );
  });

  test.each([
    ['', EMAIL_ERROR_CODES.BODY_MISSING],
    [
      buildMime({ body: '完全未知模板', contentType: 'text/plain' }),
      EMAIL_ERROR_CODES.APPLE_ID_INVALID,
    ],
    [
      buildMime({
        body: buildHtmlBody({
          appleId: 'bad@example.com',
          orderNumber: 'W3333333333',
          products: 'INVALID',
          recipient: '赵六',
          tag: '深圳',
        }),
      }),
      EMAIL_ERROR_CODES.ORDER_BLOCK_MISSING,
    ],
    [
      buildMime({
        body: buildHtmlBody({
          appleId: 'badqty@example.com',
          orderNumber: 'W4444444444',
          products: 'AB123CH/A-iPhone x 0',
          recipient: '赵六',
          tag: '深圳',
        }),
      }),
      EMAIL_ERROR_CODES.ORDER_BLOCK_MISSING,
    ],
  ])('异常模板以稳定错误码失败', async (mime, code) => {
    await expect(parseOrderEmail(mime)).rejects.toMatchObject({ code });
  });
});
