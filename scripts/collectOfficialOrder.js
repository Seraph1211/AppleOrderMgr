const path = require('path');
const fs = require('fs');
const OfficialOrderCollector = require('../src/services/officialOrderCollector');
const { readPrivate } = require('../src/services/officialOrderSupport');

const CLI_ARGUMENT_OFFSET = 2;

/** 单笔受限入口：参数只有目录、系统 ID 和可选的服务器历史会话编号。 */
async function main() {
  try {
    const [root, id, resumeRun] = process.argv.slice(CLI_ARGUMENT_OFFSET);
    if (!root || !path.isAbsolute(root) || !/^[1-9]\d*$/.test(id || '')) {
      throw new Error('ARGUMENTS_INVALID');
    }
    const settingsFile = `${root}/private/collectorConfig.json`;
    const settings = fs.existsSync(settingsFile) ? readPrivate(settingsFile) : {};
    const proxyName = settings.proxyFile || 'fan-1.json';
    if (typeof proxyName !== 'string' || path.basename(proxyName) !== proxyName) {
      throw new Error('PROXY_FILE_INVALID');
    }
    const collector = new OfficialOrderCollector({
      root,
      inputFile: `${root}/private/request-${id}.json`,
      orderId: Number(id),
      proxyFile: `${root}/private/${proxyName}`,
      totalRequestLimit: settings.maxTotalRequests,
      runRequestLimit: settings.maxRunRequests,
      resumeRun,
    });
    const result = await collector.run();
    // 普通输出隐藏 Apple 订单号；完整 JSON 仅保存到受限 resultFile。
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.outcome !== 'SUCCEEDED') process.exitCode = 2;
  } catch (error) {
    const code = /^[A-Z_0-9]+$/.test(error.code || error.message)
      ? error.code || error.message
      : 'CLI_FAILED';
    process.stderr.write(`${JSON.stringify({ outcome: code })}\n`);
    process.exitCode = 1;
  }
}

main();
