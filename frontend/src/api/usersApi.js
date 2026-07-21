import client from './client';

/**
 * 用户管理 API
 */
const usersApi = {
  /**
   * 获取用户列表
   * @param {Object} params - 查询参数
   * @param {number} params.page - 页码
   * @param {number} params.pageSize - 每页数量
   * @param {string} params.search - 搜索关键词
   * @param {string} params.role - 角色筛选
   * @param {string} params.status - 状态筛选
   * @returns {Promise<Object>} 用户列表数据
   */
  getUsers: async (params = {}) => {
    const response = await client.get('/users', { params });
    return response.data;
  },

  /**
   * 创建用户
   * @param {Object} userData - 用户数据
   * @param {string} userData.username - 用户名
   * @param {string} userData.password - 密码
   * @param {string} userData.role - 角色
   * @returns {Promise<Object>} 创建的用户
   */
  createUser: async (userData) => {
    const response = await client.post('/users', userData);
    return response.data;
  },

  /**
   * 更新用户
   * @param {number} id - 用户ID
   * @param {Object} userData - 更新的用户数据
   * @returns {Promise<Object>} 更新的用户
   */
  updateUser: async (id, userData) => {
    const response = await client.put(`/users/${id}`, userData);
    return response.data;
  },

  /**
   * 删除用户
   * @param {number} id - 用户ID
   * @returns {Promise<void>}
   */
  deleteUser: async (id) => {
    const response = await client.delete(`/users/${id}`);
    return response.data;
  },

  /**
   * 解锁用户
   * @param {number} id - 用户ID
   * @returns {Promise<Object>} 解锁结果
   */
  unlockUser: async (id) => {
    const response = await client.put(`/users/${id}/unlock`);
    return response.data;
  }
};

export default usersApi;
