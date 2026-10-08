const crypto = require('crypto');

/** 订单快照账号统一去首尾空格和大小写；不从联系人或关联引用猜测身份。 */
function normalizeOfficialAccount(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** 队列仅存账号摘要；缺账号返回 null，不能把所有缺账号订单聚为一组。 */
function officialAccountKey(value) {
  const account = normalizeOfficialAccount(value);
  return account ? crypto.createHash('sha256').update(account).digest('hex') : null;
}

module.exports = { normalizeOfficialAccount, officialAccountKey };
