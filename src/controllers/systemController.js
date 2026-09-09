/* eslint-disable camelcase */
const { Op } = require('sequelize');
const { CrawlLog, Order, OrderRefreshJob, OrderRefreshSchedule } = require('../models');
const refreshJobRepository = require('../services/crawler/refreshJobRepository');
const {
  SUPPORTED_PROXY_PROVIDERS,
  isProxyProviderConfigured,
  isSupportedProxyProvider,
} = require('../services/crawler/proxy/proxyProvider');
const { config } = require('../utils/config');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');
const { paginatedResponse, parsePositiveInt } = require('../utils/apiResponse');

const LOG_TYPES = [
  'crawler',
  'proxy',
  'wind_control',
  'product_validation',
  'amount_parse',
  'scheduler',
];
const SEVERITIES = ['error', 'warn', 'info', 'debug'];

/**
 * 序列化不包含凭据的代理 Provider 运行状态。
 * @param {Object} state - Worker 单例状态
 * @returns {Object} API 响应对象
 */
function serializeProxyProviderStatus(state) {
  let switchError = null;
  if (state.proxySwitchErrorCode) {
    switchError = {
      code: state.proxySwitchErrorCode,
      message: state.proxySwitchErrorMessage,
    };
  }
  const heartbeatFresh =
    state.heartbeatAt && Date.now() - new Date(state.heartbeatAt).getTime() < 20_000;
  const workerReady = Boolean(
    config.proxy.enabled && heartbeatFresh && state.workerProxyReady && !state.isPaused
  );
  let workerBlockedReason = null;
  if (!config.proxy.enabled) workerBlockedReason = '代理未启用';
  else if (!heartbeatFresh) workerBlockedReason = '爬虫 Worker 心跳已过期或尚未启动';
  else if (state.isPaused) workerBlockedReason = '爬虫调度已暂停';
  else if (!state.workerProxyReady)
    workerBlockedReason =
      {
        PROXY_INITIALIZING: '代理正在初始化',
        PROXY_RECOVERY_FAILED: '原代理恢复失败，暂不领取订单任务，稍后重试',
        PROXY_RECOVERY_UNAVAILABLE: '没有可恢复的代理，请重新选择可用通道',
      }[state.workerProxyErrorCode] || '代理未就绪，订单任务等待处理';
  return {
    workerReady,
    workerBlockedReason,
    enabled: config.proxy.enabled,
    configuredDefaultProvider: config.proxy.provider,
    requestedProvider: state.requestedProxyProvider || config.proxy.provider,
    activeProvider: state.activeProxyProvider,
    switchStatus: state.proxySwitchStatus || 'idle',
    switchError,
    switchRequestedAt: state.proxySwitchRequestedAt,
    switchedAt: state.proxySwitchedAt,
    workerHeartbeatAt: state.heartbeatAt,
    providers: Object.fromEntries(
      SUPPORTED_PROXY_PROVIDERS.map(providerName => [
        providerName,
        { configured: isProxyProviderConfigured(config.proxy, providerName) },
      ])
    ),
  };
}

/**
 * 序列化系统日志
 * @param {Object} log - CrawlLog 实例
 * @returns {Object} API 响应对象
 */
function serializeSystemLog(log) {
  const plain = log.toJSON();
  return {
    id: plain.id,
    time: plain.createdAt,
    severity: plain.severity,
    type: plain.eventType,
    source: plain.source,
    order_id: plain.orderId,
    order_number: plain.order?.orderNumber || null,
    event: plain.event,
    proxy_ip: plain.proxyIp,
    http_status: plain.httpStatus,
    response_time: plain.responseTime,
    success: plain.success,
    result: plain.result,
    error_summary: plain.errorMessage,
    error_stack: plain.errorStack,
    context: plain.context,
    crawled_data: plain.crawledData,
    is_wind_control: plain.isWindControl,
    retry_count: plain.retryCount,
  };
}

/**
 * GET /api/system/logs
 */
async function listSystemLogs(req, res) {
  try {
    const page = parsePositiveInt(req.query.page, {
      defaultValue: 1,
      min: 1,
      max: 100000,
    });
    const limit = parsePositiveInt(req.query.limit, {
      defaultValue: 20,
      min: 1,
      max: 100,
    });
    const where = {};

    if (req.query.type) {
      if (!LOG_TYPES.includes(req.query.type)) {
        throw ApiError.badRequest(`日志类型非法，可选值: ${LOG_TYPES.join(', ')}`);
      }
      where.eventType = req.query.type;
    }

    if (req.query.severity) {
      if (!SEVERITIES.includes(req.query.severity)) {
        throw ApiError.badRequest(`严重程度非法，可选值: ${SEVERITIES.join(', ')}`);
      }
      where.severity = req.query.severity;
    }

    if (req.query.success !== undefined && req.query.success !== '') {
      where.success = req.query.success === 'true';
    }

    if (req.query['is_wind_control'] !== undefined && req.query['is_wind_control'] !== '') {
      where.isWindControl = req.query['is_wind_control'] === 'true';
    }

    if (req.query.date_from || req.query.date_to) {
      where.createdAt = {};
      if (req.query.date_from) {
        const from = new Date(req.query.date_from);
        if (Number.isNaN(from.getTime())) {
          throw ApiError.badRequest('date_from 不是合法日期');
        }
        where.createdAt[Op.gte] = from;
      }
      if (req.query.date_to) {
        const to = new Date(req.query.date_to);
        if (Number.isNaN(to.getTime())) {
          throw ApiError.badRequest('date_to 不是合法日期');
        }
        where.createdAt[Op.lte] = to;
      }
    }

    if (req.query.keyword) {
      const keyword = String(req.query.keyword).trim();
      if (keyword) {
        where[Op.or] = [
          { event: { [Op.iLike]: `%${keyword}%` } },
          { errorMessage: { [Op.iLike]: `%${keyword}%` } },
          { result: { [Op.iLike]: `%${keyword}%` } },
        ];
      }
    }

    const include = [
      {
        model: Order,
        as: 'order',
        attributes: ['id', 'orderNumber'],
        required: Boolean(req.query['order_number']),
        where: req.query['order_number']
          ? { orderNumber: { [Op.iLike]: `%${String(req.query['order_number']).trim()}%` } }
          : undefined,
      },
    ];

    const { count, rows } = await CrawlLog.findAndCountAll({
      where,
      include,
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    return res.json(paginatedResponse(rows.map(serializeSystemLog), count, page, limit, 'logs'));
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('查询系统日志失败', { error: error.message });
    throw ApiError.database('查询系统日志失败', { reason: error.message });
  }
}

/**
 * GET /api/system/auto-refresh
 */
async function getAutoRefreshStatus(_req, res) {
  try {
    const [state, jobCounts, freshnessCounts] = await Promise.all([
      refreshJobRepository.ensureSystemState(),
      OrderRefreshJob.findAll({
        attributes: [
          'status',
          [OrderRefreshJob.sequelize.fn('COUNT', OrderRefreshJob.sequelize.col('id')), 'count'],
        ],
        group: ['status'],
        raw: true,
      }),
      OrderRefreshSchedule.findAll({
        attributes: [
          'freshnessStatus',
          [
            OrderRefreshSchedule.sequelize.fn(
              'COUNT',
              OrderRefreshSchedule.sequelize.col('order_id')
            ),
            'count',
          ],
        ],
        group: ['freshnessStatus'],
        raw: true,
      }),
    ]);
    const heartbeatAt = state.heartbeatAt ? new Date(state.heartbeatAt) : null;
    const isRunning = heartbeatAt ? Date.now() - heartbeatAt.getTime() < 20_000 : false;

    return res.json({
      success: true,
      data: {
        enabled: process.env.AUTO_ORDER_REFRESH_ENABLED === 'true',
        isRunning,
        isPaused: state.isPaused,
        pausedAt: state.pausedAt,
        pauseReason: state.pauseReason,
        workerId: state.workerId,
        heartbeatAt,
        queue: Object.fromEntries(jobCounts.map(row => [row.status, Number(row.count)])),
        freshness: Object.fromEntries(
          freshnessCounts.map(row => [row.freshnessStatus, Number(row.count)])
        ),
        controlMode: 'external_worker',
        controlAvailable: true,
        statusSource: 'postgresql',
      },
    });
  } catch (error) {
    logger.error('查询自动刷新状态失败', { error: error.message });
    throw ApiError.internal('查询自动刷新状态失败', { reason: error.message });
  }
}

/**
 * POST /api/system/auto-refresh/resume
 */
async function resumeAutoRefresh(req, res) {
  try {
    const state = await refreshJobRepository.resume(req.user.id);
    return res.json({
      success: true,
      message: '持久化调度暂停状态已清除',
      data: {
        isPaused: state.isPaused,
        pausedAt: state.pausedAt,
        pauseReason: state.pauseReason,
        heartbeatAt: state.heartbeatAt,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('恢复自动刷新失败', { error: error.message });
    throw ApiError.internal('恢复自动刷新失败', { reason: error.message });
  }
}

/**
 * GET /api/system/proxy-provider
 */
async function getProxyProviderStatus(_req, res) {
  try {
    const state = await refreshJobRepository.ensureSystemState();
    return res.json({ success: true, data: serializeProxyProviderStatus(state) });
  } catch (error) {
    logger.error('查询代理 Provider 状态失败', { error: error.message });
    throw ApiError.internal('查询代理 Provider 状态失败');
  }
}

/**
 * POST /api/system/proxy-provider
 */
async function switchProxyProvider(req, res) {
  try {
    const providerName = req.body?.provider;
    if (typeof providerName !== 'string' || !isSupportedProxyProvider(providerName)) {
      throw ApiError.badRequest(`provider 必须是 ${SUPPORTED_PROXY_PROVIDERS.join('、')}`);
    }
    if (!config.proxy.enabled) {
      throw ApiError.conflict('代理功能未启用', undefined, 'PROXY_DISABLED');
    }
    if (!isProxyProviderConfigured(config.proxy, providerName)) {
      throw ApiError.conflict(
        '目标代理 Provider 配置不完整',
        { provider: providerName },
        'PROXY_CONFIG_MISSING'
      );
    }

    const state = await refreshJobRepository.requestProxyProviderSwitch(providerName, req.user.id);
    return res.status(202).json({
      success: true,
      message:
        state.proxySwitchStatus === 'succeeded'
          ? '目标代理 Provider 已处于生效状态'
          : '代理 Provider 切换请求已提交，将在当前批次结束后验证并生效',
      data: serializeProxyProviderStatus(state),
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('提交代理 Provider 切换失败', { error: error.message });
    throw ApiError.internal('提交代理 Provider 切换失败');
  }
}

module.exports = {
  listSystemLogs,
  getAutoRefreshStatus,
  resumeAutoRefresh,
  getProxyProviderStatus,
  switchProxyProvider,
  serializeProxyProviderStatus,
};
