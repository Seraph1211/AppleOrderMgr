const cheerio = require('cheerio');
const { mailText } = require('./orderMailContent');

/** 保留邮件排版和图片引用；不执行内容或下载远程资源。 */
function forwardHtml(parsed, note, metadata) {
  if (typeof parsed.html !== 'string' || !parsed.html.trim()) return undefined;
  const $ = cheerio.load(parsed.html);
  $('script,iframe,object,embed,form,input,button,textarea,select,base,meta,link').remove();
  $('*').each((_index, element) => {
    for (const [name, value] of Object.entries(element.attribs || {})) {
      if (/^on/i.test(name) || ['srcdoc', 'srcset', 'action', 'formaction'].includes(name)) {
        $(element).removeAttr(name);
      } else if (['href', 'src', 'background', 'xlink:href'].includes(name)) {
        const url = value
          .split('')
          .filter(character => character > ' ')
          .join('');
        if (!/^(?:https?:|mailto:|cid:|#|data:image\/(?:png|gif|jpe?g|webp);base64,)/i.test(url))
          $(element).removeAttr(name);
      } else if (
        name === 'style' &&
        /expression\s*\(|javascript\s*:|-moz-binding|behavior\s*:/i.test(value)
      ) {
        $(element).removeAttr(name);
      }
    }
  });
  $('style').each((_index, element) => {
    if (/expression\s*\(|javascript\s*:|-moz-binding|behavior\s*:/i.test($(element).text()))
      $(element).remove();
  });
  const header = $('<div></div>').attr(
    'style',
    'color:#333;font:14px/1.5 Arial,sans-serif;margin:0 0 20px;'
  );
  if (note)
    header.append(
      $('<div></div>').attr('style', 'white-space:pre-wrap;margin-bottom:16px;').text(note)
    );
  header.append($('<div></div>').text('---------- 转发邮件 ----------'));
  for (const line of metadata) header.append($('<div></div>').text(line));
  $('body').prepend(header);
  return $.html();
}

/** 构建普通正文转发，保留原附件、CID图片及原始EML。 */
function buildForwardMessage(delivery, parsed, raw, config) {
  const metadata = [
    '发件人：' + (parsed.from?.text || ''),
    '收件人：' + (parsed.to?.text || ''),
    '时间：' + (parsed.date?.toISOString() || ''),
    '主题：' + (parsed.subject || ''),
  ];
  const html = forwardHtml(parsed, delivery.payload.note, metadata);
  return {
    from: config.from,
    to: delivery.payload.recipient,
    envelope: { from: config.from, to: [delivery.payload.recipient] },
    messageId: '<' + delivery.id + '@' + config.from.split('@')[1] + '>',
    subject: ('转发：' + (parsed.subject || '订单邮件')).replace(/[\r\n]/g, ' ').slice(0, 1000),
    text: [
      delivery.payload.note,
      '---------- 转发邮件 ----------',
      ...metadata,
      '',
      mailText(parsed),
    ].join('\n'),
    html,
    attachments: [
      ...(parsed.attachments || []).map(item => {
        const cid = String(item.contentId || item.cid || '').replace(/^<|>$/g, '');
        const inline = Boolean(
          html && cid && (item.related || item.contentDisposition === 'inline')
        );
        return {
          filename: item.filename || '附件',
          content: item.content,
          contentType: item.contentType,
          contentDisposition: inline ? 'inline' : 'attachment',
          ...(inline ? { cid } : {}),
        };
      }),
      {
        filename: '原始邮件.eml',
        content: raw,
        contentType: 'message/rfc822',
        contentDisposition: 'attachment',
      },
    ],
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

module.exports = { buildForwardMessage };
