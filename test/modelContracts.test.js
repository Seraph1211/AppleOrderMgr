const { Sequelize } = require('sequelize');

describe('模型安全与关联契约', () => {
  const originalKey = process.env.FIELD_ENCRYPTION_KEY;
  const originalVersion = process.env.FIELD_ENCRYPTION_KEY_VERSION;
  let sequelize;
  let models;

  beforeAll(() => {
    process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    process.env.FIELD_ENCRYPTION_KEY_VERSION = 'v1';

    sequelize = new Sequelize('postgres://test:test@localhost:5432/test', {
      logging: false,
    });
    models = {
      User: require('../src/models/User')(sequelize),
      AppleId: require('../src/models/AppleId')(sequelize),
      Recipient: require('../src/models/Recipient')(sequelize),
      Order: require('../src/models/Order')(sequelize),
      EmailLog: require('../src/models/EmailLog')(sequelize),
      EmailWorkerState: require('../src/models/EmailWorkerState')(sequelize),
      CrawlLog: require('../src/models/CrawlLog')(sequelize),
      OrderRefreshSchedule: require('../src/models/OrderRefreshSchedule')(sequelize),
      OrderRefreshBatch: require('../src/models/OrderRefreshBatch')(sequelize),
      OrderRefreshJob: require('../src/models/OrderRefreshJob')(sequelize),
      OrderRefreshSystemState: require('../src/models/OrderRefreshSystemState')(sequelize),
    };

    Object.values(models).forEach(model => {
      if (model.associate) model.associate(models);
    });
  });

  afterAll(async () => {
    await sequelize.close();
    if (originalKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
    else process.env.FIELD_ENCRYPTION_KEY = originalKey;
    if (originalVersion === undefined) delete process.env.FIELD_ENCRYPTION_KEY_VERSION;
    else process.env.FIELD_ENCRYPTION_KEY_VERSION = originalVersion;
  });

  test('合法身份证号应先解密校验再派生后四位和盲索引', async () => {
    const recipient = models.Recipient.build({
      lastName: '张',
      firstName: '三',
      idCardNumber: '110101199001011234',
    });

    await expect(recipient.validate()).resolves.toBeDefined();
    expect(recipient.idCardNumber).toBe('110101199001011234');
    expect(recipient.getDataValue('idCardNumber')).toMatch(/^enc:v1:/);
    expect(recipient.idCardLast4).toBe('1234');
    expect(recipient.idCardHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('非法身份证号应在写库前被拒绝', async () => {
    const recipient = models.Recipient.build({
      lastName: '张',
      firstName: '三',
      idCardNumber: 'not-an-id-card',
    });

    await expect(recipient.validate()).rejects.toThrow('身份证号格式无效');
  });

  test('关联应复用 camelCase 属性，不得隐式生成重复的 snake_case 属性', () => {
    expect(models.Recipient.rawAttributes).not.toHaveProperty('apple_id_ref');
    expect(models.Recipient.rawAttributes).not.toHaveProperty('recipient_ref');
    expect(models.Order.rawAttributes).not.toHaveProperty('apple_id_ref');
    expect(models.Order.rawAttributes).not.toHaveProperty('recipient_ref');
    expect(models.CrawlLog.rawAttributes).not.toHaveProperty('order_id');
    expect(models.EmailLog.rawAttributes).not.toHaveProperty('order_id');

    expect(models.Recipient.rawAttributes).toHaveProperty('appleIdRef');
    expect(models.Order.rawAttributes).toHaveProperty('appleIdRef');
    expect(models.Order.rawAttributes).toHaveProperty('recipientRef');
    expect(models.CrawlLog.rawAttributes).toHaveProperty('orderId');
    expect(models.EmailLog.rawAttributes).toHaveProperty('orderId');
  });

  test('邮件原文、解析数据和人工草稿使用加密存储', () => {
    const log = models.EmailLog.build({
      emailUid: '1',
      rawContent: 'raw mime',
      parsedData: { orderNumber: 'W1234567890' },
      manualDraft: { applePassword: 'secret' },
      finalData: { recipient: { idCard: '110101199001011234' } },
      attemptHistory: [{ errorCode: 'PRODUCT_INVALID' }],
      auditHistory: [{ action: 'view_full_detail', userId: 1 }],
    });

    expect(log.getDataValue('rawContent')).toMatch(/^enc:v1:/);
    expect(log.getDataValue('parsedData')).toHaveProperty('__encrypted');
    expect(log.getDataValue('manualDraft')).toHaveProperty('__encrypted');
    expect(log.getDataValue('finalData')).toHaveProperty('__encrypted');
    expect(log.getDataValue('attemptHistory')).toHaveProperty('__encrypted');
    expect(log.getDataValue('auditHistory')).toHaveProperty('__encrypted');
    expect(log.manualDraft.applePassword).toBe('secret');
  });
});
