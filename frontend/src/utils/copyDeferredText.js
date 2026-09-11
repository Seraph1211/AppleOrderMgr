/**
 * 在点击事件内启动剪贴板写入，兼容异步获取内容的手机浏览器。
 * @param {Function} getText - 异步获取文本
 * @returns {Promise<void>} 写入完成
 */
export async function copyDeferredText(getText) {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const content = Promise.resolve()
        .then(getText)
        .then(text => new Blob([text], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': content })]);
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(await getText());
    } else {
      throw new Error('当前浏览器无法复制，请使用 HTTPS 地址并允许剪贴板访问');
    }
  } catch (error) {
    throw new Error(error.message || '复制失败，请检查浏览器剪贴板权限');
  }
}
