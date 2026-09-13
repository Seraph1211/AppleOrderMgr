/** 在可信构建机签名固定采集器制品；私钥不复制到发布目录。 */
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const logger = require('../src/utils/logger');
const { VERSION_PATTERN } = require('../src/services/collectorReleaseService');
/** 制作供服务端与更新组件双重验证的发布目录。 @param {string[]} args 命令参数 @returns {Promise<void>} 完成 */
async function main(args) {
  try {
    const [executable, privateKey, version, destination] = args;
    if (args.length !== 4 || !VERSION_PATTERN.test(version))
      throw new Error(
        '用法：npm run collector:package -- <AosCollector.exe> <私钥.pem> <版本> <发布根目录>'
      );
    const bytes = await fs.readFile(executable);
    if (
      bytes.length < 2 ||
      bytes.toString('ascii', 0, 2) !== 'MZ' ||
      bytes.length > 300 * 1024 * 1024
    )
      throw new Error('Windows 制品无效');
    const key = crypto.createPrivateKey(await fs.readFile(privateKey));
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048)
      throw new Error('需使用至少 2048 位 RSA 签名密钥');
    const manifest = {
      product: 'AppleOrderMgrAosCollector',
      version,
      platform: 'win-x64',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      queueSchema: 1,
    };
    const payload = Buffer.from(JSON.stringify(manifest));
    const signature = crypto
      .sign('RSA-SHA256', payload, { key, padding: crypto.constants.RSA_PKCS1_PADDING })
      .toString('base64');
    const directory = path.resolve(destination, version);
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
    await fs.writeFile(path.join(directory, 'AosCollector.exe'), bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    await fs.writeFile(
      path.join(directory, 'manifest.json'),
      JSON.stringify({ payload: payload.toString('base64'), signature }),
      { flag: 'wx', mode: 0o600 }
    );
    await fs.writeFile(
      path.join(directory, 'release-public.pem'),
      crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }),
      { flag: 'wx', mode: 0o644 }
    );
    logger.info('采集器签名制品已生成', { version, sha256: manifest.sha256 });
  } catch (error) {
    logger.error('采集器打包失败', { message: error.message });
    process.exitCode = 1;
  }
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { main };
