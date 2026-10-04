import client from './client';

function normalizeStockError(error) {
  return error instanceof Error ? error : new Error('库存请求未确认，请重试');
}

/** 把多选条件序列化为接口要求的 JSON 数组。 */
export function stockFilters(params = {}) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== '' && value !== undefined && value !== null)
      .map(([key, value]) => [key, Array.isArray(value) ? JSON.stringify(value) : value])
  );
}

/** 创建一次用户命令的幂等键；由表单保存至命令确认成功。 */
export function createStockRequestKey() {
  return crypto.randomUUID();
}

/** 查询自有库存；所有金额保留服务端小数字符串。 */
export async function stockGet(path, params, signal) {
  try {
    const response = await client.get(`/stock${path}`, { params: stockFilters(params), signal });
    return response.data;
  } catch (error) {
    throw normalizeStockError(error);
  }
}

/** 执行一次库存命令，调用者必须在超时重试时沿用 requestKey。 */
export async function stockCommand(method, path, payload, requestKey) {
  try {
    const response = await client.request({
      method,
      url: `/stock${path}`,
      data: { ...payload, requestKey },
    });
    return response.data;
  } catch (error) {
    throw normalizeStockError(error);
  }
}

/** 复用服务端 OCR 额度，识别结果必须人工核对，不自动重试。 */
export async function recognizeStockSerial(_orderId, image, signal) {
  try {
    const form = new FormData();
    form.append('image', image);
    return await client.post('/stock/serial/recognize', form, {
      headers: { 'Content-Type': undefined },
      timeout: 40000,
      signal,
    });
  } catch (error) {
    throw normalizeStockError(error);
  }
}
