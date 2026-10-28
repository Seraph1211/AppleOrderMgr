import client from './client';

const BASE = '/server-monitor/task-configs';
const unwrap = response => response.data;
const path = instanceId => `${BASE}/${encodeURIComponent(instanceId)}`;

/** 查询可管理实例及当前任务配置摘要。 */
export const listTaskConfigs = () => client.get(BASE).then(unwrap);
/** 查询实例当前配置及脱敏任务行。 */
export const getTaskConfig = instanceId => client.get(path(instanceId)).then(unwrap);
/** 查询实例最近的配置版本。 */
export const listTaskConfigVersions = instanceId =>
  client.get(`${path(instanceId)}/versions`).then(unwrap);
/** 查询一个历史配置的脱敏详情。 */
export const getTaskConfigVersion = (instanceId, versionId) =>
  client.get(`${path(instanceId)}/versions/${encodeURIComponent(versionId)}`).then(unwrap);
/** 提交原始配置做一次服务器解析预览。 */
export const previewTaskConfig = (instanceId, text) =>
  client.post(`${path(instanceId)}/preview`, { text }).then(unwrap);
/** 激活已核对的预览，校验实例配置修订号。 */
export const activateTaskConfig = (instanceId, body) =>
  client.post(`${path(instanceId)}/activate`, body).then(unwrap);
/** 确认实例配置未变，不生成重复任务。 */
export const confirmTaskConfig = (instanceId, expectedRevision) =>
  client.post(`${path(instanceId)}/confirm`, { expectedRevision }).then(unwrap);
/** 将实例配置标记为待更新，停止使用其通知分母。 */
export const invalidateTaskConfig = (instanceId, expectedRevision) =>
  client.post(`${path(instanceId)}/invalidate`, { expectedRevision }).then(unwrap);
/** 将历史配置作为新版本重新启用。 */
export const restoreTaskConfig = (instanceId, body) =>
  client.post(`${path(instanceId)}/restore`, body).then(unwrap);
