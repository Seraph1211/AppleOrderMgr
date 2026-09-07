const { canDisplayLocalSensitiveFields } = require('../src/utils/localSensitiveDisplay');

describe('本地敏感字段展示门禁', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDisplayFlag = process.env.ALLOW_LOCAL_SENSITIVE_DISPLAY;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    if (originalDisplayFlag === undefined) delete process.env.ALLOW_LOCAL_SENSITIVE_DISPLAY;
    else process.env.ALLOW_LOCAL_SENSITIVE_DISPLAY = originalDisplayFlag;
  });

  test('development 环境显式开启且为 admin 时允许展示', () => {
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_LOCAL_SENSITIVE_DISPLAY = 'true';

    expect(canDisplayLocalSensitiveFields({ user: { role: 'admin' } })).toBe(true);
  });

  test.each([
    ['production 环境', 'production', 'true', 'admin'],
    ['未开启配置', 'development', 'false', 'admin'],
    ['operator 用户', 'development', 'true', 'operator'],
    ['readOnly 用户', 'development', 'true', 'readOnly'],
  ])('%s 保持脱敏', (_caseName, nodeEnv, displayFlag, role) => {
    process.env.NODE_ENV = nodeEnv;
    process.env.ALLOW_LOCAL_SENSITIVE_DISPLAY = displayFlag;

    expect(canDisplayLocalSensitiveFields({ user: { role } })).toBe(false);
  });
});
