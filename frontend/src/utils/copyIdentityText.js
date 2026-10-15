/**
 * 在用户点击时启动复制；异步内容只获取一次，不持久保存敏感文本。
 * @param {Function} getText 获取待复制文本。
 * @returns {Promise<void>} 成功写入剪贴板后完成。
 */
export async function copyIdentityText(getText) {
  let content;
  const text = () => {
    if (!content) {
      content = Promise.resolve()
        .then(getText)
        .then(value => {
          if (!value || typeof value !== 'string') throw new Error('内容不可用');
          return value;
        });
    }
    return content;
  };
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': text().then(value => new Blob([value], { type: 'text/plain' })),
          }),
        ]);
        return;
      } catch (_error) {
        // 部分浏览器不支持 Promise ClipboardItem，继续使用文本复制。
      }
    }
    const value = await text();
    if (!value || typeof value !== 'string') throw new Error('内容不可用');
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch (_error) {
        // 兼容不支持异步剪贴板权限的浏览器。
      }
    }
    const previousFocus = document.activeElement;
    const input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', '');
    input.setAttribute('aria-hidden', 'true');
    input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(input);
    try {
      input.select();
      input.setSelectionRange(0, value.length);
      if (!document.execCommand('copy')) throw new Error('复制未完成');
    } finally {
      input.value = '';
      input.remove();
      previousFocus?.focus();
    }
  } catch (_error) {
    throw new Error('复制失败，请使用 HTTPS 并允许剪贴板访问后重试。');
  } finally {
    content = undefined;
  }
}
