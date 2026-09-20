const fs = require('fs');
const { chromium } = require('playwright-core');
const logger = require('../src/utils/logger');
const {
  batchError,
  readPrivateFile,
  validateBatchConfig,
} = require('../src/services/crawler/browserBatch/batchConfig');
const { createBatchApi } = require('../src/services/crawler/browserBatch/batchApi');
const { openBatchCheckpoint } = require('../src/services/crawler/browserBatch/batchCheckpoint');
const { runBrowserBatch } = require('../src/services/crawler/browserBatch/batchRunner');
const { collectBrowserOrder } = require('../src/services/crawler/browserBatch/batchCollector');

/** 运行专用隔离浏览器批次，不连接或修改用户的日常 Chrome。 */
async function main() {
  let browser;
  let checkpoint;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (process.argv.length !== 3) throw batchError('CONFIG_FILE_ARGUMENT_REQUIRED');
    const config = validateBatchConfig(JSON.parse(readPrivateFile(process.argv[2])));
    // 防止配置或令牌文件被错误当作状态文件覆盖。
    if (
      [process.argv[2], config.tokenFile].some(
        file => fs.realpathSync(file) === require('path').resolve(config.checkpointFile)
      )
    ) {
      throw batchError('INVALID_CONFIG');
    }
    const api = createBatchApi({
      apiBaseUrl: config.apiBaseUrl,
      token: readPrivateFile(config.tokenFile).trim(),
    });
    checkpoint = openBatchCheckpoint(config);
    browser = await chromium.launch({
      headless: config.headless,
      ...(config.executablePath
        ? { executablePath: config.executablePath }
        : { channel: 'chrome' }),
      // Chromium 在部分平台需要启动代理开关才能使用每个上下文的独立代理。
      proxy: { server: 'per-context' },
    });
    const summary = await runBrowserBatch({
      config,
      checkpoint,
      api,
      signal: controller.signal,
      collect: options => collectBrowserOrder({ browser, ...options }),
      onProgress: data => logger.info('本机订单刷新任务进度', data),
    });
    logger.info('本机订单刷新批次结束', summary);
    process.exitCode =
      summary.fatalCode ||
      summary.cancelled ||
      (summary.counts.succeeded || 0) !== config.orderIds.length
        ? 2
        : 0;
  } catch (error) {
    logger.error('本机订单刷新批次未完成', {
      code: error.code && error.message === error.code ? error.code : 'BATCH_SETUP_FAILED',
    });
    process.exitCode = 1;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_error) {
        /* 浏览器进程可能已退出。 */
      }
    }
    checkpoint?.close();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

void main();
