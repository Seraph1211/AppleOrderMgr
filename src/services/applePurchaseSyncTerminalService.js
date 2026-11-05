const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const ApiError = require('../utils/ApiError');
const { getAdminDatabase } = require('./applePurchaseSyncDatabase');
const { UUID_PATTERN } = require('./applePurchaseSyncValidation');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken() {
  const prefix = crypto.randomBytes(9).toString('base64url');
  return {
    prefix: `aps_${prefix}`,
    token: `aps_${prefix}.${crypto.randomBytes(32).toString('base64url')}`,
  };
}

function validateName(name) {
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 128) {
    throw ApiError.badRequest('name 长度必须为 1–128 字符');
  }
  return name.trim();
}

function assertExactBody(body, allowed, required = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw ApiError.badRequest('请求体必须是 JSON object');
  }
  const unknown = Object.keys(body).find(key => !allowed.includes(key));
  if (unknown)
    throw ApiError.badRequest('请求包含未知字段', [{ path: unknown, reason: 'unknown_field' }]);
  const missing = required.find(key => !Object.prototype.hasOwnProperty.call(body, key));
  if (missing)
    throw ApiError.badRequest('请求缺少必填字段', [{ path: missing, reason: 'required' }]);
}

function assertTerminalId(terminalId) {
  if (!UUID_PATTERN.test(terminalId)) throw ApiError.badRequest('terminalId 格式无效');
}

function terminalResponse(row) {
  return {
    terminalId: row.terminalId,
    name: row.name,
    enabled: row.enabled,
    tokenPrefix: row.tokenPrefix,
    tokenCreatedAt: row.tokenCreatedAt,
    tokenRotatedAt: row.tokenRotatedAt,
    lastSeenAt: row.lastSeenAt,
    lastSuccessAt: row.lastSuccessAt,
    highWater: {
      observations: String(row.observationHighWater),
      monitorChanges: String(row.monitorChangeHighWater),
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revokedAt: row.revokedAt,
  };
}

const SELECT_TERMINAL = `
  SELECT id AS "terminalId", name, enabled, token_prefix AS "tokenPrefix",
    token_created_at AS "tokenCreatedAt", token_rotated_at AS "tokenRotatedAt",
    last_seen_at AS "lastSeenAt", last_success_at AS "lastSuccessAt",
    observation_high_water::text AS "observationHighWater",
    monitor_change_high_water::text AS "monitorChangeHighWater",
    created_at AS "createdAt", updated_at AS "updatedAt", revoked_at AS "revokedAt"
  FROM apple_purchase_sync.terminals`;

async function audit(database, transaction, terminalId, actorUserId, action, changes, requestId) {
  await database.query(
    `INSERT INTO apple_purchase_sync.terminal_audit_events
      (terminal_id, actor_user_id, action, changes, request_id)
     VALUES (:terminalId, :actorUserId, :action, CAST(:changes AS jsonb), :requestId)`,
    {
      replacements: {
        terminalId,
        actorUserId,
        action,
        changes: JSON.stringify(changes),
        requestId,
      },
      transaction,
    }
  );
}

/** 列出终端安全元数据，不读取摘要。 @returns {Promise<Object[]>} 终端 */
async function listTerminals() {
  try {
    const rows = await getAdminDatabase().query(`${SELECT_TERMINAL} ORDER BY created_at DESC`, {
      type: QueryTypes.SELECT,
    });
    return rows.map(terminalResponse);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', '终端管理暂不可用');
  }
}

/** 创建终端并仅本次返回明文 Token。 @param {Object} body 输入 @param {Object} actor 操作者 @param {string} requestId 请求 ID @returns {Promise<Object>} 终端 */
async function createTerminal(body, actor, requestId) {
  assertExactBody(body, ['name'], ['name']);
  const name = validateName(body.name);
  const terminalId = crypto.randomUUID();
  const created = generateToken();
  const now = new Date();
  const database = getAdminDatabase();
  try {
    await database.transaction(async transaction => {
      await database.query(
        `INSERT INTO apple_purchase_sync.terminals
          (id, name, token_hash, token_prefix, token_created_at, created_at, updated_at)
         VALUES (:terminalId, :name, :tokenHash, :tokenPrefix, :now, :now, :now)`,
        {
          replacements: {
            terminalId,
            name,
            tokenHash: hashToken(created.token),
            tokenPrefix: created.prefix,
            now,
          },
          transaction,
        }
      );
      await audit(
        database,
        transaction,
        terminalId,
        actor?.id || null,
        'created',
        { name, enabled: true },
        requestId
      );
    });
    return {
      terminalId,
      name,
      enabled: true,
      token: created.token,
      tokenCreatedAt: now.toISOString(),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', '终端创建暂不可用');
  }
}

/** 修改终端名称或启用状态。 @returns {Promise<Object>} 终端 */
async function updateTerminal(terminalId, body, actor, requestId) {
  assertTerminalId(terminalId);
  assertExactBody(body, ['name', 'enabled']);
  if (!Object.keys(body).length) throw ApiError.badRequest('至少提交 name 或 enabled');
  const name = Object.prototype.hasOwnProperty.call(body, 'name')
    ? validateName(body.name)
    : undefined;
  if (Object.prototype.hasOwnProperty.call(body, 'enabled') && typeof body.enabled !== 'boolean') {
    throw ApiError.badRequest('enabled 必须是 boolean');
  }
  const database = getAdminDatabase();
  try {
    return await database.transaction(async transaction => {
      const rows = await database.query(`${SELECT_TERMINAL} WHERE id = :terminalId FOR UPDATE`, {
        replacements: { terminalId },
        type: QueryTypes.SELECT,
        transaction,
      });
      if (!rows.length) throw ApiError.notFound('终端不存在');
      const previous = rows[0];
      const nextName = name ?? previous.name;
      const nextEnabled = body.enabled ?? previous.enabled;
      await database.query(
        `UPDATE apple_purchase_sync.terminals
         SET name = :name, enabled = :enabled,
             revoked_at = CASE WHEN :enabled THEN NULL ELSE COALESCE(revoked_at, NOW()) END,
             updated_at = NOW()
         WHERE id = :terminalId`,
        { replacements: { terminalId, name: nextName, enabled: nextEnabled }, transaction }
      );
      await audit(
        database,
        transaction,
        terminalId,
        actor.id,
        'updated',
        {
          ...(nextName !== previous.name
            ? { name: { before: previous.name, after: nextName } }
            : {}),
          ...(nextEnabled !== previous.enabled
            ? { enabled: { before: previous.enabled, after: nextEnabled } }
            : {}),
        },
        requestId
      );
      const [updated] = await database.query(`${SELECT_TERMINAL} WHERE id = :terminalId`, {
        replacements: { terminalId },
        type: QueryTypes.SELECT,
        transaction,
      });
      return terminalResponse(updated);
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', '终端修改暂不可用');
  }
}

/** 轮换终端 Token，旧 Token 与事务提交同步失效。 @returns {Promise<Object>} 一次性明文 */
async function rotateToken(terminalId, body, actor, requestId) {
  assertTerminalId(terminalId);
  assertExactBody(body, []);
  const created = generateToken();
  const now = new Date();
  const database = getAdminDatabase();
  try {
    return await database.transaction(async transaction => {
      const rows = await database.query(`${SELECT_TERMINAL} WHERE id = :terminalId FOR UPDATE`, {
        replacements: { terminalId },
        type: QueryTypes.SELECT,
        transaction,
      });
      if (!rows.length) throw ApiError.notFound('终端不存在');
      await database.query(
        `UPDATE apple_purchase_sync.terminals
         SET token_hash = :tokenHash, token_prefix = :tokenPrefix,
             token_rotated_at = :now, token_created_at = :now, updated_at = :now
         WHERE id = :terminalId`,
        {
          replacements: {
            terminalId,
            tokenHash: hashToken(created.token),
            tokenPrefix: created.prefix,
            now,
          },
          transaction,
        }
      );
      await audit(database, transaction, terminalId, actor.id, 'token_rotated', {}, requestId);
      return {
        terminalId,
        name: rows[0].name,
        enabled: rows[0].enabled,
        token: created.token,
        tokenCreatedAt: now.toISOString(),
      };
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Token 轮换暂不可用');
  }
}

module.exports = { createTerminal, hashToken, listTerminals, rotateToken, updateTerminal };
