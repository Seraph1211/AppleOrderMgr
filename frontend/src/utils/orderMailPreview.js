const PREVIEW_STYLE = `
  :root { color-scheme: light; }
  html { background: #ffffff; }
  body { margin: 0; padding: 16px; color: #111827; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
`;

function contentSecurityPolicy(allowRemoteImages) {
  return [
    "default-src 'none'",
    `img-src data: blob:${allowRemoteImages ? ' https:' : ''}`,
    "style-src 'unsafe-inline'",
    'font-src data: blob:',
    "connect-src 'none'",
    "media-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** 将服务端清理后的邮件HTML封装为受限iframe文档。 */
export function buildOrderMailPreviewDocument(
  html,
  { allowRemoteImages = false, inlineImages = {} } = {}
) {
  if (!html) return '';
  const documentNode = new DOMParser().parseFromString(html, 'text/html');
  documentNode
    .querySelectorAll(
      'script,iframe,object,embed,form,input,button,textarea,select,base,meta,link,svg,math,video,audio,source,track'
    )
    .forEach(node => node.remove());
  documentNode.querySelectorAll('*').forEach(node => {
    for (const attribute of [...node.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        ['srcdoc', 'srcset', 'action', 'formaction'].includes(attribute.name)
      )
        node.removeAttribute(attribute.name);
    }
  });
  documentNode.querySelectorAll('[data-order-mail-inline-index]').forEach(node => {
    const source = inlineImages[node.getAttribute('data-order-mail-inline-index')];
    if (/^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(source || ''))
      node.setAttribute('src', source);
  });
  documentNode.querySelectorAll('[data-order-mail-remote-src]').forEach(node => {
    const source = node.getAttribute('data-order-mail-remote-src');
    if (allowRemoteImages && /^https:\/\//i.test(source || '')) node.setAttribute('src', source);
  });
  documentNode.querySelectorAll('[data-order-mail-remote-background]').forEach(node => {
    const source = node.getAttribute('data-order-mail-remote-background');
    if (allowRemoteImages && /^https:\/\//i.test(source || ''))
      node.setAttribute('background', source);
  });

  const csp = documentNode.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', contentSecurityPolicy(allowRemoteImages));
  const style = documentNode.createElement('style');
  style.textContent = PREVIEW_STYLE;
  documentNode.head.prepend(style);
  documentNode.head.prepend(csp);
  return '<!doctype html>\n' + documentNode.documentElement.outerHTML;
}

/** 把鉴权取得的内嵌图片转换为沙箱可以显示的data URL。 */
export function blobToDataUrl(blob, contentType) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('内嵌图片读取失败'));
    reader.readAsDataURL(new Blob([blob], { type: contentType || blob.type || 'image/png' }));
  });
}
