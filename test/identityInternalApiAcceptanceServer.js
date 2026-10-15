/* eslint-disable camelcase -- 合成供应商协议使用error_code字段 */
/** 独立验收子进程：固定合成供应商与关闭无关调度，不连接外部服务。 */
const axios = require('axios');
let delayMs = 30;
axios.post = async (url, body) => {
  try {
    if (url !== 'https://zidv2.market.alicloudapi.com/idcheck/Post') {
      throw new Error('独立验收禁止外部请求');
    }
    const name = new URLSearchParams(body).get('realName');
    process.send?.({ type: 'provider', name, at: Date.now() });
    await new Promise(resolve => setTimeout(resolve, delayMs));
    if (name.includes('超时'))
      throw Object.assign(new Error('合成敏感异常110101199001010015'), { code: 'ECONNABORTED' });
    if (name.includes('额度'))
      return { status: 403, headers: { 'x-ca-error-code': 'quota' }, data: {} };
    if (name.includes('异常'))
      return { status: 200, headers: {}, data: { error_code: 0, result: { isok: 'false' } } };
    return {
      status: 200,
      headers: {},
      data: { error_code: 0, result: { isok: !name.includes('不一致') } },
    };
  } catch (error) {
    throw new Error('合成供应商异常', { cause: error });
  }
};
for (const file of [
  'stockReturnScheduler',
  'paymentDispatchScheduler',
  'paymentOfficialRefreshScheduler',
  'ingestionScheduler',
  'proxyOrderScheduler',
  'monitorService',
]) {
  const service = require(`../src/services/${file}`);
  service.start = () => {};
}
const runner = require('../src/services/identityVerificationRunner');
runner.start = () => {};
process.on('message', async message => {
  try {
    if (message.type === 'delay') delayMs = message.value;
    if (message.type === 'runner') await runner.runOnce();
    process.send?.({ type: 'ack', id: message.id });
  } catch (_error) {
    process.send?.({ type: 'ack', id: message.id, error: true });
  }
});
require('../src/app');
