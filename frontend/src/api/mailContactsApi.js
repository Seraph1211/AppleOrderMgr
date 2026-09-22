import client from './client';

/** 搜索共享邮件通讯录。 */
export const listMailContacts = params => client.get('/mail-contacts', { params });
/** 管理员保存联系人。 */
export const saveMailContact = (id, body) =>
  id ? client.put('/mail-contacts/' + id, body) : client.post('/mail-contacts', body);
/** 管理员删除联系人。 */
export const deleteMailContact = id => client.delete('/mail-contacts/' + id);
