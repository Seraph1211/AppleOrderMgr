const { validateManualOrderData } = require('../src/services/emailManualData');
const { EMAIL_ERROR_CODES } = require('../src/services/emailErrors');

function validDraft() {
  return {
    appleId: 'Admin@Example.com',
    applePassword: 'Apple-password',
    orderNumber: 'w1234567890',
    orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/admin@example.com',
    orderDate: '2025-10-08T20:21:58+08:00',
    orderStatus: 'processing',
    products: [{ model: 'mg0a4ch/a', name: 'iPhone 17 Pro Max', quantity: 2 }],
    recipient: {
      name: '张三',
      idLast4: '1234',
      idCard: '110101199001011234',
      email: 'receiver@example.com',
      phone: '13800138000',
      address: '北京市测试地址',
      tag: '北京',
    },
    paymentMethod: '支付宝',
  };
}

describe('人工邮件草稿校验', () => {
  test('日期不能冒充精确下单时间，无时区完整时间按北京时间解释', () => {
    expect(() => validateManualOrderData({ ...validDraft(), orderDate: '2026-09-09' })).toThrow();
    expect(
      validateManualOrderData({
        ...validDraft(),
        orderDate: '2026-09-09T13:24:25',
      }).orderDate.toISOString()
    ).toBe('2026-09-09T05:24:25.000Z');
  });

  test('允许管理员填写密码、完整身份证号和系统内部状态', () => {
    const result = validateManualOrderData(validDraft());
    expect(result.appleId).toBe('admin@example.com');
    expect(result.applePassword).toBe('Apple-password');
    expect(result.recipient.idCard).toBe('110101199001011234');
    expect(result.recipient.idLast4).toBe('1234');
    expect(result.orderStatus).toBe('processing');
  });

  test('完整身份证号优先派生后四位', () => {
    const draft = validDraft();
    draft.recipient.idLast4 = '9999';
    expect(validateManualOrderData(draft).recipient.idLast4).toBe('1234');
  });

  test.each([
    [
      draft => {
        draft.orderStatus = 'arbitrary';
      },
      EMAIL_ERROR_CODES.INVALID_STATE,
    ],
    [
      draft => {
        draft.orderUrl = 'https://www.apple.com.cn/xc/cn/vieworder/W9999999999/admin@example.com';
      },
      EMAIL_ERROR_CODES.ORDER_URL_MISMATCH,
    ],
    [
      draft => {
        draft.products[0].quantity = 0;
      },
      EMAIL_ERROR_CODES.PRODUCT_INVALID,
    ],
    [
      draft => {
        draft.recipient.idCard = 'invalid';
      },
      EMAIL_ERROR_CODES.RECIPIENT_INVALID,
    ],
  ])('拒绝非法或不一致的人工字段', (mutate, errorCode) => {
    const draft = validDraft();
    mutate(draft);
    expect(() => validateManualOrderData(draft)).toThrow(
      expect.objectContaining({ code: errorCode })
    );
  });
});
