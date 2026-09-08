/* eslint-disable no-magic-numbers -- 本文件中的数字均为固定的合成数据夹具 */
const { Op } = require('sequelize');
const {
  sequelize,
  AppleId,
  Recipient,
  Order,
  User,
  UserPermission,
  UserPermissionEvent,
  PaymentTask,
  PaymentTaskEvent,
  PaymentStaffSetting,
} = require('../src/models');
const { MIN_PASSWORD_LENGTH, PERMISSIONS } = require('../src/constants/business');
const { PAYMENT_EXECUTION_PERMISSIONS } = require('../src/constants/permissionCatalog');
const { blindIndex } = require('../src/utils/fieldEncryption');
const logger = require('../src/utils/logger');

const REQUIRED_NODE_ENV = 'development';
const REQUIRED_CONFIRMATION = 'true';
const ALLOWED_DATABASE_HOSTS = new Set(['postgres', 'localhost', '127.0.0.1', '::1']);
const MOCK_APPLE_ID_COUNT = 8;
const MOCK_RECIPIENT_COUNT = 20;
const MOCK_ORDER_COUNT = 48;
const MOCK_STAFF_COUNT = 3;
const MOCK_PAYMENT_TASK_COUNT = 30;
const MOCK_ORDER_NUMBER_BASE = 9100000000;
const MOCK_DATA_MARKER = 'local-mock-v3';

const MOCK_STAFF = [
  {
    username: 'mock_pay_01',
    role: 'operator',
    permissions: [...PAYMENT_EXECUTION_PERMISSIONS],
    autoAssignEnabled: true,
    maxActiveTasks: 20,
  },
  {
    username: 'mock_pay_02',
    role: 'operator',
    permissions: [...PAYMENT_EXECUTION_PERMISSIONS],
    autoAssignEnabled: true,
    maxActiveTasks: 15,
  },
  {
    username: 'mock_pay_viewer',
    role: 'readOnly',
    permissions: [PERMISSIONS.PAYMENT_TASKS_READ_OWN],
    autoAssignEnabled: false,
    maxActiveTasks: 12,
  },
];

const MOCK_TASK_STATUSES = [
  ...Array(15).fill('pending'),
  ...Array(7).fill('processing'),
  ...Array(4).fill('exception'),
  ...Array(4).fill('completed'),
];

const UNASSIGNED_TASK_INDEXES = new Set([4, 9, 14, 19, 22, 24]);
const DEADLINE_MINUTE_OFFSETS = [-5, 3, 7, 12, 20, 35, 45, 60];

const RECIPIENT_STATUSES = [
  ...Array(10).fill('使用中'),
  ...Array(6).fill('未使用'),
  ...Array(2).fill('已下架'),
  ...Array(2).fill('异常'),
];

const ORDER_STATUSES = [
  'pending',
  'processing',
  'ready_for_pickup',
  'shipped',
  'completed',
  'delivered',
  'cancelled',
  'pickup_cancelled',
];

const MOCK_PRODUCTS = [
  { model: 'MYE73CH/A', name: 'iPhone 16 128GB 黑色', amount: 5999 },
  { model: 'MYTQ3CH/A', name: 'iPhone 16 Pro 256GB 原色钛金属', amount: 8999 },
  { model: 'MX2D3CH/A', name: 'iPhone 16 Pro Max 512GB 沙漠色钛金属', amount: 11999 },
  { model: 'MVV83CH/A', name: 'iPad Pro 11 英寸 256GB', amount: 8999 },
  { model: 'MXP93CH/A', name: 'Apple Watch Series 10', amount: 3199 },
  { model: 'MTJV3CH/A', name: 'AirPods Pro（第二代）', amount: 1899 },
];

const PICKUP_STORES = [
  { name: 'Apple 重庆万象城', code: 'R638' },
  { name: 'Apple 成都太古里', code: 'R502' },
  { name: 'Apple 上海南京东路', code: 'R359' },
  { name: 'Apple 北京三里屯', code: 'R320' },
];

const CHANNELS = ['本地验收-A', '本地验收-B', '本地验收-C', '本地验收-D'];

/**
 * 获取当前数据库目标主机。
 * @param {NodeJS.ProcessEnv} env - 环境变量
 * @returns {string} 数据库主机名
 */
function getDatabaseHost(env) {
  if (env.DATABASE_URL) {
    try {
      return new URL(env.DATABASE_URL).hostname;
    } catch (_error) {
      throw new Error('DATABASE_URL 格式无效，拒绝写入本地 Mock 数据');
    }
  }
  return env.DB_HOST || '';
}

/**
 * 校验造数脚本只能在显式确认的本地开发环境运行。
 * @param {NodeJS.ProcessEnv} env - 环境变量
 * @returns {void}
 */
function assertLocalMockEnvironment(env = process.env) {
  if (env.NODE_ENV !== REQUIRED_NODE_ENV) {
    throw new Error(`仅允许在 NODE_ENV=${REQUIRED_NODE_ENV} 时生成本地 Mock 数据`);
  }
  if (env.ALLOW_LOCAL_MOCK_DATA !== REQUIRED_CONFIRMATION) {
    throw new Error('必须显式设置 ALLOW_LOCAL_MOCK_DATA=true 才能生成本地 Mock 数据');
  }

  const databaseHost = getDatabaseHost(env);
  if (!ALLOWED_DATABASE_HOSTS.has(databaseHost)) {
    throw new Error(`数据库主机 ${databaseHost || '(空)'} 不属于允许的本地目标`);
  }

  if (!env.LOCAL_MOCK_USER_PASSWORD || env.LOCAL_MOCK_USER_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`LOCAL_MOCK_USER_PASSWORD 必须显式配置且至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
}

/**
 * 创建相对当前日期的稳定 UTC 时间。
 * @param {Date} referenceDate - 基准日期
 * @param {number} daysAgo - 向前偏移天数
 * @returns {Date} 订单日期
 */
function createOrderDate(referenceDate, daysAgo) {
  const date = new Date(referenceDate);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date;
}

/**
 * 创建相对基准时间的分钟偏移。
 * @param {Date} referenceDate - 基准时间
 * @param {number} minutes - 分钟偏移
 * @returns {Date} 偏移后的时间
 */
function createRelativeTime(referenceDate, minutes) {
  return new Date(new Date(referenceDate).getTime() + minutes * 60 * 1000);
}

/**
 * 生成确定性的合成本地验收数据定义。
 * @param {Date} referenceDate - 订单日期基准
 * @returns {Object} Mock 数据定义
 */
function buildMockDefinitions(referenceDate = new Date()) {
  const appleIds = Array.from({ length: MOCK_APPLE_ID_COUNT }, (_item, index) => ({
    appleId: `mock-apple-${String(index + 1).padStart(2, '0')}@example.com`,
    password: `MockApple${String(index + 1).padStart(2, '0')}!`,
    nickname: `本地验收账号 ${index + 1}`,
    securityQa: [{ question: 'Mock 数据标识', answer: MOCK_DATA_MARKER }],
    country: '中国大陆',
    isModified: false,
    status: index < 5 ? '使用中' : index < 7 ? '未使用' : '异常',
  }));

  const recipients = Array.from({ length: MOCK_RECIPIENT_COUNT }, (_item, index) => {
    const sequence = String(index + 1).padStart(4, '0');
    const appleIndex = index % MOCK_APPLE_ID_COUNT;
    return {
      lastName: '验',
      firstName: `收${String(index + 1).padStart(2, '0')}`,
      idCardNumber: `11010119900101${sequence}`,
      phone: `1390000${sequence}`,
      email: `mock-recipient-${String(index + 1).padStart(2, '0')}@example.com`,
      province: '重庆市',
      city: '重庆市',
      district: ['渝中区', '江北区', '南岸区', '九龙坡区'][index % 4],
      streetAddress: `本地验收路 ${index + 1} 号`,
      appleIndex,
      tag: CHANNELS[index % CHANNELS.length],
      status: RECIPIENT_STATUSES[index],
      notes: MOCK_DATA_MARKER,
    };
  });

  const orders = Array.from({ length: MOCK_ORDER_COUNT }, (_item, index) => {
    const product = MOCK_PRODUCTS[index % MOCK_PRODUCTS.length];
    const store = PICKUP_STORES[index % PICKUP_STORES.length];
    const quantity = (index % 2) + 1;
    const hasPaymentTask = index < MOCK_PAYMENT_TASK_COUNT;
    const taskStatus = hasPaymentTask ? MOCK_TASK_STATUSES[index] : null;
    const status = hasPaymentTask
      ? taskStatus === 'completed'
        ? 'processing'
        : index % 2 === 0
          ? 'pending'
          : 'processing'
      : ORDER_STATUSES[index % ORDER_STATUSES.length];
    const orderNumber = `W${MOCK_ORDER_NUMBER_BASE + index + 1}`;
    const deadlineMinuteOffset = DEADLINE_MINUTE_OFFSETS[index % DEADLINE_MINUTE_OFFSETS.length];
    return {
      orderNumber,
      appleIndex: index % MOCK_APPLE_ID_COUNT,
      recipientIndex: index % MOCK_RECIPIENT_COUNT,
      products: [{ model: product.model, name: product.name, quantity }],
      status,
      orderUrl: hasPaymentTask
        ? `https://www.apple.com.cn/xc/cn/vieworder/${orderNumber}/local-mock-${index + 1}`
        : null,
      paymentMethod: ['支付宝', '微信支付', '银行卡'][index % 3],
      paymentStatus: hasPaymentTask
        ? taskStatus === 'completed'
          ? 'paid'
          : 'unpaid'
        : ['paid', 'unpaid', 'refunded'][index % 3],
      officialOrderAmount: product.amount * quantity,
      officialOrderAmountCurrency: 'CNY',
      payerName: null,
      paymentScreenshot: [],
      pickupStore: store.name,
      pickupStoreCode: store.code,
      pickupStatus: status === 'completed' || status === 'delivered' ? '已取货' : '待取货',
      pickupTimeSlot: '18:00-18:15',
      orderDate: createOrderDate(referenceDate, index % 12),
      officialOrderCreatedAt: hasPaymentTask
        ? createRelativeTime(referenceDate, deadlineMinuteOffset - 30)
        : null,
      lastCrawledAt: hasPaymentTask
        ? new Date(referenceDate)
        : createOrderDate(referenceDate, index % 12),
      crawlFailCount: 0,
      officialProducts: [{ model: product.model, name: product.name, quantity }],
      validationStatus: 'valid',
      validationIssues: [],
      autoRefreshEnabled: false,
      autoRefreshStopReason: MOCK_DATA_MARKER,
      autoRefreshStoppedAt: new Date(referenceDate),
      tag: CHANNELS[index % CHANNELS.length],
      notes: MOCK_DATA_MARKER,
    };
  });

  const paymentTasks = Array.from({ length: MOCK_PAYMENT_TASK_COUNT }, (_item, index) => {
    const processingStatus = MOCK_TASK_STATUSES[index];
    const deadlineMinutes = DEADLINE_MINUTE_OFFSETS[index % DEADLINE_MINUTE_OFFSETS.length];
    const isCompleted = processingStatus === 'completed';
    return {
      orderIndex: index,
      assigneeIndex: UNASSIGNED_TASK_INDEXES.has(index) ? null : index % MOCK_STAFF_COUNT,
      payerName: index % 4 === 0 ? null : `测试付款人 ${String((index % 6) + 1).padStart(2, '0')}`,
      processingStatus,
      processingNotes:
        processingStatus === 'exception'
          ? '本地 Mock：等待人工核对付款异常'
          : isCompleted
            ? '本地 Mock：已登记付款完成'
            : processingStatus === 'processing'
              ? '本地 Mock：付款处理中'
              : null,
      deadlineAt: createRelativeTime(referenceDate, deadlineMinutes),
      deadlineSource: 'official',
      eligibilityVerifiedAt: null,
      eligibilityValidUntil: null,
      paymentLinkSource: isCompleted ? null : 'order_url',
      assignedAt: UNASSIGNED_TASK_INDEXES.has(index)
        ? null
        : createRelativeTime(referenceDate, -10),
      completedAt: isCompleted ? createRelativeTime(referenceDate, -2) : null,
    };
  });

  return {
    appleIds,
    recipients,
    orders,
    staff: MOCK_STAFF.map(item => ({ ...item, permissions: [...item.permissions] })),
    paymentTasks,
  };
}

/**
 * 向本地开发数据库写入或更新合成验收数据。
 * @param {Date} referenceDate - 订单日期基准
 * @returns {Promise<Object>} 写入结果统计
 */
async function seedLocalMockData(referenceDate = new Date()) {
  assertLocalMockEnvironment();
  const definitions = buildMockDefinitions(referenceDate);
  const mockUserPassword = process.env.LOCAL_MOCK_USER_PASSWORD;

  const result = await sequelize.transaction(async transaction => {
    const admin = await User.findOne({
      where: { role: 'admin', status: 'active' },
      attributes: ['id'],
      transaction,
    });
    if (!admin) {
      throw new Error('本地开发库缺少可用管理员，无法创建可审计的 Mock 权限数据');
    }

    const staffAccounts = [];
    for (const definition of definitions.staff) {
      const [staffAccount, created] = await User.findOrCreate({
        where: { username: definition.username },
        defaults: {
          username: definition.username,
          password: mockUserPassword,
          role: definition.role,
          status: 'active',
          failedLoginAttempts: 0,
          lockedUntil: null,
          forcePasswordChange: false,
          permissionsVersion: 0,
        },
        transaction,
      });
      if (!created) {
        await staffAccount.update(
          {
            password: mockUserPassword,
            role: definition.role,
            status: 'active',
            failedLoginAttempts: 0,
            lockedUntil: null,
            forcePasswordChange: false,
          },
          { transaction }
        );
      }

      const existingPermissions = await UserPermission.findAll({
        where: { userId: staffAccount.id },
        attributes: ['permissionCode'],
        transaction,
      });
      const beforePermissions = existingPermissions.map(item => item.permissionCode).sort();
      await UserPermission.destroy({ where: { userId: staffAccount.id }, transaction });
      await UserPermission.bulkCreate(
        definition.permissions.map(permissionCode => ({
          userId: staffAccount.id,
          permissionCode,
          grantedBy: admin.id,
        })),
        { transaction }
      );
      const beforeVersion = staffAccount.permissionsVersion;
      staffAccount.permissionsVersion += 1;
      await staffAccount.save({ transaction });
      await UserPermissionEvent.create(
        {
          userId: staffAccount.id,
          actorUserId: admin.id,
          beforePermissions,
          afterPermissions: [...definition.permissions].sort(),
          reason: '本地 Mock 体验数据授权',
          beforeVersion,
          afterVersion: staffAccount.permissionsVersion,
          idempotencyKey:
            `${MOCK_DATA_MARKER}-permissions-` +
            `${staffAccount.id}-${staffAccount.permissionsVersion}`,
          source: 'local_mock',
        },
        { transaction }
      );

      const [staffSetting] = await PaymentStaffSetting.findOrCreate({
        where: { userId: staffAccount.id },
        defaults: {
          userId: staffAccount.id,
          autoAssignEnabled: definition.autoAssignEnabled,
          maxActiveTasks: definition.maxActiveTasks,
          updatedBy: admin.id,
        },
        transaction,
      });
      await staffSetting.update(
        {
          autoAssignEnabled: definition.autoAssignEnabled,
          maxActiveTasks: definition.maxActiveTasks,
          updatedBy: admin.id,
        },
        { transaction }
      );
      staffAccounts.push(staffAccount);
    }

    const appleAccounts = [];
    for (const definition of definitions.appleIds) {
      const [appleAccount] = await AppleId.findOrCreate({
        where: { appleId: definition.appleId },
        defaults: definition,
        transaction,
      });
      await appleAccount.update(definition, { transaction });
      appleAccounts.push(appleAccount);
    }

    const recipients = [];
    for (const definition of definitions.recipients) {
      const appleAccount = appleAccounts[definition.appleIndex];
      const recipientData = {
        ...definition,
        appleId: appleAccount.appleId,
        password: appleAccount.password,
        appleIdRef: appleAccount.id,
      };
      delete recipientData.appleIndex;

      const [recipient] = await Recipient.findOrCreate({
        where: { idCardHash: blindIndex(definition.idCardNumber) },
        defaults: recipientData,
        transaction,
      });
      await recipient.update(recipientData, { transaction });
      recipients.push(recipient);
    }

    const orders = [];
    for (const definition of definitions.orders) {
      const appleAccount = appleAccounts[definition.appleIndex];
      const recipient = recipients[definition.recipientIndex];
      const orderData = {
        ...definition,
        appleIdRef: appleAccount.id,
        appleId: appleAccount.appleId,
        applePassword: appleAccount.password,
        recipientRef: recipient.id,
        recipientName: `${recipient.lastName}${recipient.firstName}`,
        recipientIdCard: recipient.idCardNumber,
        recipientPhone: recipient.phone,
        recipientEmail: recipient.email,
        recipientAddress:
          `${recipient.province}${recipient.city}${recipient.district}` + recipient.streetAddress,
      };
      delete orderData.appleIndex;
      delete orderData.recipientIndex;

      const [order] = await Order.findOrCreate({
        where: { orderNumber: definition.orderNumber },
        defaults: orderData,
        transaction,
      });
      await order.update(orderData, { transaction });
      orders.push(order);
    }

    const paymentTasks = [];
    for (const [index, definition] of definitions.paymentTasks.entries()) {
      const order = orders[definition.orderIndex];
      const assignee =
        definition.assigneeIndex === null ? null : staffAccounts[definition.assigneeIndex];
      await order.update(
        {
          payerName: definition.payerName,
          payerVersion: definition.payerName ? 1 : 0,
        },
        { transaction }
      );

      const taskData = {
        orderId: order.id,
        assigneeUserId: assignee?.id || null,
        processingStatus: definition.processingStatus,
        processingNotes: definition.processingNotes,
        deadlineAt: definition.deadlineAt,
        deadlineSource: definition.deadlineSource,
        eligibilityVerifiedAt: definition.eligibilityVerifiedAt,
        eligibilityValidUntil: definition.eligibilityValidUntil,
        eligibilityVerifiedBy: definition.eligibilityVerifiedAt ? admin.id : null,
        paymentLinkSource: definition.paymentLinkSource,
        assignedAt: definition.assignedAt,
        completedAt: definition.completedAt,
        version: 0,
      };
      const [paymentTask] = await PaymentTask.findOrCreate({
        where: { orderId: order.id },
        defaults: taskData,
        transaction,
      });
      await paymentTask.update(taskData, { transaction });
      await PaymentTaskEvent.findOrCreate({
        where: {
          actorUserId: admin.id,
          idempotencyKey: `${MOCK_DATA_MARKER}-task-${index + 1}`,
        },
        defaults: {
          paymentTaskId: paymentTask.id,
          eventType: assignee ? 'assigned' : 'registered',
          actorUserId: admin.id,
          fromUserId: null,
          toUserId: assignee?.id || null,
          beforeStatus: null,
          afterStatus: definition.processingStatus,
          details: { marker: MOCK_DATA_MARKER },
          idempotencyKey: `${MOCK_DATA_MARKER}-task-${index + 1}`,
        },
        transaction,
      });
      paymentTasks.push(paymentTask);
    }

    const latestOrderAt = createOrderDate(referenceDate, 0);
    await AppleId.update(
      { lastOrderAt: latestOrderAt },
      {
        where: { appleId: { [Op.like]: 'mock-apple-%@example.com' } },
        transaction,
      }
    );
    await Recipient.update(
      { lastOrderAt: latestOrderAt },
      {
        where: { notes: MOCK_DATA_MARKER },
        transaction,
      }
    );

    return {
      appleIds: appleAccounts.length,
      recipients: recipients.length,
      availableRecipients: definitions.recipients.filter(recipient =>
        ['使用中', '未使用'].includes(recipient.status)
      ).length,
      orders: definitions.orders.length,
      staff: staffAccounts.length,
      paymentTasks: paymentTasks.length,
      assignedPaymentTasks: definitions.paymentTasks.filter(task => task.assigneeIndex !== null)
        .length,
      unassignedPaymentTasks: definitions.paymentTasks.filter(task => task.assigneeIndex === null)
        .length,
      marker: MOCK_DATA_MARKER,
    };
  });

  return result;
}

async function main() {
  try {
    const result = await seedLocalMockData();
    logger.info('本地 Mock 验收数据生成完成', result);
  } catch (error) {
    logger.error('本地 Mock 验收数据生成失败', {
      error: error.message,
      stack: error.stack,
    });
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  assertLocalMockEnvironment,
  buildMockDefinitions,
  seedLocalMockData,
};
