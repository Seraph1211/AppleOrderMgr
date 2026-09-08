/**
 * 系统日志与自动刷新 API
 * @module api/systemApi
 */

import client from "./client";

/**
 * 查询系统日志
 * @param {Object} params - 查询参数
 * @returns {Promise<Object>} 日志列表
 */
export const getSystemLogs = (params = {}) => {
  return client.get("/system/logs", { params });
};

/**
 * 查询自动刷新状态
 * @returns {Promise<Object>} 自动刷新状态
 */
export const getAutoRefreshStatus = () => {
  return client.get("/system/auto-refresh");
};

/**
 * 管理员恢复自动刷新
 * @returns {Promise<Object>} 恢复结果
 */
export const resumeAutoRefresh = () => {
  return client.post("/system/auto-refresh/resume");
};

/**
 * 查询代理 Provider 切换状态
 * @returns {Promise<Object>} 脱敏 Provider 状态
 */
export const getProxyProviderStatus = () => {
  return client.get("/system/proxy-provider");
};

/**
 * 提交代理 Provider 切换请求
 * @param {'kdl_tunnel'|'kdl_private'|'fanproxy_tunnel'|'yiyou_http'} provider - 目标 Provider
 * @returns {Promise<Object>} 切换请求状态
 */
export const switchProxyProvider = (provider) => {
  return client.post("/system/proxy-provider", { provider });
};
