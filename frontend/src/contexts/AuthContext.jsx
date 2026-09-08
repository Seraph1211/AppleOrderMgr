import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import client from '../api/client';

const AuthContext = createContext(null);

function getStoredSession() {
  const localToken = localStorage.getItem('token');
  if (localToken) return { token: localToken, storageType: 'localStorage' };
  const sessionToken = sessionStorage.getItem('token');
  if (sessionToken) return { token: sessionToken, storageType: 'sessionStorage' };
  return null;
}

function persistUser(user, storageType) {
  const storage = storageType === 'localStorage' ? localStorage : sessionStorage;
  storage.setItem('user', JSON.stringify(user));
}

/**
 * 认证与逐用户权限上下文。权限必须以 /auth/me 的服务端快照为准。
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refreshCurrentUser = useCallback(async () => {
    const session = getStoredSession();
    if (!session) {
      setUser(null);
      return null;
    }
    const response = await client.get('/auth/me');
    const nextUser = { ...response.data, ...session };
    persistUser(response.data, session.storageType);
    setUser(nextUser);
    return nextUser;
  }, []);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      try {
        await refreshCurrentUser();
      } catch (_error) {
        if (active) setUser(null);
      } finally {
        if (active) setLoading(false);
      }
    };
    restore();
    const refreshOnForbidden = () => refreshCurrentUser().catch(() => undefined);
    window.addEventListener('auth-permissions-stale', refreshOnForbidden);
    return () => {
      active = false;
      window.removeEventListener('auth-permissions-stale', refreshOnForbidden);
    };
  }, [refreshCurrentUser]);

  const login = useCallback((userData, rememberMe = false) => {
    const { token, ...userInfo } = userData;
    const storageType = rememberMe ? 'localStorage' : 'sessionStorage';
    const storage = rememberMe ? localStorage : sessionStorage;
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('user');
    storage.setItem('token', token);
    persistUser(userInfo, storageType);
    setUser({ ...userInfo, token, storageType });
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('user');
    setUser(null);
  }, []);

  const getToken = useCallback(
    () => user?.token || getStoredSession()?.token || null,
    [user?.token]
  );
  const isAuthenticated = useCallback(() => Boolean(user && getToken()), [getToken, user]);
  const isAdmin = useCallback(() => user?.role === 'admin', [user?.role]);
  const can = useCallback(
    permission => Boolean(user?.permissions?.includes(permission)),
    [user?.permissions]
  );
  const hasAllPermissions = useCallback(permissions => permissions.every(can), [can]);

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      logout,
      getToken,
      isAuthenticated,
      isAdmin,
      can,
      hasAllPermissions,
      refreshCurrentUser,
    }),
    [
      user,
      loading,
      login,
      logout,
      getToken,
      isAuthenticated,
      isAdmin,
      can,
      hasAllPermissions,
      refreshCurrentUser,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * 读取认证上下文。
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}

export default AuthContext;
