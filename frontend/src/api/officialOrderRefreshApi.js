import client from './client';

/** 手动提交官网状态更新；列表加载不调用此接口。 */
export const submitOfficialOrderRefresh = input =>
  client.post('/orders/official-refresh/batches', input);
/** 恢复本人最近手动批次。 */
export const listOfficialOrderBatches = () => client.get('/orders/official-refresh/batches');
/** 只读轮询批次，不产生官网请求。 */
export const getOfficialOrderBatch = (id, page = 1) =>
  client.get(`/orders/official-refresh/batches/${id}`, { params: { page } });
/** 取消尚未开始的请求。 */
export const cancelOfficialOrderBatch = id =>
  client.post(`/orders/official-refresh/batches/${id}/cancel`);
