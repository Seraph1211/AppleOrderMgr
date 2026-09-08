import client from './client';

export const getPermissionCatalog = () => client.get('/users/permission-catalog');
export const getUserPermissions = userId => client.get(`/users/${userId}/permissions`);
export const replaceUserPermissions = (userId, payload, idempotencyKey) =>
  client.put(`/users/${userId}/permissions`, payload, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
