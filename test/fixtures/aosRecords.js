/** 合成 AOS 样本，不含真实订单、账号或凭据。 */
function buildAosLine(overrides = {}) {
  const columns = [
    'W9900000001',
    'contact@example.com',
    'account@example.com',
    'synthetic-password',
    '测试',
    '用户',
    'R359',
    '',
    'synthetic-software-account',
    '13800000000',
    'MG054CH/A-iPhone 17 Pro Max 深蓝色 256G x 2',
    '微信',
    '测试 TAG',
    'https://www.apple.com.cn/xc/cn/vieworder/W9900000001/contact%40example.com',
    '2026-09-10 10:00:00.123',
    '1234',
  ];
  for (const [index, value] of Object.entries(overrides)) columns[Number(index)] = value;
  return columns.join('\t');
}
module.exports = { buildAosLine };
