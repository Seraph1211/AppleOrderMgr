import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Orders from './pages/Orders';
import OrderDetail from './pages/OrderDetail';
import AppleIds from './pages/AppleIds';
import Recipients from './pages/Recipients';
import Channels from './pages/Channels';
import ChannelOrders from './pages/ChannelOrders';
import Users from './pages/Users';
import Profile from './pages/Profile';
import OperationLogs from './pages/OperationLogs';
import ChangePassword from './pages/ChangePassword';
import SystemLogs from './pages/SystemLogs';
import EmailProcessing from './pages/EmailProcessing';
import PaymentTasks from './pages/PaymentTasks';
import PaymentDispatch from './pages/PaymentDispatch';
import IdentityVerifications from './pages/IdentityVerifications';
import { PERMISSIONS } from './constants/permissions';

function permissionRoute(permission, element) {
  return <ProtectedRoute requiredPermission={permission}>{element}</ProtectedRoute>;
}

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
                  <Route path="/identity-verifications" element={permissionRoute(PERMISSIONS.IDENTITY_READ, <IdentityVerifications />)} />
                  <Route path="/profile" element={<Profile />} />
                  <Route
                    path="/operation-logs"
                    element={permissionRoute(PERMISSIONS.SYSTEM_LOGS_READ, <OperationLogs />)}
                  />
                  <Route
                    path="/"
                    element={permissionRoute(PERMISSIONS.DASHBOARD_READ, <Dashboard />)}
                  />
                  <Route
                    path="/orders"
                    element={permissionRoute(PERMISSIONS.ORDERS_READ, <Orders />)}
                  />
                  <Route
                    path="/orders/:id"
                    element={permissionRoute(PERMISSIONS.ORDERS_READ, <OrderDetail />)}
                  />
                  <Route
                    path="/apple-ids"
                    element={permissionRoute(PERMISSIONS.APPLE_IDS_READ, <AppleIds />)}
                  />
                  <Route
                    path="/recipients"
                    element={permissionRoute(PERMISSIONS.RECIPIENTS_READ, <Recipients />)}
                  />
                  <Route
                    path="/channels"
                    element={permissionRoute(PERMISSIONS.CHANNELS_READ, <Channels />)}
                  />
                  <Route
                    path="/channels/:tag/orders"
                    element={permissionRoute(PERMISSIONS.CHANNELS_READ, <ChannelOrders />)}
                  />
                  <Route
                    path="/payment-tasks"
                    element={permissionRoute(PERMISSIONS.PAYMENT_TASKS_READ_OWN, <PaymentTasks />)}
                  />
                  <Route
                    path="/payment-dispatch"
                    element={permissionRoute(
                      PERMISSIONS.PAYMENT_DISPATCH_READ,
                      <PaymentDispatch />
                    )}
                  />
                  <Route path="/change-password" element={<ChangePassword />} />
                  <Route
                    path="/system-logs"
                    element={permissionRoute(PERMISSIONS.SYSTEM_LOGS_READ, <SystemLogs />)}
                  />

                  <Route
                    path="/email-processing"
                    element={
                      <ProtectedRoute requiredPermission={PERMISSIONS.EMAIL_READ}>
                        <EmailProcessing />
                      </ProtectedRoute>
                    }
                  />

                  {/* 仅管理员可访问：用户管理 */}
                  <Route
                    path="/users"
                    element={
                      <ProtectedRoute requiredPermission={PERMISSIONS.USERS_READ}>
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
  );
}

export default App;
