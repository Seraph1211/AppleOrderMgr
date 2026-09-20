const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const ApiError = require('../../utils/ApiError');

const PURPOSE = 'apple-order-browser-refresh-v1';
const TTL_SECONDS = 120;

function signingKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32 || secret.includes('your_jwt_secret')) {
    throw ApiError.internal('浏览器刷新签名配置不可用');
  }
  return crypto.createHmac('sha256', secret).update(PURPOSE).digest();
}

/** 返回绑定订单身份、链接和版本的非敏感摘要。 */
function orderFingerprint(order) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        Number(order.id),
        order.orderNumber,
        order.orderUrl,
        new Date(order.updatedAt).toISOString(),
      ])
    )
    .digest('hex');
}

/** 签发只能由当前登录会话用于指定订单的短期任务票据。 */
function issueBrowserTicket(order, user, mode) {
  if (mode !== undefined && mode !== 'isolated_batch') {
    throw ApiError.badRequest('浏览器刷新模式无效');
  }
  const batch = mode === 'isolated_batch';
  const token = jwt.sign(
    {
      userId: user.id,
      sessionId: user.sessionId,
      orderId: Number(order.id),
      fingerprint: orderFingerprint(order),
      version: new Date(order.updatedAt).toISOString(),
      mode: batch ? 'isolated_batch' : 'extension',
    },
    signingKey(),
    {
      algorithm: 'HS256',
      audience: PURPOSE,
      issuer: PURPOSE,
      expiresIn: batch ? 330 : TTL_SECONDS,
      jwtid: crypto.randomUUID(),
    }
  );
  return {
    token,
    expiresAt: new Date(jwt.decode(token).exp * 1000).toISOString(),
    maxDurationMs: batch ? 300000 : 90000,
  };
}

/** 验证任务票据用途、会话、订单及有效期；错误不泄露票据正文。 */
function verifyBrowserTicket(token, order, user) {
  let claims;
  try {
    if (typeof token !== 'string' || token.length > 4096) throw new Error('invalid ticket');
    claims = jwt.verify(token, signingKey(), {
      algorithms: ['HS256'],
      audience: PURPOSE,
      issuer: PURPOSE,
    });
    if (
      claims.userId !== user.id ||
      claims.sessionId !== user.sessionId ||
      claims.orderId !== Number(order.id) ||
      typeof claims.jti !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(claims.jti)
    ) {
      throw new Error('wrong subject');
    }
  } catch (_error) {
    throw ApiError.conflict(
      '浏览器刷新任务已失效，请重新发起',
      undefined,
      'BROWSER_TICKET_INVALID'
    );
  }
  if (claims.fingerprint !== orderFingerprint(order)) {
    throw ApiError.conflict('订单已变化，请重新发起浏览器刷新', undefined, 'BROWSER_ORDER_CHANGED');
  }
  return claims;
}

module.exports = { issueBrowserTicket, verifyBrowserTicket };
