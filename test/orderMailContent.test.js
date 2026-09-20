const {
  extractOrderNumber,
  isAllowedSender,
  parseOrderMail,
  mailMetadata,
  mailText,
  validateForwardInput,
} = require('../src/services/orderMailContent');

describe('订单邮件识别与安全正文', () => {
  test.each([
    [{ subject: '订单 W1234567890' }, 'W1234567890'],
    [{ text: 'W1234567890 和 W1234567890' }, 'W1234567890'],
    [{ text: 'W1234567890 W2234567890' }, null],
    [{ subject: '电子收据 MD12345678', to: { text: 'same@example.com' } }, null],
    [{ text: 'AW1234567890 W12345678901 W1234567890x' }, null],
    [{ html: '<a href="https://www.apple.com.cn/order/W1234567890">查看订单</a>' }, 'W1234567890'],
    [{ html: '<a href="https://apple.com.evil.test/W1234567890">查看订单</a>' }, null],
    [{ html: '<script>W1234567890</script><p>收据</p>' }, null],
    [{ subject: 'W1234567890', html: '<p>另一订单 W2234567890</p>' }, null],
  ])('仅匹配唯一完整订单号 %j', (input, expected) => {
    expect(extractOrderNumber(input)).toBe(expected);
  });
  test.each([
    ['a@apple.com', true],
    ['a@orders.apple.com', true],
    ['a@apple.com.cn', true],
    ['a@evilapple.com', false],
    ['a@apple.com.evil.test', false],
  ])('验证完整发件域名 %s', (address, allowed) => {
    expect(isAllowedSender({ from: { value: [{ address }] } }, ['apple.com', 'apple.com.cn'])).toBe(
      allowed
    );
  });
  test('HTML仅转文字，不保留脚本、远程图片和表单动作', () => {
    const text = mailText({
      html: '<script>secret()</script><p>订单</p><img src="https://tracker.test"><p>详情</p>',
    });
    expect(text).toContain('订单\n');
    expect(text).not.toMatch(/secret|tracker|<img/);
  });
  test('MIME元信息保留原始收件地址', async () => {
    const parsed = await parseOrderMail(
      Buffer.from(
        'From: Apple <a@apple.com>\r\nTo: original@vvv8.net\r\nSubject: W1234567890\r\n\r\nOrder body'
      )
    );
    expect(mailMetadata(parsed).to).toBe('original@vvv8.net');
    expect(mailText(parsed)).toContain('Order body');
  });
  test('拒绝空邮件和过大邮件', async () => {
    await expect(parseOrderMail(Buffer.alloc(0))).rejects.toMatchObject({
      code: 'MAIL_SIZE_LIMIT',
    });
    await expect(parseOrderMail(Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toMatchObject({
      code: 'MAIL_SIZE_LIMIT',
    });
  });
  test.each([
    'a@b.com,b@c.com',
    'a@b.com\r\nBcc: other@test.com',
    'Name <a@b.com>',
    '',
    'a@b..com',
  ])('拒绝地址列表与邮件头注入 %s', recipient => {
    expect(() => validateForwardInput({ recipient, idempotencyKey: 'a'.repeat(16) })).toThrow();
  });
  test('校验单地址、备注和幂等键', () => {
    expect(
      validateForwardInput({ recipient: ' A@test.com ', idempotencyKey: 'a'.repeat(16) })
    ).toEqual({ recipient: 'A@test.com', note: '', idempotencyKey: 'a'.repeat(16) });
    expect(() =>
      validateForwardInput({
        recipient: 'a@b.com',
        note: 'a'.repeat(2001),
        idempotencyKey: 'a'.repeat(16),
      })
    ).toThrow();
  });
});
