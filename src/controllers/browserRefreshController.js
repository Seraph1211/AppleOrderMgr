const { Order } = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { scopeOrderWhere } = require('../services/orderAccessService');
const { validateOrderUrl, crawlAndUpdateOrder } = require('../services/crawlerService');
const {
  issueBrowserTicket,
  verifyBrowserTicket,
} = require('../services/crawler/browserRefreshTicket');
const repository = require('../services/crawler/refreshJobRepository');
const limiter = require('../services/crawler/crawlerRateLimiter');
const { createRefreshBudget } = require('../services/crawler/refreshBudget');
const { classifyRefreshError, sanitizeRefreshError } = require('../services/crawler/refreshErrors');
const { projectBrowserOrderJson } = require('../services/crawler/browserOrderPayload');

async function loadOrder(req) {
  try {
    if (process.env.BROWSER_ORDER_REFRESH_ENABLED !== 'true') {
      throw new ApiError(503, 'BROWSER_REFRESH_DISABLED', '浏览器辅助刷新尚未启用');
    }
    if (
      !/^\d+$/.test(req.params.id) ||
      !Number.isSafeInteger(Number(req.params.id)) ||
      Number(req.params.id) <= 0
    ) {
      throw ApiError.badRequest('订单 ID 必须是正整数');
    }
    const order = await Order.findOne({
      where: scopeOrderWhere(req.user, { id: Number(req.params.id) }),
    });
    if (!order) throw ApiError.notFound('订单不存在或不可访问');
    validateOrderUrl(order.orderUrl, order.orderNumber);
    return order;
  } catch (error) {
    logger.warn('浏览器刷新前置校验失败', { code: error.code || 'VALIDATION_ERROR' });
    throw error;
  }
}

async function assertNotPaused() {
  try {
    const state = await repository.ensureSystemState();
    if (state.isPaused) throw new ApiError(409, 'REFRESH_PAUSED', '官网刷新已暂停');
  } catch (error) {
    logger.warn('浏览器刷新暂停检查失败', { code: error.code || 'STATE_ERROR' });
    throw error;
  }
}

/** 创建管理员短期浏览器取数任务，不启动后台爬虫。 */
async function startBrowserRefresh(req, res) {
  try {
    const order = await loadOrder(req);
    await assertNotPaused();
    const { token, expiresAt, maxDurationMs } = issueBrowserTicket(order, req.user, req.body?.mode);
    return res.json({
      success: true,
      data: {
        ticket: token,
        orderUrl: order.orderUrl,
        orderNumber: order.orderNumber,
        expiresAt,
        maxRequests: 100,
        maxDurationMs,
      },
    });
  } catch (error) {
    logger.warn('创建浏览器刷新任务失败', { code: error.code || 'START_ERROR' });
    throw error;
  }
}

/** 为一个浏览器请求（含重定向）取得现有全局时隙。 */
async function permitBrowserRequest(req, res) {
  let budget;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once('close', cancel);
  try {
    const order = await loadOrder(req);
    const claims = verifyBrowserTicket(req.body?.ticket, order, req.user);
    await assertNotPaused();
    budget = createRefreshBudget(Math.max(1, claims.exp * 1000 - Date.now()), controller.signal);
    await limiter.acquire({ signal: budget.signal });
    budget.check();
    return res.json({ success: true, data: { allowed: true } });
  } catch (error) {
    logger.warn('浏览器请求许可失败', { code: error.code || classifyRefreshError(error) });
    throw error;
  } finally {
    res.removeListener('close', cancel);
    budget?.dispose();
  }
}

/** 校验浏览器采集结果并复用现有订单解析与事务更新。 */
async function completeBrowserRefresh(req, res) {
  try {
    const order = await loadOrder(req);
    const claims = verifyBrowserTicket(req.body?.ticket, order, req.user);
    await assertNotPaused();
    const page = req.body?.page;
    if (
      !page ||
      typeof page.pageUrl !== 'string' ||
      !page.pageUrl.endsWith('/redacted') ||
      !page.orderJson ||
      page.html !== undefined ||
      JSON.stringify(page).length > 262144
    ) {
      throw ApiError.badRequest('浏览器订单结果格式无效');
    }
    const result = await crawlAndUpdateOrder(order.id, {
      manual: true,
      source: 'manual',
      expectedUpdatedAt: claims.version,
      browserTicketId: claims.jti,
      acquireOrderPage: () =>
        Promise.resolve({
          pageUrl: page.pageUrl,
          orderJson: projectBrowserOrderJson(page.orderJson, order.orderNumber),
        }),
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.warn('浏览器订单更新失败', { code: classifyRefreshError(error) });
    if (error.eventType === 'concurrency') {
      throw ApiError.conflict(
        '订单已变化，请重新发起浏览器刷新',
        undefined,
        'BROWSER_ORDER_CHANGED'
      );
    }
    throw new ApiError(422, classifyRefreshError(error), sanitizeRefreshError(error));
  }
}

module.exports = { startBrowserRefresh, permitBrowserRequest, completeBrowserRefresh };
