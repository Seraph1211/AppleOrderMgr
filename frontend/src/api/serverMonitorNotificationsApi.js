import client from './client';

const BASE = '/server-monitor/notifications';

function unwrap(response) {
  return response?.data ?? response;
}

/** 查询服务器监控双通道配置。 */
export const getServerMonitorChannels = () => client.get(`${BASE}/channels`).then(unwrap);

/** 保存单个服务器监控通知通道。 */
export const saveServerMonitorChannel = (channel, body) =>
  client.put(`${BASE}/channels/${channel}`, body).then(unwrap);

/** 为单个通道登记一次合成测试投递。 */
export const testServerMonitorChannel = (channel, body) =>
  client.post(`${BASE}/channels/${channel}/test`, body).then(unwrap);

/** 预览或一次性发送当前异常摘要。 */
export const sendServerMonitorCurrentSummary = (channel, body) =>
  client.post(`${BASE}/channels/${channel}/current-summary`, body).then(unwrap);

/** 查询服务器监控投递记录。 */
export const getServerMonitorDeliveries = params =>
  client.get(`${BASE}/deliveries`, { params }).then(unwrap);

/** 查询单条投递及其事件、跨通道关联。 */
export const getServerMonitorDelivery = id =>
  client.get(`${BASE}/deliveries/${id}`).then(unwrap);

/** 重试服务器监控投递。 */
export const retryServerMonitorDelivery = (id, body) =>
  client.post(`${BASE}/deliveries/${id}/retry`, body).then(unwrap);

/** 取消尚未出站的服务器监控投递。 */
export const cancelServerMonitorDelivery = (id, body) =>
  client.post(`${BASE}/deliveries/${id}/cancel`, body).then(unwrap);

/** 查询双通道通知与 Worker 健康状态。 */
export const getServerMonitorNotificationHealth = () =>
  client.get(`${BASE}/health`).then(unwrap);
