/** 基础档案导入：服务端预览、逐项裁定、事务执行。 */
const crypto = require('crypto');
const fs = require('fs/promises');
const { sequelize } = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { parseExcelFile } = require('../services/importService');
const {
  loadProfiles,
  buildImportPlan,
  applyImportPlan,
} = require('../services/profileImportService');
const { lockProfiles } = require('../services/profileBindingService');
const sessions = new Map();
const TTL = 15 * 60 * 1000;

function cleanSessions() {
  for (const [key, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(key);
}
function getSession(req) {
  cleanSessions();
  const session = sessions.get(req.body?.sessionToken);
  if (!session || session.userId !== req.user.id || session.type !== req.body.type)
    throw ApiError.badRequest('预览已过期、已使用或类型／用户不匹配，请重新上传');
  const decisions = req.body.decisions || {};
  if (
    typeof decisions !== 'object' ||
    Array.isArray(decisions) ||
    Object.keys(decisions).length > 100000
  )
    throw ApiError.badRequest('差异选择格式错误');
  return session;
}
function publicPlan(plan) {
  return {
    summary: plan.summary,
    records: plan.records,
    conflicts: plan.conflicts,
    errors: plan.errors,
  };
}

/** 上传多个文件并生成无敏感明文的差异预览。 */
async function previewImport(req, res) {
  const files = req.files ? Object.values(req.files).flat() : req.file ? [req.file] : [];
  try {
    const type = req.query.type || req.body.type;
    if (!['apple_ids', 'recipients'].includes(type)) throw ApiError.badRequest('导入类型无效');
    if (!files.length) throw ApiError.badRequest('请选择 xlsx 文件');
    cleanSessions();
    if ([...sessions.values()].filter(s => s.userId === req.user.id).length >= 5)
      throw ApiError.badRequest('未完成预览过多，请稍后再试');
    const rows = files.flatMap(file =>
      parseExcelFile(file.path, type).map(row => ({ ...row, fileName: file.originalname }))
    );
    if (rows.length > 10000) throw ApiError.badRequest('单批最多 10000 行，请拆分导入');
    const profiles = await loadProfiles();
    const plan = buildImportPlan(rows, type, profiles);
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    sessions.set(sessionToken, {
      rows,
      type,
      profiles,
      userId: req.user.id,
      expiresAt: Date.now() + TTL,
    });
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: { sessionToken, expiresInSeconds: TTL / 1000, ...publicPlan(plan) },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.warn('导入预览失败', { errorType: error.name });
    throw ApiError.badRequest(
      error.message.startsWith('未找到') || error.message.startsWith('没有可导入')
        ? error.message
        : '文件格式无法解析，请检查表头及数据'
    );
  } finally {
    await Promise.all(files.map(file => fs.unlink(file.path).catch(() => {})));
  }
}

/** 选择差异后重新计算预览，尚不写库。 */
function reviewImport(req, res) {
  try {
    const session = getSession(req);
    const plan = buildImportPlan(session.rows, session.type, session.profiles, req.body.decisions);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: publicPlan(plan) });
  } catch (error) {
    logger.warn('基础档案操作未完成', { errorType: error.name });
    throw error;
  }
}

/** 消费用户绑定令牌，锁内检查预览是否过时后原子写入。 */
async function executeImport(req, res) {
  try {
    const session = getSession(req);
    const plan = buildImportPlan(session.rows, session.type, session.profiles, req.body.decisions);
    if (plan.summary.conflicts || plan.summary.blocked)
      throw ApiError.conflict('请先裁定差异或跳过问题档案');
    sessions.delete(req.body.sessionToken);
    const result = await sequelize.transaction(async transaction => {
      await lockProfiles(transaction, req.user.id, true);
      const current = await loadProfiles(transaction);
      if (current.fingerprint !== session.profiles.fingerprint)
        throw ApiError.conflict('预览后档案已变化，请重新上传核对');
      return applyImportPlan(plan, req, transaction);
    });
    logger.info('档案导入完成', {
      userId: req.user.id,
      type: session.type,
      imported: result.imported,
      updated: result.updated,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('档案导入事务失败', { errorType: error.name });
    throw ApiError.database('导入未完成，整批已回滚，请重新预览');
  }
}
module.exports = { previewImport, reviewImport, executeImport };
