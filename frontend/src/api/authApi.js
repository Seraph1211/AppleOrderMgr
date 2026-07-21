import client from './client';

/**
 * 认证 API
 */
const authApi = {
  /**
   * 用户登录
   * @param {Object} credentials - 登录凭证
   * @param {string} credentials.username - 用户名
   * @param {string} credentials.password - 密码
   * @returns {Promise<Object>} { token, user }
   */
  login: async (credentials) => {
    const response = await client.post('/auth/login', credentials);
    return response.data;
  },

  /**
   * 用户登出
   * @returns {Promise<void>}
   */
  logout: async () => {
    const response = await client.post('/auth/logout');
    return response.data;
  },

  /**
   * 获取当前用户信息
   * @returns {Promise<Object>} 用户信息
   */
  getCurrentUser: async () => {
    const response = await client.get('/auth/me');
    return response.data;
  },

  /**
   * 修改密码
   * @param {Object} data - 修改密码数据
   * @param {string} data.oldPassword - 旧密码
   * @param {string} data.newPassword - 新密码
   * @returns {Promise<Object>} 修改结果
   */
  changePassword: async (data) => {
    const response = await client.post('/auth/change-password', data);
    return response.data;
  }
};

export default authApi;
