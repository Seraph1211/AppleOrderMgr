const { createRefreshBudget } = require('./refreshBudget');

/**
 * 拒绝非官网详情来源；URL 仅在内存校验，不写入日志或错误消息。
 * @param {string} pageUrl - 浏览器正常导航后的页面 URL
 * @param {string} orderNumber - 请求订单号
 * @returns {void} 校验成功
 */
function validateBrowserPageUrl(pageUrl, orderNumber) {
  try {
    const url = new URL(pageUrl);
    const pathMatch = url.pathname.match(/^\/shop\/order\/guest\/(W\d{10})\/[^/]+$/);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !/^secure\d+\.www\.apple\.com\.cn$/.test(url.hostname) ||
      pathMatch?.[1] !== orderNumber
    ) {
      throw new Error('invalid browser page');
    }
  } catch (_error) {
    const error = new Error('浏览器返回的页面来源或订单路径无效');
    error.eventType = 'parse';
    error.refreshErrorCode = 'PARSE';
    throw error;
  }
}

/**
 * 将受信任的浏览器采集实现接入现有解析器，拒绝取消后的迟到结果。
 * 采集实现负责正常加载、全局限流及响应 signal，不能直接返回业务更新字段。
 * @param {Object} options - 内部采集依赖和订单上下文，不来自 HTTP 请求体
 * @returns {Promise<Object>} 与 HTTP 取数一致的解析结果
 */
async function acquireBrowserOrderData({
  acquireOrderPage,
  orderUrl,
  orderNumber,
  timeoutMs,
  signal,
  parseOrderData,
  validateIdentity,
}) {
  const budget = createRefreshBudget(timeoutMs, signal);
  let onAbort;
  try {
    budget.check();
    const aborted = new Promise((_resolve, reject) => {
      onAbort = () => reject(budget.signal.reason);
      budget.signal.addEventListener('abort', onAbort, { once: true });
    });
    const page = await Promise.race([
      Promise.resolve().then(() => {
        budget.check();
        return acquireOrderPage(Object.freeze({ orderUrl, orderNumber, signal: budget.signal }));
      }),
      aborted,
    ]);
    budget.check();
    validateBrowserPageUrl(page?.pageUrl, orderNumber);
    const detail = page?.orderJson?.orderDetail;
    if (!detail?.orderHeader || !detail?.orderItems || Array.isArray(detail.orderItems)) {
      const error = new Error('浏览器尚未返回完整订单详情');
      error.eventType = 'parse';
      error.refreshErrorCode = 'PAGE_LOADING';
      throw error;
    }
    const data = parseOrderData(page.orderJson, typeof page.html === 'string' ? page.html : '');
    validateIdentity(data, orderNumber);
    if (!Array.isArray(data.products) || data.products.length === 0) {
      const error = new Error('浏览器订单详情缺少有效商品项');
      error.eventType = 'parse';
      error.refreshErrorCode = 'PARSE';
      throw error;
    }
    budget.check();
    return { success: true, data, proxy: null, acquisitionMethod: 'browser' };
  } catch (error) {
    // 取消后的浏览器错误优先归为取消／超时，不误报解析或线路故障。
    budget.check();
    throw error;
  } finally {
    if (onAbort) budget.signal.removeEventListener('abort', onAbort);
    budget.dispose();
  }
}

module.exports = { acquireBrowserOrderData, validateBrowserPageUrl };
