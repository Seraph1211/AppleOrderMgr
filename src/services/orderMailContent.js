const cheerio = require('cheerio');
const { simpleParser } = require('mailparser');
const ApiError = require('../utils/ApiError');

const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_LENGTH = 500000;
const ORDER_NUMBER_PATTERN = /(?<![A-Za-z0-9])W[0-9]{10}(?![A-Za-z0-9])/g;
const ACTIVE_CONTENT_SELECTOR = [
  'script,iframe,object,embed,form,input,button,textarea,select',
  'base,meta,link,svg,math,video,audio,source,track',
].join(',');
const DANGEROUS_STYLE_PATTERN = /expression\s*\(|javascript\s*:|-moz-binding|behavior\s*:/i;

function normalizedContentId(value) {
  return String(value || '')
    .trim()
    .replace(/^<|>$/g, '')
    .toLowerCase();
}

function isSafeDataImage(value) {
  return /^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(value);
}

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(value);
}

/** 返回当前解析结果中的附件摘要，不依赖历史元信息字段。 */
function mailAttachmentSummaries(parsed) {
  return (parsed.attachments || []).map((item, index) => ({
    index,
    name: String(item.filename || '附件').slice(0, 200),
    size: item.size || item.content.length,
    contentType: String(item.contentType || 'application/octet-stream').slice(0, 100),
  }));
}

/**
 * 清理订单邮件 HTML；预览时延迟远程图片并把 CID 图片映射为受控附件索引。
 * @param {object} parsed - mailparser 解析结果
 * @param {object} options - 清理选项
 * @returns {{html: string|null, remoteImageCount: number, inlineAttachmentIndexes: number[]}}
 */
function sanitizeOrderMailHtml(parsed, { deferRemoteImages = true, mapInlineImages = true } = {}) {
  if (typeof parsed?.html !== 'string' || !parsed.html.trim())
    return { html: null, remoteImageCount: 0, inlineAttachmentIndexes: [] };

  const $ = cheerio.load(parsed.html);
  const attachmentByContentId = new Map();
  for (const [index, attachment] of (parsed.attachments || []).entries()) {
    const contentId = normalizedContentId(attachment.contentId || attachment.cid);
    if (contentId && /^image\//i.test(attachment.contentType || '')) {
      attachmentByContentId.set(contentId, index);
    }
  }

  let remoteImageCount = 0;
  const inlineAttachmentIndexes = new Set();
  $(ACTIVE_CONTENT_SELECTOR).remove();
  $('*').each((_index, element) => {
    for (const name of Object.keys(element.attribs || {})) {
      if (name.toLowerCase().startsWith('data-order-mail-')) $(element).removeAttr(name);
    }
  });
  $('*').each((_index, element) => {
    const node = $(element);
    for (const [name, rawValue] of Object.entries(element.attribs || {})) {
      const lowerName = name.toLowerCase();
      const value = String(rawValue || '').trim();
      if (
        /^on/i.test(lowerName) ||
        ['srcdoc', 'srcset', 'action', 'formaction', 'ping', 'poster'].includes(lowerName)
      ) {
        node.removeAttr(name);
        continue;
      }
      if (lowerName === 'style' && DANGEROUS_STYLE_PATTERN.test(value)) {
        node.removeAttr(name);
        continue;
      }
      if (lowerName === 'href') {
        if (!/^(?:https?:|mailto:|#)/i.test(value)) node.removeAttr(name);
        else if (/^https?:/i.test(value)) {
          node.attr('target', '_blank');
          node.attr('rel', 'noopener noreferrer');
        }
        continue;
      }
      if (lowerName === 'target') {
        if (element.tagName === 'a') node.attr('target', '_blank');
        else node.removeAttr(name);
        continue;
      }
      if (lowerName === 'rel') {
        if (element.tagName === 'a') node.attr('rel', 'noopener noreferrer');
        else node.removeAttr(name);
        continue;
      }
      if (lowerName === 'src' && element.tagName === 'img') {
        if (/^cid:/i.test(value)) {
          const attachmentIndex = attachmentByContentId.get(
            normalizedContentId(value.replace(/^cid:/i, ''))
          );
          if (mapInlineImages && attachmentIndex !== undefined) {
            node.removeAttr(name);
            node.attr('data-order-mail-inline-index', String(attachmentIndex));
            inlineAttachmentIndexes.add(attachmentIndex);
          } else if (mapInlineImages || attachmentIndex === undefined) node.removeAttr(name);
        } else if (isRemoteUrl(value)) {
          if (deferRemoteImages) {
            node.removeAttr(name);
            if (/^https:\/\//i.test(value)) {
              remoteImageCount += 1;
              node.attr('data-order-mail-remote-src', value);
            }
          }
        } else if (!isSafeDataImage(value)) node.removeAttr(name);
        continue;
      }
      if (lowerName === 'background') {
        if (isRemoteUrl(value)) {
          if (deferRemoteImages) {
            node.removeAttr(name);
            if (/^https:\/\//i.test(value)) {
              remoteImageCount += 1;
              node.attr('data-order-mail-remote-background', value);
            }
          }
        } else if (!isSafeDataImage(value)) node.removeAttr(name);
        continue;
      }
      if (['src', 'xlink:href'].includes(lowerName)) node.removeAttr(name);
    }
  });
  $('style').each((_index, element) => {
    if (DANGEROUS_STYLE_PATTERN.test($(element).text())) $(element).remove();
  });

  return {
    html: $.html(),
    remoteImageCount,
    inlineAttachmentIndexes: [...inlineAttachmentIndexes].sort((left, right) => left - right),
  };
}

/** 只把HTML转为文字，不执行内容或下载外部图片。 */
function htmlToText(html) {
  const $ = cheerio.load(String(html || ''));
  $('script,style,noscript,iframe,object,svg,head').remove();
  $('br').replaceWith('\n');
  $('p,div,tr,li,h1,h2,h3').append('\n');
  return $.root().text().slice(0, MAX_TEXT_LENGTH);
}

/** 提取单一完整订单号；多订单邮件不能绕过订单数据范围。 */
function extractOrderNumber(parsed) {
  const $ = cheerio.load(String(parsed.html || ''));
  const links = [];
  $('a[href]').each((_index, element) => {
    try {
      const url = new URL($(element).attr('href'));
      if (url.protocol === 'https:' && /(^|\.)apple\.com(?:\.cn)?$/i.test(url.hostname))
        links.push(decodeURIComponent(url.href));
    } catch (_error) {
      /* 非标准链接不用于关联。 */
    }
  });
  const source = [parsed.subject || '', parsed.text || '', htmlToText(parsed.html), ...links].join(
    '\n'
  );
  const numbers = [...new Set(source.match(ORDER_NUMBER_PATTERN) || [])];
  return numbers.length === 1 ? numbers[0] : null;
}

/** 检查发件地址的完整域名或子域，不能使用显示名称授权。 */
function isAllowedSender(parsed, domains) {
  const senders = parsed.from?.value || [];
  return (
    senders.length === 1 &&
    domains.some(domain => {
      const actual =
        String(senders[0].address || '')
          .toLowerCase()
          .split('@')[1] || '';
      return actual === domain || actual.endsWith('.' + domain);
    })
  );
}

/** 有界解析MIME，不读远程资源。 */
async function parseOrderMail(raw) {
  try {
    if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_MESSAGE_BYTES)
      throw ApiError.badRequest('邮件为空或超过10MB', undefined, 'MAIL_SIZE_LIMIT');
    return await simpleParser(raw, {
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipImageLinks: true,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.badRequest('邮件内容无法解析', undefined, 'MAIL_PARSE_FAILED');
  }
}

/** 生成加密存储的元信息，不包含系统中的密码或订单快照。 */
function mailMetadata(parsed) {
  const addresses = values => (values || []).map(item => item.address).filter(Boolean);
  return {
    subject: String(parsed.subject || '无主题').slice(0, 1000),
    from: addresses(parsed.from?.value).join(', '),
    to: addresses(parsed.to?.value).join(', '),
    attachments: mailAttachmentSummaries(parsed),
  };
}

/** 转发和预览共用安全纯文本内容。 */
function mailText(parsed) {
  return String(parsed.text || htmlToText(parsed.html)).slice(0, MAX_TEXT_LENGTH);
}

/** 预览优先使用已去除样式的HTML正文，避免异常text/plain展示CSS源码。 */
function mailPreviewText(parsed) {
  const htmlText = htmlToText(parsed.html);
  return String(htmlText.trim() ? htmlText : parsed.text || '').slice(0, MAX_TEXT_LENGTH);
}

/** 每次仅接受一个裸邮箱地址，拒绝换行、地址列表和显示名称。 */
function validateForwardInput(body) {
  const recipient = typeof body?.recipient === 'string' ? body.recipient.trim() : '';
  const note = body?.note === undefined ? '' : body.note;
  const idempotencyKey = body?.idempotencyKey;
  if (
    recipient.length > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_{}|~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(
      recipient
    ) ||
    recipient.includes('..')
  )
    throw ApiError.badRequest('请输入一个有效的目标邮箱');
  if (typeof note !== 'string' || note.length > 2000)
    throw ApiError.badRequest('备注不能超过2000字符');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9-]{16,100}$/.test(idempotencyKey))
    throw ApiError.badRequest('缺少有效的发送请求标识');
  return { recipient, note, idempotencyKey };
}

module.exports = {
  MAX_MESSAGE_BYTES,
  htmlToText,
  extractOrderNumber,
  isAllowedSender,
  parseOrderMail,
  mailAttachmentSummaries,
  mailMetadata,
  mailText,
  mailPreviewText,
  sanitizeOrderMailHtml,
  validateForwardInput,
};
