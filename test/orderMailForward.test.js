const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');
const { buildForwardMessage } = require('../src/services/orderMailForward');

const delivery = {
  id: 'fixture-id',
  payload: { recipient: 'target@example.test', note: '<b>备注</b>\n第二行' },
};
const config = { from: 'sender@example.test' };
const raw = Buffer.from('Original MIME bytes');
const original = {
  subject: '订单 W1234567890',
  from: { text: 'Apple <a@apple.com>' },
  text: '原始订单正文',
  html: '<html><head><style>.order{color:blue}@media(max-width:600px){table{width:100%}}</style></head><body><table class="order" style="background:#fff"><tr><td>原始订单正文</td></tr></table><img src="https://apple.com/image.png"><img src="cid:logo@test"><a href="https://apple.com/order">查看订单</a></body></html>',
  attachments: [
    {
      filename: 'receipt.pdf',
      content: Buffer.from('%PDF-test'),
      contentType: 'application/pdf',
      contentDisposition: 'attachment',
    },
    {
      filename: 'logo.png',
      content: Buffer.from('image-bytes'),
      contentType: 'image/png',
      contentId: '<logo@test>',
      contentDisposition: 'inline',
      related: true,
    },
  ],
};

describe('普通正文转发与原始EML并存', () => {
  test('保留HTML排版、链接、远程图片引用和原附件，安全转义备注', () => {
    const result = buildForwardMessage(delivery, original, raw, config);
    const $ = cheerio.load(result.html);
    expect($('table.order td').text()).toBe('原始订单正文');
    expect($('style').text()).toContain('@media');
    expect($('table').attr('style')).toBe('background:#fff');
    expect($('a').attr('href')).toBe('https://apple.com/order');
    expect($('img').first().attr('src')).toBe('https://apple.com/image.png');
    expect($('b').length).toBe(0);
    expect($('body').text()).toContain('<b>备注</b>');
    expect(result.text).toContain('原始订单正文');
    expect(result.attachments[0].content).toEqual(original.attachments[0].content);
    expect(result.attachments[1]).toMatchObject({ cid: 'logo@test', contentDisposition: 'inline' });
    expect(result.attachments[2]).toMatchObject({ filename: '原始邮件.eml', content: raw });
    expect(result.disableUrlAccess).toBe(true);
  });

  test('移除活动内容，原始邮件字节仍保留在额外附件中', () => {
    const result = buildForwardMessage(
      delivery,
      {
        ...original,
        html: '<script>alert(1)</script><iframe src="https://evil.test"></iframe><svg onload="bad()"></svg><img src="javascript:alert(1)" onerror="bad()"><a href="java&#x09;script:bad()">按钮</a><div style="expression(bad())">正文</div>',
      },
      raw,
      config
    );
    expect(result.html).not.toMatch(/<script|<iframe|<svg|onerror|javascript:|expression\(/i);
    expect(result.attachments.at(-1).content).toEqual(raw);
  });

  test.each([undefined, false, ''])('无HTML时继续发送纯文本及原始EML：%s', html => {
    const result = buildForwardMessage(delivery, { text: '普通正文', html }, raw, config);
    expect(result.html).toBeUndefined();
    expect(result.text).toContain('普通正文');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].content).toEqual(raw);
  });

  test('实际生成并重新解析MIME后，HTML、CID图片、PDF与EML均完整', async () => {
    try {
      const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
      const result = await transport.sendMail(buildForwardMessage(delivery, original, raw, config));
      const parsed = await simpleParser(result.message, { skipImageLinks: true });
      expect(parsed.html).toContain('cid:logo@test');
      expect(parsed.html).toContain('<table');
      expect(parsed.text).toContain('原始订单正文');
      expect(parsed.attachments.find(x => x.filename === 'logo.png').content).toEqual(
        original.attachments[1].content
      );
      expect(parsed.attachments.find(x => x.filename === 'receipt.pdf').content).toEqual(
        original.attachments[0].content
      );
      expect(parsed.attachments.find(x => x.filename === '原始邮件.eml').content).toEqual(raw);
    } catch (error) {
      error.testContext = 'order-mail-forward';
      throw error;
    }
  });
});
