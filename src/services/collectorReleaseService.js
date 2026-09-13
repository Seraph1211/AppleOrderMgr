const logger = require('../utils/logger');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const ApiError = require('../utils/ApiError');
const VERSION_PATTERN = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
/** 验签并校验固定发布清单，不接受任意下载 URL。 @param {Object} envelope 信封 @param {string|Buffer} key 公钥 @returns {Object} 清单 */
function verifyManifest(envelope, key) {
  try {
    if (
      !envelope ||
      typeof envelope.payload !== 'string' ||
      typeof envelope.signature !== 'string' ||
      envelope.payload.length > 4096 ||
      envelope.signature.length > 2048
    )
      throw new Error();
    const bytes = Buffer.from(envelope.payload, 'base64');
    if (
      bytes.toString('base64') !== envelope.payload ||
      !crypto.verify(
        'RSA-SHA256',
        bytes,
        { key, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(envelope.signature, 'base64')
      )
    )
      throw new Error();
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (
      manifest.product !== 'AppleOrderMgrAosCollector' ||
      manifest.platform !== 'win-x64' ||
      !VERSION_PATTERN.test(manifest.version) ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !Number.isSafeInteger(manifest.size) ||
      manifest.size < 1 ||
      manifest.size > 300 * 1024 * 1024 ||
      manifest.queueSchema !== 1
    )
      throw new Error();
    return manifest;
  } catch (_error) {
    throw ApiError.badRequest('采集器发布清单或签名无效');
  }
}
/** 从受控本地目录读取发布，不跟随目录链接。 @param {string} version 版本 @returns {Promise<Object>} 清单与制品 */
async function getRelease(version) {
  try {
    if (!VERSION_PATTERN.test(version)) throw ApiError.badRequest('版本号无效');
    const root = process.env.COLLECTOR_RELEASE_DIR;
    const keyPath = process.env.COLLECTOR_UPDATE_PUBLIC_KEY_FILE;
    if (!root || !keyPath)
      throw new ApiError(
        503,
        'COLLECTOR_UPDATES_NOT_CONFIGURED',
        '尚未配置采集器签名发布目录和公钥'
      );
    const directory = path.resolve(root, version);
    const realRoot = await fs.realpath(root);
    if ((await fs.realpath(directory)) !== path.join(realRoot, version))
      throw ApiError.badRequest('发布目录不合法');
    const manifestFile = path.join(directory, 'manifest.json');
    const packagePath = path.join(directory, 'AosCollector.exe');
    if (
      (await fs.lstat(manifestFile)).isSymbolicLink() ||
      (await fs.lstat(packagePath)).isSymbolicLink()
    )
      throw ApiError.badRequest('发布文件不合法');
    if ((await fs.stat(manifestFile)).size > 8192) throw ApiError.badRequest('发布清单过大');
    const envelope = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    const manifest = verifyManifest(envelope, await fs.readFile(keyPath));
    if (manifest.version !== version || (await fs.stat(packagePath)).size !== manifest.size)
      throw ApiError.badRequest('发布制品与清单不一致');
    // 制品体积有上限；下载前再验摘要，发布目录必须只读挂载。
    const digest = crypto
      .createHash('sha256')
      .update(await fs.readFile(packagePath))
      .digest('hex');
    if (digest !== manifest.sha256) throw ApiError.badRequest('发布制品摘要不一致');
    return { envelope, manifest, packagePath };
  } catch (error) {
    if (error.statusCode) throw error;
    throw new ApiError(503, 'COLLECTOR_RELEASE_UNAVAILABLE', '采集器发布制品不可用');
  }
}
/** 列出经过校验的发布版本。 @returns {Promise<Object>} 版本列表 */
async function listReleases() {
  try {
    if (!process.env.COLLECTOR_RELEASE_DIR || !process.env.COLLECTOR_UPDATE_PUBLIC_KEY_FILE)
      return { items: [], configured: false };
    const entries = await fs.readdir(process.env.COLLECTOR_RELEASE_DIR, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !VERSION_PATTERN.test(entry.name)) continue;
      const release = await getRelease(entry.name);
      items.push(release.manifest);
    }
    items.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    return { items, configured: true };
  } catch (error) {
    logger.debug('付款码或采集更新操作未完成', {
      errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
    });
    throw error;
  }
}
module.exports = { verifyManifest, getRelease, listReleases, VERSION_PATTERN };
