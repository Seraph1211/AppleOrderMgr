/**
 * Axios 客户端配置
 * @module api/client
 */

import axios from 'axios'

// 使用相对路径，利用Vite的proxy配置
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'

const client = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器：自动附加 Authorization 头
client.interceptors.request.use(
  (config) => {
    // 从 localStorage 或 sessionStorage 读取 Token
    const token = localStorage.getItem('token') || sessionStorage.getItem('token')

    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }

    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 响应拦截器：统一处理错误
client.interceptors.response.use(
  (response) => {
    return response.data
  },
  (error) => {
    if (error.response) {
      // 服务器返回错误
      const { status, data, config } = error.response

      // 判断是否是登录请求（不自动跳转）
      const isLoginRequest = config.url.includes('/auth/login')

      if (status === 401 && !isLoginRequest) {
        // Token 过期或无效：清除存储并跳转登录页
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        sessionStorage.removeItem('token')
        sessionStorage.removeItem('user')

        // 如果当前不在登录页，跳转到登录页
        if (window.location.pathname !== '/login') {
          window.location.href = '/login'
        }

        return Promise.reject({ message: '登录已过期，请重新登录' })
      } else if (status === 403 && !isLoginRequest) {
        // 权限不足（非登录请求）
        return Promise.reject({ message: '权限不足', response: error.response })
      } else if (status === 404) {
        return Promise.reject({ message: '请求的资源不存在' })
      } else if (status >= 500) {
        return Promise.reject({ message: data?.message || '服务器错误' })
      }

      // 对于登录请求的 401/403，保留原始错误信息
      return Promise.reject(error)
    } else if (error.request) {
      // 请求发出但没有响应
      return Promise.reject({ message: '网络错误，请检查连接' })
    } else {
      // 其他错误
      return Promise.reject({ message: error.message })
    }
  }
)

export default client
