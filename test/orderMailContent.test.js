const {
  extractOrderNumber,
  isAllowedSender,
  parseOrderMail,
  mailAttachmentSummaries,
  mailMetadata,
  mailText,
  mailPreviewText,
  sanitizeOrderMailHtml,
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
  test('预览优先从HTML提取正文，不显示异常纯文本中的CSS源码', () => {
    const text = mailPreviewText({
      text: "@font-face { font-family: 'Broken'; } body { color: red; }",
      html: [
        '<html><head><style>@font-face{font-family:Apple}</style></head>',
        '<body><h1>邮件正文</h1></body></html>',
      ].join(''),
    });
    expect(text).toContain('邮件正文');
    expect(text).not.toMatch(/font-face|color:\s*red/);
  });
  test('安全HTML预览移除活动内容并延迟远程图片', () => {
    const preview = sanitizeOrderMailHtml({
      html: '<html><head><style>.title{color:#123}@media(max-width:600px){img{width:100%}}</style></head><body><script>bad()</script><form action="https://evil.test"><input></form><h1 onclick="bad()">标题</h1><img src="https://images.apple.com/phone.png" data-order-mail-remote-src="javascript:bad()" onerror="bad()"><a href="javascript:bad()">危险链接</a><a href="https://apple.com/order" target="_top">查看订单</a></body></html>',
      attachments: [],
    });
    const $ = require('cheerio').load(preview.html);
    expect($('script,form,input').length).toBe(0);
    expect($('h1').attr('onclick')).toBeUndefined();
    expect($('style').text()).toContain('@media');
    expect($('img').attr('src')).toBeUndefined();
    expect($('img').attr('data-order-mail-remote-src')).toBe('https://images.apple.com/phone.png');
    expect($('a').first().attr('href')).toBeUndefined();
    expect($('a').last().attr('href')).toBe('https://apple.com/order');
    expect($('a').last().attr('target')).toBe('_blank');
    expect(preview.remoteImageCount).toBe(1);
  });
  test('安全HTML预览把CID图片映射为鉴权附件索引', () => {
    const parsed = {
      html: '<p>正文</p><img src="cid:logo@test"><img src="cid:missing@test">',
      attachments: [
        {
          filename: 'logo.png',
          content: Buffer.from('image'),
          contentType: 'image/png',
          contentId: '<logo@test>',
        },
      ],
    };
    const preview = sanitizeOrderMailHtml(parsed);
    const $ = require('cheerio').load(preview.html);
    expect($('img').first().attr('data-order-mail-inline-index')).toBe('0');
    expect($('img').first().attr('src')).toBeUndefined();
    expect($('img').last().attr('src')).toBeUndefined();
    expect(preview.inlineAttachmentIndexes).toEqual([0]);
    expect(mailAttachmentSummaries(parsed)).toEqual([
      { index: 0, name: 'logo.png', size: 5, contentType: 'image/png' },
    ]);
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
