import client from './client';

/** 分页获取当前订单的关联邮件及同步状态。 */
export const getOrderEmails = (orderId, page = 1) =>
  client.get('/orders/' + orderId + '/emails', { params: { page, limit: 20 } });

/** 查看一封订单邮件的安全正文。 */
export const getOrderEmail = (orderId, messageId) =>
  client.get('/orders/' + orderId + '/emails/' + messageId);

/** 提交单封转发任务，调用方保留幂等键以便网络重试。 */
export const forwardOrderEmail = (orderId, messageId, body) =>
  client.post('/orders/' + orderId + '/emails/' + messageId + '/forward', body);

/** 查询单封邮件的发送历史。 */
export const getOrderEmailForwards = (orderId, messageId) =>
  client.get('/orders/' + orderId + '/emails/' + messageId + '/forwards');

/** 重新排队解析一封已归档邮件；是否应用仍由服务端开关决定。 */
export const replayOrderEmailLifecycle = (orderId, messageId) =>
  client.post('/orders/' + orderId + '/emails/' + messageId + '/lifecycle/replay');

/** 重新排队解析一个订单的全部关联邮件。 */
export const replayOrderMailLifecycle = orderId =>
  client.post('/orders/' + orderId + '/email-lifecycle/replay');

/** 重新排队解析所选订单的全部关联邮件。 */
export const replayOrderMailLifecycleBatch = orderIds =>
  client.post('/orders/email-lifecycle/replay', { orderIds });

/** 基于当前关联邮件追加人工核定事件，并使用订单邮件版本保护并发。 */
export const reviewOrderEmailLifecycle = (orderId, messageId, body) =>
  client.post('/orders/' + orderId + '/emails/' + messageId + '/lifecycle/review', body);

/** 通过认证请求下载附件，不创建公开附件地址。 */
export async function downloadOrderEmailAttachment(orderId, messageId, attachment) {
  try {
    const blob = await client.get(
      '/orders/' + orderId + '/emails/' + messageId + '/attachments/' + attachment.index,
      { responseType: 'blob' }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = attachment.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    throw new Error(error.message || '附件下载失败', { cause: error });
  }
}

/** 通过鉴权读取内嵌图片，由邮件预览转换为本地data URL。 */
export const getOrderEmailAttachmentBlob = (orderId, messageId, attachmentIndex) =>
  client.get('/orders/' + orderId + '/emails/' + messageId + '/attachments/' + attachmentIndex, {
    responseType: 'blob',
  });

/** 原子提交多收件人的独立转发任务。 */
export const forwardOrderEmailBatch = (orderId, messageId, body) =>
  client.post('/orders/' + orderId + '/emails/' + messageId + '/forward-batch', body);
