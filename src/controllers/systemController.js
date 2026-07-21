/* eslint-disable camelcase */
const { Op } = require('sequelize');
const { CrawlLog, Order } = require('../models');
const crawlerService = require('../services/crawlerService');
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

    const include = [{
      model: Order,
      as: 'order',
      attributes: ['id', 'orderNumber'],
      required: Boolean(req.query['order_number']),
      where: req.query['order_number']
        ? { orderNumber: { [Op.iLike]: `%${String(req.query['order_number']).trim()}%` } }
        : undefined,
    }];

    const { count, rows } = await CrawlLog.findAndCountAll({
      where,
      include,
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    return res.json(paginatedResponse(
      rows.map(serializeSystemLog),
      count,
      page,
      limit,
      'logs',
    ));
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
function getAutoRefreshStatus(_req, res) {
  try {
    return res.json({
      success: true,
      data: crawlerService.getAutoRefreshStatus(),
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
    const status = await crawlerService.resumeAutoRefresh(req.user);
    return res.json({
      success: true,
      message: '自动刷新已恢复',
      data: status,
    });
  } catch (error) {
    logger.error('恢复自动刷新失败', { error: error.message });
    throw ApiError.internal('恢复自动刷新失败', { reason: error.message });
  }
}

module.exports = {
  listSystemLogs,
  getAutoRefreshStatus,
  resumeAutoRefresh,
};
