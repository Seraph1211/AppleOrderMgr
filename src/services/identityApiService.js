const crypto = require('crypto');
const {
  sequelize,
  IdentityVerificationBatch: Batch,
  IdentityVerificationItem: Item,
} = require('../models');
const { PERMISSIONS } = require('../constants/business');
const { encrypt, decrypt, blindIndex } = require('../utils/fieldEncryption');
const ApiError = require('../utils/ApiError');
const history = require('./identityVerificationService');
const execution = require('./identityExecutionService');
const provider = require('./identityProviderService');
const { validateIdentity } = require('./identityInputService');
const TOKEN_DAYS = 90;
const DEDUP_MS = 600000;
const TOKEN_FIELDS =
  'id,user_id AS "userId",prefix,status,expires_at AS "expiresAt",created_at AS "createdAt",last_used_at AS "lastUsedAt"';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function query(sql, replacements = {}, transaction) {
  try {
    const [rows] = await sequelize.query(sql, { replacements, transaction });
    return rows;
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}
async function audit(actorId, action, tokenId, itemId, reason, transaction) {
  try {
    await query(
      'INSERT INTO identity_api_events(actor_id,action,token_id,item_id,reason) VALUES(:actorId,:action,:tokenId,:itemId,:reason)',
      { actorId, action, tokenId: tokenId || null, itemId: itemId || null, reason: reason || null },
      transaction
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

/** 获取本人令牌元数据，不读取密文。 @returns {Promise<Object>} 元数据 */
async function metadata(actor) {
  try {
    return await sequelize.transaction(async transaction => {
      await history.authorize(actor, PERMISSIONS.IDENTITY_API, transaction);
      const tokens = await query(
        `SELECT ${TOKEN_FIELDS} FROM identity_api_tokens WHERE user_id=:userId ORDER BY created_at DESC LIMIT 1`,
        { userId: actor.id },
        transaction
      );
      const date = execution.usageDate();
      const usage = await query(
        "SELECT count FROM identity_api_usage WHERE user_id=:userId AND kind='day' AND period=:date",
        { userId: actor.id, date },
        transaction
      );
      return {
        token: tokens[0] || null,
        limits: { requestsPerMinute: 50, dailyProviderCalls: execution.DAILY_LIMIT, dedupSeconds: 600 },
        usage: { date, providerCalls: usage[0]?.count || 0 },
        service: await execution.getState(transaction),
      };
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

/** 创建、重置或撤销本人令牌，历史和额度不随重置清除。 @returns {Promise<Object>} 元数据 */
async function manageToken(actor, action) {
  try {
    await sequelize.transaction(async transaction => {
      await history.authorize(actor, PERMISSIONS.IDENTITY_API, transaction);
      const existing = await query(
        "SELECT id FROM identity_api_tokens WHERE user_id=:userId AND status='active'",
        { userId: actor.id },
        transaction
      );
      if (action === 'create' && existing.length)
        throw ApiError.conflict('已有令牌，请重置或停用后重新创建');
      if (existing.length)
        await query(
          "UPDATE identity_api_tokens SET status='revoked',updated_at=NOW() WHERE user_id=:userId AND status='active'",
          { userId: actor.id },
          transaction
        );
      let id = existing[0]?.id;
      if (action !== 'revoke') {
        id = crypto.randomUUID();
        const token = crypto.randomBytes(32).toString('base64url');
        await query(
          `INSERT INTO identity_api_tokens(id,user_id,token_hash,token_ciphertext,prefix,status,expires_at)
          VALUES(:id,:userId,:hash,:cipher,:prefix,'active',:expires)`,
          {
            id,
            userId: actor.id,
            hash: hashToken(token),
            cipher: encrypt(token),
            prefix: token.slice(0, 8),
            expires: new Date(Date.now() + TOKEN_DAYS * 86400000),
          },
          transaction
        );
      }
      await audit(actor.id, `token_${action}`, id, null, null, transaction);
    });
    return await metadata(actor);
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

/** 仅本人有效令牌可取回明文，一键复制不创建新令牌。 @returns {Promise<Object>} 明文 */
async function reveal(actor) {
  try {
    return await sequelize.transaction(async transaction => {
      await history.authorize(actor, PERMISSIONS.IDENTITY_API, transaction);
      const rows = await query(
        "SELECT id,token_ciphertext AS cipher,expires_at AS expires FROM identity_api_tokens WHERE user_id=:userId AND status='active' AND expires_at>NOW()",
        { userId: actor.id },
        transaction
      );
      if (!rows.length) throw ApiError.notFound('没有有效令牌，请先创建或重置');
      await audit(actor.id, 'token_reveal', rows[0].id, null, null, transaction);
      return { token: decrypt(rows[0].cipher), expiresAt: rows[0].expires };
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

async function authenticateToken(raw, transaction) {
  try {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw))
      throw new ApiError(401, 'UNAUTHORIZED', 'API令牌无效或已失效');
    const rows = await query(
      'SELECT id,user_id AS "userId" FROM identity_api_tokens WHERE token_hash=:hash AND status=\'active\' AND expires_at>NOW()',
      { hash: hashToken(raw) },
      transaction
    );
    if (!rows.length) throw new ApiError(401, 'UNAUTHORIZED', 'API令牌无效或已失效');
    const token = rows[0];
    await history.authorize({ id: token.userId }, PERMISSIONS.IDENTITY_API, transaction);
    // 令牌操作也先锁user；等待锁后再查，避免与撤销/重置交错。
    const valid = await query(
      "SELECT id FROM identity_api_tokens WHERE id=:id AND status='active' AND expires_at>NOW()",
      { id: token.id },
      transaction
    );
    if (!valid.length) throw new ApiError(401, 'UNAUTHORIZED', 'API令牌无效或已失效');
    return token;
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}
function responseItem(item, reused) {
  return {
    verificationId: item.id,
    status: item.status,
    matched: item.status === 'matched',
    message: item.message,
    verifiedAt: item.finishedAt,
    reused,
  };
}
async function cached(userId, requestHash, transaction) {
  try {
    const rows = await query(
      'SELECT item_id AS "itemId" FROM identity_api_dedup WHERE user_id=:userId AND request_hash=:requestHash',
      { userId, requestHash },
      transaction
    );
    if (!rows.length) return null;
    const item = await Item.findByPk(rows[0].itemId, { transaction });
    if (['matched', 'mismatched'].includes(item.status)) {
      if (Date.now() - new Date(item.finishedAt).getTime() < DEDUP_MS)
        return responseItem(item, true);
      await query(
        'DELETE FROM identity_api_dedup WHERE user_id=:userId AND request_hash=:requestHash',
        { userId, requestHash },
        transaction
      );
      return null;
    }
    const error = new ApiError(
      item.status === 'processing' ? 429 : 409,
      item.status === 'processing' ? 'SERVICE_BUSY' : 'UNRESOLVED_RESULT',
      '此前核验未取得确定结果，请联系管理员核查后处置'
    );
    error.verificationId = item.id;
    error.resultStatus = item.status === 'processing' ? 'processing' : 'unknown';
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

/** 独立令牌同步核验，所有外部调用必须经过共享执行槽。 @returns {Promise<Object>} 确定结果 */
async function verify(input, verifyProvider = provider.verifyIdentity, onAuthenticated = () => {}) {
  let item;
  let called = false;
  try {
    const name = input.name.trim();
    const idCardNumber = input.idCardNumber.trim().toUpperCase();
    const invalid = validateIdentity(name, idCardNumber);
    if (invalid) throw ApiError.badRequest(invalid);
    const requestHash = blindIndex(
      Buffer.from(JSON.stringify([name, idCardNumber])).toString('hex')
    );
    const first = await sequelize.transaction(async transaction => {
      const token = await authenticateToken(input.token, transaction);
      await execution.reserveUsage(token.userId, 'minute', transaction);
      await query(
        'UPDATE identity_api_tokens SET last_used_at=NOW(),updated_at=NOW() WHERE id=:id',
        { id: token.id },
        transaction
      );
      // 缓存异常在事务外抛出，入口次数仍然落库，避免未知结果请求绕过50/min。
      try {
        return { token, result: await cached(token.userId, requestHash, transaction) };
      } catch (error) {
        return { token, cacheError: error };
      }
    });
    onAuthenticated({ userId: first.token.userId, tokenId: first.token.id });
    if (first.cacheError) throw first.cacheError;
    if (first.result) return first.result;
    return await execution.withSlot(async () => {
      const claim = await sequelize.transaction(async transaction => {
        const token = await authenticateToken(input.token, transaction);
        const found = await cached(token.userId, requestHash, transaction);
        if (found) return { result: found };
        await history.assertReady(transaction);
        const state = await execution.getState(transaction);
        if (state.paused) throw new ApiError(503, 'SERVICE_PAUSED', '身份核验服务已暂停');
        await execution.reserveUsage(token.userId, 'day', transaction);
        const batch = await Batch.create(
          {
            id: crypto.randomUUID(),
            userId: token.userId,
            apiTokenId: token.id,
            source: 'api',
            status: 'running',
            summary: { total: 1, valid: 1 },
          },
          { transaction }
        );
        const created = await Item.create(
          {
            batchId: batch.id,
            rowNumber: 1,
            name,
            idCardNumber,
            status: 'processing',
            startedAt: new Date(),
          },
          { transaction }
        );
        await query(
          'INSERT INTO identity_api_dedup(user_id,request_hash,item_id) VALUES(:userId,:requestHash,:itemId)',
          { userId: token.userId, requestHash, itemId: created.id },
          transaction
        );
        return { item: created };
      });
      if (claim.result) return claim.result;
      item = claim.item;
      called = true;
      let result;
      try {
        result = await verifyProvider(name, idCardNumber);
      } catch (_error) {
        result = {
          status: 'unknown',
          code: 'RESULT_UNKNOWN',
          httpStatus: 504,
          message: '请求中断，结果未知；未自动重试',
        };
      }
      await sequelize.transaction(async transaction => {
        await item.update(
          {
            status: result.status,
            message: result.message,
            resultData: result.resultData || null,
            finishedAt: new Date(),
          },
          { transaction }
        );
        await Batch.update(
          {
            status: result.fatal || result.status === 'unknown' ? 'paused' : 'completed',
            message: result.message,
          },
          { where: { id: item.batchId }, transaction }
        );
        if (result.fatal)
          await execution.setPaused(true, result.code || 'PROVIDER_UNAVAILABLE', transaction);
      });
      if (['matched', 'mismatched'].includes(result.status)) return responseItem(item, false);
      const error = new ApiError(
        result.httpStatus || (result.fatal ? 503 : 502),
        result.code || 'RESULT_UNKNOWN',
        result.message || '核验未取得确定结果'
      );
      error.verificationId = item.id;
      error.resultStatus = 'unknown';
      error.providerCalled = true;
      throw error instanceof Error ? error : new Error('身份核验操作失败');
    });
  } catch (error) {
    if (called && !(error instanceof ApiError)) {
      const safe = new ApiError(
        503,
        'RESULT_UNKNOWN',
        '请求已发出但结果未能可靠保存，请联系管理员核查；禁止自动重试'
      );
      safe.verificationId = item?.id;
      safe.resultStatus = 'unknown';
      safe.providerCalled = true;
      throw safe;
    }
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

function assertAdmin(actor) {
  if (actor.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', '仅管理员可操作');
}
/** 管理员读取无敏感字段的有限元数据。 @returns {Promise<Object>} 管理状态 */
async function adminStatus(actor) {
  try {
    assertAdmin(actor);
    return await sequelize.transaction(async transaction => {
      const user = await history.authorize(actor, PERMISSIONS.IDENTITY_API, transaction);
      assertAdmin(user);
      const unknown = await query(
        `SELECT i.id,i.batch_id AS "batchId",b.user_id AS "userId",i.status,i.message,i.started_at AS "startedAt",i.finished_at AS "finishedAt"
        FROM identity_api_dedup d JOIN identity_verification_items i ON i.id=d.item_id JOIN identity_verification_batches b ON b.id=i.batch_id
        WHERE i.status IN ('unknown','error') ORDER BY i.id DESC LIMIT 100`,
        {},
        transaction
      );
      const tokens = await query(
        `SELECT ${TOKEN_FIELDS} FROM identity_api_tokens ORDER BY created_at DESC LIMIT 100`,
        {},
        transaction
      );
      return { service: await execution.getState(transaction), unknown, tokens };
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

/** 管理员暂停/恢复、明确释放未知结果、撤销令牌，保留审计。 @returns {Promise<Object>} 管理状态 */
async function adminAction(actor, action, input) {
  try {
    assertAdmin(actor);
    // 与在途供应商使用同一锁；忙时返回429，避免恢复时覆盖正在落库的致命暂停。
    let connection;
    let locked = false;
    try {
      connection = await sequelize.connectionManager.getConnection({ type: 'WRITE' });
      const lock = await connection.query('SELECT pg_try_advisory_lock($1) AS locked', [742095]);
      locked = lock.rows[0].locked;
      if (!locked) throw new ApiError(429, 'SERVICE_BUSY', '当前存在在途核验，请完成后再管理');
      await sequelize.transaction(async transaction => {
        const user = await history.authorize(actor, PERMISSIONS.IDENTITY_API, transaction);
        assertAdmin(user);
        if (action === 'service') {
          if (typeof input.paused !== 'boolean') throw ApiError.badRequest('paused必须是布尔值');
          await execution.setPaused(
            input.paused,
            input.paused ? 'ADMIN_PAUSED' : null,
            transaction
          );
          await audit(
            actor.id,
            input.paused ? 'service_pause' : 'service_resume',
            null,
            null,
            null,
            transaction
          );
        } else if (action === 'resolve') {
          if (
            input.action !== 'release' ||
            typeof input.reason !== 'string' ||
            input.reason.trim().length < 5 ||
            input.reason.trim().length > 200 ||
            !/^\d+$/.test(input.id)
          )
            throw ApiError.badRequest('请提供release及5到200字核查原因');
          const rows = await query(
            "SELECT d.item_id FROM identity_api_dedup d JOIN identity_verification_items i ON i.id=d.item_id WHERE d.item_id=:id AND i.status IN ('unknown','error')",
            { id: input.id },
            transaction
          );
          if (!rows.length) throw ApiError.notFound('没有待处置的未知结果');
          await query(
            'DELETE FROM identity_api_dedup WHERE item_id=:id',
            { id: input.id },
            transaction
          );
          await audit(
            actor.id,
            'unknown_release',
            null,
            input.id,
            input.reason.trim(),
            transaction
          );
        } else if (action === 'revoke') {
          if (!UUID.test(input.id || '')) throw ApiError.badRequest('令牌编号无效');
          const rows = await query(
            'SELECT user_id AS "userId" FROM identity_api_tokens WHERE id=:id',
            { id: input.id },
            transaction
          );
          if (!rows.length) throw ApiError.notFound('令牌不存在');
          // 不取密文；用户锁保证撤销与下一次实际发送前认证序列化。
          if (rows[0].userId !== actor.id)
            await history
              .authorize({ id: rows[0].userId }, PERMISSIONS.IDENTITY_READ, transaction)
              .catch(error => {
                if (error.statusCode !== 403)
                  throw error instanceof Error ? error : new Error('身份核验操作失败');
              });
          await query(
            "UPDATE identity_api_tokens SET status='revoked',updated_at=NOW() WHERE id=:id",
            { id: input.id },
            transaction
          );
          await audit(actor.id, 'token_admin_revoke', input.id, null, null, transaction);
        }
      });
    } finally {
      if (connection) {
        try {
          if (locked) await connection.query('SELECT pg_advisory_unlock($1)', [742095]);
          await sequelize.connectionManager.releaseConnection(connection);
        } catch (_error) {
          await sequelize.connectionManager.destroyConnection(connection).catch(() => {});
        }
      }
    }
    return await adminStatus(actor);
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}
module.exports = { metadata, manageToken, reveal, verify, adminStatus, adminAction };
