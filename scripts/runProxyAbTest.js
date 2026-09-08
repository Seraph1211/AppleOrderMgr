/* eslint-disable camelcase */
const fs = require('fs');

const MAX_ATTEMPTS = 3;
const PROGRESS_INTERVAL = 5;
const SUPPORTED_PROVIDER_NAMES = ['kdl_tunnel', 'kdl_private', 'fanproxy_tunnel', 'yiyou_http'];

/** @returns {Promise<string>} 读取标准输入。 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let content = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      content += chunk;
    });
    process.stdin.on('end', () => resolve(content));
    process.stdin.on('error', reject);
  });
}

/**
 * 从订单 URL 提取并验证测试身份。
 * @param {string} orderUrl - Apple 订单 URL
 * @returns {{orderNumber:string,appleId:string}} 订单身份
 */
function parseOrderIdentity(orderUrl) {
  const parsed = new URL(orderUrl);
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'www.apple.com.cn' ||
    parts.length !== 5 ||
    parts[0] !== 'xc' ||
    parts[1] !== 'cn' ||
    parts[2] !== 'vieworder' ||
    !/^W\d{10}$/.test(parts[3]) ||
    !parts[4]
  ) {
    throw new Error('订单 URL 格式无效');
  }
  return { orderNumber: parts[3], appleId: parts[4] };
}

/**
 * 将请求异常归类为脱敏统计键。
 * @param {Error} error - 请求异常
 * @returns {string} 错误分类
 */
function classifyAttemptError(error) {
  const status = error.response?.status || error.httpStatus;
  if (error.eventType === 'order_identity') return 'IDENTITY';
  if (error.eventType === 'parse') return 'PARSE';
  if (status >= 400) return `HTTP_${status}`;
  if (error.code === 'ECONNRESET') return 'ECONNRESET';
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return 'TIMEOUT';
  if (error.code === 'ERR_BAD_RESPONSE') return 'STREAM_INTERRUPTED';
  if (error.code === 'ERR_BAD_REQUEST') return 'BAD_REQUEST';
  return 'TRANSPORT';
}

/**
 * 创建单个 Provider 的聚合统计。
 * @param {string} provider - Provider 名称
 * @param {number} total - 订单总数
 * @returns {Object} 聚合统计
 */
function createAggregate(provider, total) {
  return {
    provider,
    total,
    success: 0,
    failed: 0,
    successByAttempt: { first: 0, second: 0, third: 0 },
    attempts: 0,
    attemptErrors: {},
    finalErrors: {},
    identityMismatch: 0,
    statusCounts: {},
    paymentStatusCounts: {},
    amountProvided: 0,
    amountMissing: 0,
    zeroProductOrders: 0,
    productCount: 0,
    results: Array(total).fill(false),
  };
}

/** @param {Object} counts - 计数对象 @param {string} key - 计数键 @returns {void} */
function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

/**
 * 为一次尝试取得代理，必要时重新提取。
 * @param {Object} provider - Provider 实例
 * @returns {Promise<Object>} 代理配置
 */
async function getAvailableProxy(provider) {
  let proxy = provider.getNextProxy();
  if (!proxy) {
    await provider.refresh();
    proxy = provider.getNextProxy();
  }
  if (!proxy) throw new Error('代理池为空');
  return proxy;
}

/**
 * 使用指定 Provider 测试一条订单，不写数据库。
 * @param {Object} context - 运行上下文
 * @returns {Promise<void>}
 */
async function testOrder(context) {
  const {
    provider,
    providerName,
    orderUrl,
    orderIndex,
    aggregate,
    crawlerRateLimiter,
    crawlerService,
  } = context;
  const identity = parseOrderIdentity(orderUrl);
  crawlerService.validateOrderUrl(orderUrl, identity.orderNumber, identity.appleId);
  let finalError = 'TRANSPORT';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let proxy = null;
    aggregate.attempts++;
    try {
      proxy = await getAvailableProxy(provider);
      await crawlerRateLimiter.acquire();
      const html = await crawlerService.fetchOrderPage(orderUrl, proxy);
      const orderJson = crawlerService.extractOrderJson(html);
      if (!orderJson) {
        const parseError = new Error('parse');
        parseError.eventType = 'parse';
        throw parseError;
      }
      const orderData = crawlerService.parseOrderData(orderJson, html);
      crawlerService.validateCrawledOrderIdentity(orderData, identity.orderNumber);
      provider.recordProxySuccess(proxy);

      aggregate.success++;
      aggregate.results[orderIndex] = true;
      increment(
        aggregate.successByAttempt,
        attempt === 1 ? 'first' : attempt === 2 ? 'second' : 'third'
      );
      increment(aggregate.statusCounts, orderData.orderStatus || 'unknown');
      increment(aggregate.paymentStatusCounts, orderData.paymentStatus || 'unknown');
      if (orderData.officialOrderAmount === null) aggregate.amountMissing++;
      else aggregate.amountProvided++;
      if (orderData.products.length === 0) aggregate.zeroProductOrders++;
      aggregate.productCount += orderData.products.length;
      return;
    } catch (error) {
      finalError = classifyAttemptError(error);
      const isKdlProvider = providerName.startsWith('kdl_');
      increment(aggregate.attemptErrors, finalError);
      if (finalError === 'IDENTITY') aggregate.identityMismatch++;
      if (proxy && finalError === 'HTTP_541') provider.markProxyAsBad(proxy);
      else if (
        proxy &&
        !['HTTP_407', 'PARSE', 'IDENTITY'].includes(finalError) &&
        !(finalError === 'HTTP_441' && isKdlProvider)
      ) {
        provider.recordProxyFailure(proxy);
      }
      if (finalError === 'HTTP_407' || (finalError === 'HTTP_441' && isKdlProvider)) break;
    }
  }

  aggregate.failed++;
  increment(aggregate.finalErrors, finalError);
  if (
    ['kdl_private', 'yiyou_http'].includes(providerName) &&
    provider.getStatus().available === 0
  ) {
    try {
      await provider.refresh();
    } catch (_error) {
      increment(aggregate.attemptErrors, 'PROXY_API');
    }
  }
}

/**
 * 删除只供内部逐单比较使用的布尔数组。
 * @param {Object} aggregate - 聚合统计
 * @returns {Object} 可输出统计
 */
function serializeAggregate(aggregate) {
  const safeAggregate = { ...aggregate };
  delete safeAggregate.results;
  return {
    ...safeAggregate,
    successRate: Number(((aggregate.success / aggregate.total) * 100).toFixed(2)),
  };
}

/**
 * 解析本次只读诊断需要运行的 Provider。
 * @param {Object} runtimeConfig - 标准输入中的运行配置
 * @returns {string[]} 去重后的 Provider 名称
 */
function resolveProviderNames(runtimeConfig) {
  const defaultProviders = ['kdl_tunnel', 'kdl_private'];
  if (runtimeConfig.fanproxyTunnel) defaultProviders.push('fanproxy_tunnel');
  if (runtimeConfig.yiyouHttp) defaultProviders.push('yiyou_http');
  if (runtimeConfig.providers === undefined) return defaultProviders;
  if (!Array.isArray(runtimeConfig.providers) || runtimeConfig.providers.length === 0) {
    throw new Error('Provider 选择不能为空');
  }

  const providerNames = [...new Set(runtimeConfig.providers)];
  if (providerNames.some(providerName => !SUPPORTED_PROVIDER_NAMES.includes(providerName))) {
    throw new Error('Provider 选择包含不支持的值');
  }
  if (providerNames.includes('fanproxy_tunnel') && !runtimeConfig.fanproxyTunnel) {
    throw new Error('网帆隧道运行配置缺失');
  }
  if (providerNames.includes('yiyou_http') && !runtimeConfig.yiyouHttp?.apiUrl) {
    throw new Error('亦优 HTTP 运行配置缺失');
  }
  return providerNames;
}

/** @returns {Promise<void>} 执行交错 A/B。 */
async function main() {
  let sequelize;
  let stage = 'read_input';
  try {
    const rawConfig = await readStdin();
    stage = 'parse_config';
    const runtimeConfig = JSON.parse(rawConfig);
    const orderFile = process.argv[2];
    const limitArgument = process.argv.find(value => value.startsWith('--limit='));
    const offsetArgument = process.argv.find(value => value.startsWith('--offset='));
    const requestedLimit = limitArgument ? Number(limitArgument.split('=')[1]) : null;
    const requestedOffset = offsetArgument ? Number(offsetArgument.split('=')[1]) : 0;
    if (!Number.isInteger(requestedOffset) || requestedOffset < 0) {
      throw new Error('测试起始位置无效');
    }
    stage = 'read_orders';
    const fileContent = fs.readFileSync(orderFile, 'utf8');
    const urls = fileContent.match(/https:\/\/www\.apple\.com\.cn\/xc\/cn\/vieworder\/\S+/g) || [];
    const uniqueUrls = [...new Set(urls)];
    const orderUrls = requestedLimit
      ? uniqueUrls.slice(requestedOffset, requestedOffset + requestedLimit)
      : uniqueUrls.slice(requestedOffset);
    if (orderUrls.length === 0) throw new Error('没有可测试订单');

    stage = 'load_runtime';
    const logger = require('../src/utils/logger');
    const FanProxyTunnelProvider = require('../src/services/crawler/proxy/fanproxyTunnelProvider');
    const YiyouHttpProvider = require('../src/services/crawler/proxy/yiyouHttpProvider');
    logger.silent = true;
    const KdlPrivateProvider = require('../src/services/crawler/proxy/kdlPrivateProvider');
    const KdlTunnelProvider = require('../src/services/crawler/proxy/kdlTunnelProvider');
    const crawlerRateLimiter = require('../src/services/crawler/crawlerRateLimiter');
    const crawlerService = require('../src/services/crawlerService');
    ({ sequelize } = require('../src/models'));

    const providerNames = resolveProviderNames(runtimeConfig);
    const providers = {};
    if (providerNames.includes('kdl_tunnel')) {
      providers.kdl_tunnel = new KdlTunnelProvider({
        host: runtimeConfig.tunnel.hosts[0],
        backupHost: runtimeConfig.tunnel.hosts[1],
        port: runtimeConfig.tunnel.port,
        username: runtimeConfig.tunnel.username,
        password: runtimeConfig.tunnel.password,
        stickyPeriod: '0.5',
        poolType: 'std',
        poolPriority: 'q10',
      });
    }
    if (providerNames.includes('kdl_private')) {
      providers.kdl_private = new KdlPrivateProvider({
        apiUrl: runtimeConfig.privateApiUrl,
        maxFailCount: 2,
        badProxyTimeout: 60000,
      });
    }
    if (providerNames.includes('fanproxy_tunnel')) {
      providers.fanproxy_tunnel = new FanProxyTunnelProvider({
        host: runtimeConfig.fanproxyTunnel.hosts[0],
        backupHost: runtimeConfig.fanproxyTunnel.hosts[1],
        port: runtimeConfig.fanproxyTunnel.port,
        account: runtimeConfig.fanproxyTunnel.account,
        password: runtimeConfig.fanproxyTunnel.password,
        country: runtimeConfig.fanproxyTunnel.country || 'CN',
        region: runtimeConfig.fanproxyTunnel.region || null,
        sessionPoolSize: runtimeConfig.fanproxyTunnel.sessionPoolSize,
        sessionMode: runtimeConfig.fanproxyTunnel.sessionMode,
      });
    }
    if (providerNames.includes('yiyou_http')) {
      providers.yiyou_http = new YiyouHttpProvider({
        apiUrl: runtimeConfig.yiyouHttp.apiUrl,
        poolTtlMs: runtimeConfig.yiyouHttp.poolTtlMs || 240000,
        maxFailCount: 2,
        badProxyTimeout: 240000,
      });
    }
    for (const [providerName, provider] of Object.entries(providers)) {
      stage = `initialize_${providerName}`;
      await provider.initialize();
    }
    if (providers.kdl_private) {
      stage = 'validate_private_auth';
      const privateSample = providers.kdl_private.getNextProxy();
      if (!privateSample?.auth?.username || !privateSample?.auth?.password) {
        throw new Error('私密代理提取结果未包含鉴权');
      }
    }
    if (providers.yiyou_http) {
      stage = 'validate_yiyou_auth';
      const yiyouSample = providers.yiyou_http.getNextProxy();
      if (!yiyouSample?.auth?.username || !yiyouSample?.auth?.password) {
        throw new Error('亦优 HTTP 提取结果未包含鉴权');
      }
    }

    const aggregates = Object.fromEntries(
      providerNames.map(providerName => [
        providerName,
        createAggregate(providerName, orderUrls.length),
      ])
    );
    const startedAt = Date.now();
    stage = 'run_orders';

    for (let index = 0; index < orderUrls.length; index++) {
      const rotation = index % providerNames.length;
      const providerOrder = [...providerNames.slice(rotation), ...providerNames.slice(0, rotation)];
      await Promise.all(
        providerOrder.map(providerName =>
          testOrder({
            provider: providers[providerName],
            providerName,
            orderUrl: orderUrls[index],
            orderIndex: index,
            aggregate: aggregates[providerName],
            crawlerRateLimiter,
            crawlerService,
          })
        )
      );
      if ((index + 1) % PROGRESS_INTERVAL === 0 || index + 1 === orderUrls.length) {
        process.stdout.write(
          `${JSON.stringify({
            progress: index + 1,
            total: orderUrls.length,
            providerSuccess: Object.fromEntries(
              providerNames.map(providerName => [providerName, aggregates[providerName].success])
            ),
          })}\n`
        );
      }
    }

    const successCombinations = {};
    for (let index = 0; index < orderUrls.length; index++) {
      const succeededProviders = providerNames.filter(
        providerName => aggregates[providerName].results[index]
      );
      increment(successCombinations, succeededProviders.join('+') || 'none');
    }
    let paired = null;
    if (aggregates.kdl_tunnel && aggregates.kdl_private) {
      paired = { both: 0, tunnelOnly: 0, privateOnly: 0, neither: 0 };
      for (let index = 0; index < orderUrls.length; index++) {
        const tunnelSucceeded = aggregates.kdl_tunnel.results[index];
        const privateSucceeded = aggregates.kdl_private.results[index];
        if (tunnelSucceeded && privateSucceeded) paired.both++;
        else if (tunnelSucceeded) paired.tunnelOnly++;
        else if (privateSucceeded) paired.privateOnly++;
        else paired.neither++;
      }
    }

    process.stdout.write(
      `${JSON.stringify({
        completed: true,
        inputUrlCount: uniqueUrls.length,
        inputOffset: requestedOffset,
        testedOrderCount: orderUrls.length,
        order:
          providerNames.length === 2
            ? 'alternating_parallel_per_order'
            : 'rotating_parallel_per_order',
        requestsPerSecond: 1,
        maxAttemptsPerProvider: MAX_ATTEMPTS,
        durationSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        paired,
        successCombinations,
        providers: Object.fromEntries(
          providerNames.map(providerName => [
            providerName,
            serializeAggregate(aggregates[providerName]),
          ])
        ),
      })}\n`
    );
  } catch (_error) {
    process.stderr.write(
      `${JSON.stringify({ completed: false, stage, error: 'configuration_or_external_failure' })}\n`
    );
    process.exitCode = 1;
  } finally {
    if (sequelize) await sequelize.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseOrderIdentity,
  classifyAttemptError,
  createAggregate,
  serializeAggregate,
  resolveProviderNames,
};
