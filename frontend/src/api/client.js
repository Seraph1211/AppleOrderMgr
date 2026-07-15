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

// 请求拦截器
client.interceptors.request.use(
  (config) => {
    // 可以在这里添加 token
    // const token = localStorage.getItem('token')
    // if (token) {
    //   config.headers.Authorization = `Bearer ${token}`
    // }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 响应拦截器
client.interceptors.response.use(
  (response) => {
    return response.data
  },
  (error) => {
    if (error.response) {
      // 服务器返回错误
      const { status, data } = error.response

      if (status === 401) {
        // 未授权，跳转登录
        console.error('Unauthorized')
      } else if (status === 404) {
        console.error('Resource not found')
      } else if (status >= 500) {
        console.error('Server error:', data.message)
      }

      return Promise.reject(data || error.response)
    } else if (error.request) {
      // 请求发出但没有响应
      console.error('Network error:', error.message)
      return Promise.reject({ message: '网络错误，请检查连接' })
    } else {
      // 其他错误
      return Promise.reject({ message: error.message })
    }
  }
)

export default client
