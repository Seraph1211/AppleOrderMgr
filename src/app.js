/**
 * Express 应用入口
 * @module app
 * @description 装配中间件、路由、错误处理、健康检查、优雅关闭
 * @see docs/design/API设计.md
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const logger = require('./utils/logger');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const ApiError = require('./utils/ApiError');
const { validateEncryptionConfiguration } = require('./utils/fieldEncryption');
const { authenticate, checkPasswordChangeRequired } = require('./middleware/authMiddleware');

const appleIdsRouter = require('./routes/appleIds');
const recipientsRouter = require('./routes/recipients');
const ordersRouter = require('./routes/orders');
const statsRouter = require('./routes/stats');
const importRouter = require('./routes/importRoutes');
const dashboardRouter = require('./routes/dashboardRoutes');
const channelsRouter = require('./routes/channels');
const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const systemRouter = require('./routes/system');
const orderRefreshRouter = require('./routes/orderRefresh');
const emailProcessingRouter = require('./routes/emailProcessing');
const paymentTasksRouter = require('./routes/paymentTasks');
const paymentDispatchRouter = require('./routes/paymentDispatch');

const { sequelize } = require('./models');
const emailService = require('./services/emailService');
const refreshWorkerService = require('./services/crawler/refreshWorkerService');
const paymentDispatchScheduler = require('./services/paymentDispatchScheduler');

const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3001';

const app = express();

if (process.env.TRUST_PROXY) {
  const trustProxy = /^\d+$/.test(process.env.TRUST_PROXY)
    ? Number(process.env.TRUST_PROXY)
    : process.env.TRUST_PROXY;
  app.set('trust proxy', trustProxy);
}

if (
  !process.env.JWT_SECRET ||
  process.env.JWT_SECRET.length < 32 ||
  process.env.JWT_SECRET.includes('your_jwt_secret')
) {
  throw new Error('JWT_SECRET 必须显式配置且至少 32 个字符');
}
validateEncryptionConfiguration();

// ---------- 基础中间件 ----------
app.disable('x-powered-by');

// 允许较大的请求体（支持上传 base64 图片，最多 10MB）
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(
  cors({
    origin: process.env.NODE_ENV === 'production' ? FRONTEND_URL : true, // 开发模式允许任意 origin
    credentials: true,
  })
);

app.use(requestLogger());

// ---------- 健康检查 ----------
app.get('/api/health/live', (_req, res) => {
  res.json({ success: true, data: { status: 'alive', timestamp: new Date().toISOString() } });
});

app.get('/api/health/ready', async (_req, res) => {
  let dbStatus = 'ok';
  try {
    await sequelize.authenticate();
  } catch (error) {
    dbStatus = 'down';
    logger.error('健康检查：数据库连接失败', { error: error.message });
  }
  res.status(dbStatus === 'ok' ? 200 : 503).json({
    success: dbStatus === 'ok',
    data: {
      service: 'apple-order-manager',
      status: dbStatus === 'ok' ? 'healthy' : 'degraded',
      db: dbStatus,
      uptimeSeconds: Math.round(process.uptime()),
      nodeEnv: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
    },
  });
});

app.get('/api/health', (_req, res) => res.redirect(307, '/api/health/ready'));

// ---------- 业务路由 ----------
app.use('/api/auth', authRouter);
app.use('/api', authenticate, checkPasswordChangeRequired);
app.use('/api/users', usersRouter);
app.use('/api/apple-ids', appleIdsRouter);
app.use('/api/recipients', recipientsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/order-refresh', orderRefreshRouter);
app.use('/api/email-processing', emailProcessingRouter);
app.use('/api/stats', statsRouter);
app.use('/api/import', importRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/channels', channelsRouter);
app.use('/api/system', systemRouter);
app.use('/api/payment-tasks', paymentTasksRouter);
app.use('/api/payment-dispatch', paymentDispatchRouter);

// ---------- 404 兜底 ----------
app.use((req, _res, next) => {
  next(
    ApiError.notFound(
      `路由不存在: ${req.method} ${req.originalUrl}`,
      { method: req.method, url: req.originalUrl },
      'NOT_FOUND'
    )
  );
});

// ---------- 统一错误处理（必须放在最后） ----------
app.use(errorHandler);

// ---------- 启动服务 ----------
const server = app.listen(DEFAULT_PORT, () => {
  logger.info('🚀 Apple Order Manager API 已启动', {
    port: DEFAULT_PORT,
    env: process.env.NODE_ENV || 'development',
    url: `http://localhost:${DEFAULT_PORT}`,
    apiHealth: `http://localhost:${DEFAULT_PORT}/api/health`,
  });

  paymentDispatchScheduler.start();

  if (process.env.RUN_WORKERS_IN_API === 'true') {
    try {
      emailService.startEmailService();
      logger.info('邮件监听服务启动请求已发送');
    } catch (error) {
      logger.error('邮件监听服务启动失败', { error: error.message });
    }
    refreshWorkerService.start().catch(error => {
      logger.error('自动刷新调度器启动失败', { error: error.message });
    });
  }
});

// ---------- 优雅关闭 ----------
function shutdown(signal) {
  logger.info(`收到 ${signal} 信号，准备关闭服务`);

  // 停止领取新的后台任务；邮件在途处理在关闭数据库前等待完成。
  refreshWorkerService.stop();
  paymentDispatchScheduler.stop();

  server.close(async err => {
    if (err) {
      logger.error('关闭 HTTP 服务失败', { error: err.message });
      process.exit(1);
    }

    try {
      await emailService.stopEmailService();
      await sequelize.close();
      logger.info('数据库连接已关闭');
    } catch (closeErr) {
      logger.error('关闭数据库连接失败', { error: closeErr.message });
    }

    process.exit(0);
  });

  // 兜底：10s 强制退出
  setTimeout(() => {
    logger.warn('优雅关闭超时，强制退出');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', reason => {
  logger.error('未处理的 Promise Rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  shutdown('unhandledRejection');
});

process.on('uncaughtException', err => {
  logger.error('未捕获的异常', { error: err.message, stack: err.stack });
  shutdown('uncaughtException');
});

module.exports = app;
