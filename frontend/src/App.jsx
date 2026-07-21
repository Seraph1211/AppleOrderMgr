import { Routes, Route } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Orders from './pages/Orders'
import OrderDetail from './pages/OrderDetail'
import AppleIds from './pages/AppleIds'
import Recipients from './pages/Recipients'
import Channels from './pages/Channels'
import ChannelOrders from './pages/ChannelOrders'
import Users from './pages/Users'
import ChangePassword from './pages/ChangePassword'
import SystemLogs from './pages/SystemLogs'

function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* 公开路由：登录页 */}
        <Route path="/login" element={<Login />} />

        {/* 受保护的路由：需要登录 */}
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <Layout>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/orders" element={<Orders />} />
                  <Route path="/orders/:id" element={<OrderDetail />} />
                  <Route path="/apple-ids" element={<AppleIds />} />
                  <Route path="/recipients" element={<Recipients />} />
                  <Route path="/channels" element={<Channels />} />
                  <Route path="/channels/:tag/orders" element={<ChannelOrders />} />
                  <Route path="/change-password" element={<ChangePassword />} />
                  <Route path="/system-logs" element={<SystemLogs />} />

                  {/* 仅管理员可访问：用户管理 */}
                  <Route
                    path="/users"
                    element={
                      <ProtectedRoute requiredRole="admin">
                        <Users />
                      </ProtectedRoute>
                    }
                  />
                </Routes>
              </Layout>
            </ProtectedRoute>
          }
        />
      </Routes>
    </AuthProvider>
  )
}

export default App
