const axios = require('axios');
const { isIP } = require('net');
const crypto = require('crypto');

/** 严格解析供应商实测的单行端点格式，不输出账号或密码。 */
function parseProviderEndpoint(text) {
  const fields = typeof text === 'string' ? text.trim().split(/\s+/) : [];
  if (fields.length !== 3) throw new Error('INVALID_PROVIDER_ENDPOINT');
  const [host, port] = fields[0].split(':');
  if (isIP(host) !== 4 || !/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535)
    throw new Error('INVALID_PROVIDER_ENDPOINT');
  if (fields.slice(1).some(value => !/^[\x21-\x7e]{1,128}$/.test(value)))
    throw new Error('INVALID_PROVIDER_ENDPOINT');
  return `http://${encodeURIComponent(fields[1])}:${encodeURIComponent(fields[2])}@${host}:${port}`;
}

/** 仅从已授权既有套餐提取1个短效端点；与库存请求共享持久化预算。 */
async function acquireProxy({ apiUrl, gate, request = axios.get }) {
  let permit;
  let started;
  let finished = false;
  try {
    const url = new URL(apiUrl);
    if (
      url.origin !== 'https://api.yiyouip.com' ||
      url.pathname !== '/index.php' ||
      url.username ||
      url.password
    )
      throw new Error('INVALID_PROVIDER_URL');
    url.searchParams.set('num', '1');
    permit = await gate.reserve('provider', 'yiyou-provider', {});
    if (permit.waitMs && permit.waitMs <= 2000) {
      await new Promise(resolve => setTimeout(resolve, permit.waitMs));
      permit = await gate.reserve('provider', 'yiyou-provider', {});
    }
    if (!permit.id) {
      const error = new Error('PROVIDER_UNAVAILABLE');
      error.inventoryOutcome = permit.blocked || 'REQUEST_IN_FLIGHT';
      error.until = permit.until || null;
      throw error;
    }
    started = Date.now();
    const response = await request(url.href, {
      proxy: false,
      maxRedirects: 0,
      timeout: 15000,
      responseType: 'text',
      maxContentLength: 100000,
      validateStatus: () => true,
    });
    if (response.status !== 200) throw new Error('PROVIDER_HTTP_ERROR');
    const proxyUrl = parseProviderEndpoint(response.data);
    const result = {
      id: permit.id,
      egress: 'yiyou-provider',
      outcome: 'PROVIDER_ENDPOINT_RECEIVED',
      status: response.status,
      bytes: Buffer.byteLength(response.data),
      durationMs: Date.now() - started,
      summary: {
        endpointHash: crypto.createHash('sha256').update(new URL(proxyUrl).host).digest('hex'),
      },
    };
    await gate.finish(result);
    finished = true;
    return {
      label: 'yiyou-validation',
      url: proxyUrl,
      expiresAt: Date.now() + 240000,
      attemptId: permit.id,
    };
  } catch (error) {
    if (!permit?.id && error.inventoryOutcome) throw error;
    if (permit?.id && !finished) {
      try {
        await gate.finish({
          id: permit.id,
          egress: 'yiyou-provider',
          outcome: 'PROVIDER_FAILED',
          durationMs: Date.now() - started,
          bytes: 0,
        });
      } catch (_storageError) {
        throw new Error('VALIDATION_PERSISTENCE_FAILED');
      }
    }
    throw new Error('PROVIDER_UNAVAILABLE');
  }
}
module.exports = { parseProviderEndpoint, acquireProxy };
