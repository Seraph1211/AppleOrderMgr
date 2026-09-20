const cheerio = require('cheerio');

/**
 * 仅生成枚举、计数与结构存在性；不输出正文、动态路径或会话信息。
 * @param {string} html - 上游页面
 * @param {Object|null} orderJson - 提取的 JSON
 * @param {Object} metadata - HTTP 状态与最终 URL，仅在内存中使用
 * @returns {Object} 可安全写入日志的页面摘要
 */
function describeOrderPage(html, orderJson, metadata = {}) {
  const $ = cheerio.load(html);
  const title = $('title').text();
  let finalHost = null;
  let routeKind = 'unknown';
  try {
    const url = new URL(metadata.finalUrl);
    if (/^(?:www|secure\d+\.www)\.apple\.com\.cn$/.test(url.hostname)) {
      finalHost = url.hostname;
      if (url.pathname.startsWith('/shop/order/guest/')) routeKind = 'guest_order';
      else if (url.pathname.startsWith('/xc/cn/vieworder/')) routeKind = 'order_entry';
      else routeKind = 'other_apple_page';
    }
  } catch (_error) {
    // 测试响应或传输失败可以没有最终 URL，不猜测跳转。
  }
  return {
    httpStatus: Number.isInteger(metadata.httpStatus) ? metadata.httpStatus : null,
    htmlBytes: Buffer.byteLength(html),
    finalHost,
    routeKind,
    titleKind: /访客订单/.test(title)
      ? 'guest_order'
      : /page not found/i.test(title)
        ? 'not_found'
        : 'other',
    hasInitData: $('script#init_data').length > 0,
    hasOrderJson: Boolean(orderJson),
    hasGuestOrderSpinner: Boolean(orderJson?.guestOrderSpinner),
    hasBrowserVerification: $('script[src]')
      .toArray()
      .some(element => {
        try {
          return /^\/shop\/shld\/[^/]+\/verify\.js$/.test(
            new URL($(element).attr('src'), 'https://www.apple.com.cn').pathname
          );
        } catch (_error) {
          return false;
        }
      }),
    hasOrderDetail: Boolean(orderJson?.orderDetail),
    hasOrderHeader: Boolean(orderJson?.orderDetail?.orderHeader?.d),
    hasValidOrderNumber:
      typeof orderJson?.orderDetail?.orderHeader?.d?.orderNumber === 'string' &&
      /^W\d{10}$/.test(orderJson.orderDetail.orderHeader.d.orderNumber),
  };
}

module.exports = { describeOrderPage };
