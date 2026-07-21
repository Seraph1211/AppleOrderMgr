import { createContext, useContext, useState, useEffect } from 'react'

const AuthContext = createContext(null)

/**
 * 认证上下文提供者
 * 管理用户登录状态、Token存储、用户信息
 * 支持记住我功能（localStorage vs sessionStorage）
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  // 初始化：从存储中恢复用户状态
  useEffect(() => {
    const loadUser = () => {
      try {
        // 优先从 localStorage 读取（记住我）
        let token = localStorage.getItem('token')
        let userInfo = localStorage.getItem('user')
        let storageType = 'localStorage'

        // 如果 localStorage 没有，尝试从 sessionStorage 读取
        if (!token) {
          token = sessionStorage.getItem('token')
          userInfo = sessionStorage.getItem('user')
          storageType = 'sessionStorage'
        }

        if (token && userInfo) {
          const parsedUser = JSON.parse(userInfo)
          setUser({ ...parsedUser, token, storageType })
        }
      } catch (error) {
        console.error('Failed to load user from storage:', error)
      } finally {
        setLoading(false)
      }
    }

    loadUser()
  }, [])

  /**
   * 登录方法
   * @param {Object} userData - 用户数据（包含 token, username, role, forcePasswordChange）
   * @param {boolean} rememberMe - 是否记住登录状态
   */
  const login = (userData, rememberMe = false) => {
    const { token, username, role, forcePasswordChange } = userData
    const userInfo = { username, role, forcePasswordChange }

    if (rememberMe) {
      // 记住我：存储到 localStorage（持久化）
      localStorage.setItem('token', token)
      localStorage.setItem('user', JSON.stringify(userInfo))
      setUser({ ...userInfo, token, storageType: 'localStorage' })
    } else {
      // 不记住我：存储到 sessionStorage（会话级）
      sessionStorage.setItem('token', token)
      sessionStorage.setItem('user', JSON.stringify(userInfo))
      setUser({ ...userInfo, token, storageType: 'sessionStorage' })
    }
  }

  /**
   * 登出方法
   * 清除所有存储的认证信息
   */
  const logout = () => {
    // 清除 localStorage
    localStorage.removeItem('token')
    localStorage.removeItem('user')

    // 清除 sessionStorage
    sessionStorage.removeItem('token')
    sessionStorage.removeItem('user')

    setUser(null)
  }

  /**
   * 获取当前Token
   * @returns {string|null} Token字符串
   */
  const getToken = () => {
    return user?.token || localStorage.getItem('token') || sessionStorage.getItem('token')
  }

  /**
   * 检查是否已登录
   * @returns {boolean} 是否已登录
   */
  const isAuthenticated = () => {
    return !!user && !!getToken()
  }

  /**
   * 检查是否是管理员
   * @returns {boolean} 是否是管理员
   */
  const isAdmin = () => {
    return user?.role === 'admin'
  }

  const value = {
    user,
    loading,
    login,
    logout,
    getToken,
    isAuthenticated,
    isAdmin,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/**
 * 使用认证上下文的 Hook
 * @returns {Object} 认证上下文对象
 */
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

export default AuthContext
