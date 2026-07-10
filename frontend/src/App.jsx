import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Orders from './pages/Orders'
import OrderDetail from './pages/OrderDetail'
import AppleIds from './pages/AppleIds'
import Recipients from './pages/Recipients'

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/:id" element={<OrderDetail />} />
        <Route path="/apple-ids" element={<AppleIds />} />
        <Route path="/recipients" element={<Recipients />} />
      </Routes>
    </Layout>
  )
}

export default App
