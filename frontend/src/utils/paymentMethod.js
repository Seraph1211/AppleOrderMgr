/** 只有普通微信及其明确别名可以读取微信付款码，微信分付不属于此分支。 */
export function isWechatPayment(value) {
  return ['微信', '微信支付', 'wechat', 'wechat pay'].includes(
    String(value || '')
      .normalize('NFKC')
      .trim()
      .toLowerCase()
  );
}

/** 仅普通支付宝及其明确别名使用 AOS 支付宝付款链接。 */
export function isAlipayPayment(value) {
  return ['支付宝', 'alipay'].includes(
    String(value || '')
      .normalize('NFKC')
      .trim()
      .toLowerCase()
  );
}
