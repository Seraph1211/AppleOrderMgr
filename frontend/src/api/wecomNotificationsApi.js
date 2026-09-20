import client from './client';

/** 查询企微通知配置，不返回密钥。 */
export const getWecomSettings = () => client.get('/wecom-notifications/settings');
/** 保存企微通知配置。 */
export const saveWecomSettings = body => client.put('/wecom-notifications/settings', body);
/** 登记固定测试消息，成功仅表示入队。 */
export const testWecomNotification = body => client.post('/wecom-notifications/test', body);
/** 查询投递记录及积压。 */
export const getWecomDeliveries = params =>
  client.get('/wecom-notifications/deliveries', { params });
/** 重试指定投递。 */
export const retryWecomDelivery = (id, body) =>
  client.post(`/wecom-notifications/deliveries/${id}/retry`, body);
