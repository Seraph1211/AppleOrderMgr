const jwt = require('jsonwebtoken');
const logger = require('./logger');
const { sessionFingerprint } = require('./accountSessions');

/**
 * JWT 工具函数
 * @module utils/jwtUtils
 * @description 提供 JWT token 的生成、验证和解析功能
 */

// JWT 有效期（从环境变量读取，默认 7 天）
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32 || secret.includes('your_jwt_secret')) {
    throw new Error('JWT_SECRET 必须显式配置且至少 32 个字符');
  }
  return secret;
}

/**
 * 生成 JWT token
 * @param {Object} payload - Token 载荷
 * @param {number} payload.userId - 用户 ID
 * @param {string} payload.username - 用户名
 * @param {string} payload.role - 用户角色（admin/user）
 * @returns {string} JWT token
 * @throws {Error} 当生成失败时
 */
function generateToken(payload) {
  try {
    const { userId, username, role, sessionId } = payload;

    if (!userId || !username || !role) {
      throw new Error('生成 token 需要 userId、username 和 role 参数');
    }

    const token = jwt.sign(
      {
        userId,
        username,
        role,
        sessionId,
        iat: Math.floor(Date.now() / 1000),
      },
      getJwtSecret(),
      {
        expiresIn: JWT_EXPIRES_IN,
      }
    );

    logger.info('JWT token 生成成功', {
      userId,
      username,
      role,
      expiresIn: JWT_EXPIRES_IN,
    });

    return token;
  } catch (error) {
    logger.error('JWT token 生成失败', {
      error: error.message,
      userId: payload?.userId,
    });
    throw error;
  }
}

/**
 * 验证 JWT token 有效性
 * @param {string} token - JWT token
 * @returns {Object|null} 解码后的 payload，验证失败返回 null
 */
function verifyToken(token) {
  try {
    if (!token) {
      return null;
    }

    const decoded = jwt.verify(token, getJwtSecret());

    logger.debug('JWT token 验证成功', {
      userId: decoded.userId,
      username: decoded.username,
      role: decoded.role,
    });

    return decoded;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      logger.warn('JWT token 已过期', {
        expiredAt: error.expiredAt,
      });
    } else if (error.name === 'JsonWebTokenError') {
      logger.warn('JWT token 无效', {
        error: error.message,
      });
    } else {
      logger.error('JWT token 验证失败', {
        error: error.message,
      });
    }

    return null;
  }
}

/**
 * 从请求头中提取 token
 * @param {Object} req - Express 请求对象
 * @returns {string|null} Token 字符串，未找到返回 null
 */
function extractTokenFromHeader(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return null;
  }

  // 支持两种格式：
  // 1. Authorization: Bearer <token>
  // 2. Authorization: <token>
  const parts = authHeader.split(' ');

  if (parts.length === 2 && parts[0] === 'Bearer') {
    return parts[1];
  } else if (parts.length === 1) {
    return parts[0];
  }

  return null;
}

/**
 * 解码 token（不验证签名，用于调试）
 * @param {string} token - JWT token
 * @returns {Object|null} 解码后的 payload，失败返回 null
 */
function decodeToken(token) {
  try {
    return jwt.decode(token);
  } catch (error) {
    logger.error('JWT token 解码失败', {
      error: error.message,
    });
    return null;
  }
}

/**
 * 签发只允许接管指定旧会话的短期凭证。
 * @param {Object} user - 用户
 * @param {Object[]} sessions - 有效会话
 * @returns {string} 确认凭证
 */
function generateConfirmationToken(user, sessions) {
  return jwt.sign(
    {
      purpose: 'login_takeover',
      userId: user.id,
      previousSessionId: sessions[0]?.id,
      sessionFingerprint: sessionFingerprint(sessions),
    },
    getJwtSecret(),
    { expiresIn: '2m' }
  );
}

module.exports = {
  generateConfirmationToken,
  generateToken,
  verifyToken,
  extractTokenFromHeader,
  decodeToken,
  JWT_EXPIRES_IN,
};
