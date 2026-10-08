/** 库存导入导出的 HTTP 适配；路由负责登录认证和有限 multipart 内存上传。 */
const service = require('../services/stockImportService');
const { runCommand } = require('../services/stockCommandService');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

function sendWorkbook(res, result) {
  res
    .set({
      'Cache-Control': 'no-store',
      'Content-Type': result.contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
      'X-Content-Type-Options': 'nosniff',
    })
    .send(result.buffer);
}

/** 下载当前权限允许的模板。 */
async function template(req, res) {
  try {
    if (Object.keys(req.query).some(key => key !== 'kind'))
      throw ApiError.badRequest('模板参数无效');
    sendWorkbook(res, await service.readTemplate(req.user, req.query.kind));
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

/** 有限文件预览，不修改实物或资金账。 */
async function preview(req, res) {
  try {
    if (Object.keys(req.body).some(key => !['kind', 'sourceLabel', 'requestKey'].includes(key)))
      throw ApiError.badRequest('导入预览包含未知字段');
    const data = await service.previewImport(req.user, {
      kind: req.body.kind,
      sourceLabel: req.body.sourceLabel,
      file: req.file,
    });
    res.status(201).set('Cache-Control', 'no-store').json({ success: true, data });
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  } finally {
    if (req.file) req.file.buffer = null;
  }
}

/** 整批确认调用统一事务与幂等服务，回读当前权限允许的结果。 */
async function commit(req, res) {
  try {
    const refs = await runCommand(
      req.user,
      { ...req.body, importId: req.params.id },
      'import.commit',
      ['stock.import'],
      async ctx => {
        try {
          return await service.commitImport(ctx, req.params.id, req.body);
        } catch (error) {
          logger.warn('库存文件事务未完成', { code: error.code || error.name });
          throw error;
        }
      }
    );
    const data = await service.getImport(req.user, refs.importId);
    res
      .set('Cache-Control', 'no-store')
      .json({ success: true, data: { ...data, idempotent: refs.idempotent } });
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

/** 查看本人或管理员可访问的导入状态。 */
async function get(req, res) {
  try {
    const data = await service.getImport(req.user, req.params.id);
    res.set('Cache-Control', 'no-store').json({ success: true, data });
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

/** 根据列表筛选和字段权限生成安全的 Excel 文件。 */
async function exportFile(req, res) {
  try {
    sendWorkbook(res, await service.exportStock(req.user, req.query));
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

module.exports = { template, preview, commit, get, exportFile };
