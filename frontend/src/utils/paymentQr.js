/**
 * 仅识别服务端提供的内嵌 PNG；不请求外部图片或打开二维码地址。
 * @param {string} imageDataUrl - PNG Data URL
 * @returns {Promise<string|null>} 微信付款地址，坏图或无法识读时为 null
 */
export async function decodePaymentQr(imageDataUrl) {
  try {
    if (
      typeof imageDataUrl !== 'string' ||
      imageDataUrl.length > 180000 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(imageDataUrl)
    )
      return null;
    const image = new Image();
    image.src = imageDataUrl;
    await image.decode();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height || width > 2048 || height > 2048) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0);
    const { default: jsQR } = await import('jsqr');
    const result = jsQR(context.getImageData(0, 0, width, height).data, width, height);
    const value = result?.data;
    if (
      !value ||
      /\s/.test(value) ||
      [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return null;
    const url = new URL(value);
    return url.protocol === 'weixin:' &&
      url.host === 'wxpay' &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith('/') &&
      url.pathname.length > 1
      ? value
      : null;
  } catch {
    // 原图损坏或识读失败按已确认规则回退订单链接，不记录付款载荷。
    return null;
  }
}
