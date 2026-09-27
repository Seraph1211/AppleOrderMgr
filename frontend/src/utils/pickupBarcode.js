/** 只接受序列号字段的常见 Apple 条码长度；保留真实 S 起始字符。 */
export function parseSerialBarcode(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toUpperCase();
  if (/^S(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/.test(value)) value = value.slice(1);
  return /^(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/.test(value) && /[A-Z]/.test(value) ? value : null;
}

/** 将摄像头错误转换为可操作的中文提示。 */
export function cameraErrorMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError')
    return '相机权限未开启，请在浏览器的网站设置中允许使用相机，然后重试。';
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError')
    return '未找到可用相机，请使用有后置相机的手机浏览器。';
  if (error?.name === 'NotReadableError' || error?.name === 'AbortError')
    return '相机暂时不可用，请关闭其他占用相机的应用后重试。';
  return '相机启动失败，请刷新重试，或使用 Safari / Chrome 打开本网站。';
}
