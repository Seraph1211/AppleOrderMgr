const { generatePhone } = require('../src/utils/contactGenerator');
const NEAR_ONE_RANDOM_VALUE = 0.99;

describe('取机人联系方式生成', () => {
  test('生成的号码符合手机号基础格式', () => {
    const phone = generatePhone(() => 0);

    expect(phone).toBe('13000000000');
    expect(phone).toMatch(/^1[3-9]\d{9}$/);
  });

  test('号码不固定为 138 号段', () => {
    const phone = generatePhone(() => NEAR_ONE_RANDOM_VALUE);

    expect(phone).toBe('19999999999');
    expect(phone.startsWith('138')).toBe(false);
  });
});
