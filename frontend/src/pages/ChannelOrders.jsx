import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Search, Filter, ExternalLink } from 'lucide-react'
import { getChannelOrders, getChannelStats } from '../api'

export default function ChannelOrders() {
  const { tag } = useParams()
  const [orders, setOrders] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 20,
    total: 0,
  })

  useEffect(() => {
    loadChannelData()
  }, [tag, pagination.page, statusFilter])

  const loadChannelData = async () => {
    setLoading(true)
    try {
      // 加载统计数据
      const statsRes = await getChannelStats(tag)
      if (statsRes.success) {
        setStats(statsRes.data)
      }

      // 加载订单列表
      const ordersRes = await getChannelOrders(tag, {
        page: pagination.page,
        pageSize: pagination.pageSize,
        status: statusFilter || undefined,
        search: searchTerm || undefined,
      })

      if (ordersRes.success) {
        setOrders(ordersRes.data.items || [])
        setPagination(prev => ({
          ...prev,
          total: ordersRes.data.total,
        }))
      }
    } catch (error) {
      console.error('加载渠道数据失败:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = () => {
    setPagination(prev => ({ ...prev, page: 1 }))
    loadChannelData()
  }

  const handleStatusFilterChange = (status) => {
    setStatusFilter(status)
    setPagination(prev => ({ ...prev, page: 1 }))
  }

  const getStatusBadgeClass = (status) => {
    const statusMap = {
      'pending': 'badge badge-warning',
      'processing': 'badge badge-info',
      'shipped': 'badge badge-info',
      'ready_for_pickup': 'badge badge-success',
      'completed': 'badge badge-success',
      'cancelled': 'badge badge-error',
    }
    return statusMap[status] || 'badge'
  }

  const getStatusText = (status) => {
    const statusMap = {
      'pending': '待处理',
      'processing': '处理中',
      'shipped': '已发货',
      'ready_for_pickup': '待取货',
      'completed': '已完成',
      'cancelled': '已取消',
    }
    return statusMap[status] || status
  }

  return (
    <div className="space-y-6">
      {/* 页头 */}
      <div className="flex items-center gap-4">
        <Link
          to="/channels"
          className="text-gray-600 hover:text-gray-900 transition-colors"
        >
          <ArrowLeft className="w-6 h-6" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900">
            {stats?.channelName || decodeURIComponent(tag)}
          </h1>
          <p className="text-sm text-gray-500 mt-1">渠道订单明细</p>
        </div>
      </div>

      {/* 统计卡片 */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="card">
            <p className="text-sm text-gray-500">总订单数</p>
            <p className="text-2xl font-bold text-gray-900 mt-2">{stats.totalOrders}</p>
          </div>
          <div className="card">
            <p className="text-sm text-gray-500">待取货</p>
            <p className="text-2xl font-bold text-yellow-600 mt-2">{stats.readyOrders}</p>
          </div>
          <div className="card">
            <p className="text-sm text-gray-500">已完成</p>
            <p className="text-2xl font-bold text-green-600 mt-2">{stats.completedOrders}</p>
          </div>
          <div className="card">
            <p className="text-sm text-gray-500">已取消</p>
            <p className="text-2xl font-bold text-red-600 mt-2">{stats.cancelledOrders}</p>
          </div>
        </div>
      )}

      {/* 搜索和筛选 */}
      <div className="card">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="搜索订单号、取机人..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="input pl-10 w-full"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-gray-500" />
            <select
              value={statusFilter}
              onChange={(e) => handleStatusFilterChange(e.target.value)}
              className="input"
            >
              <option value="">全部状态</option>
              <option value="pending">待处理</option>
              <option value="processing">处理中</option>
              <option value="shipped">已发货</option>
              <option value="ready_for_pickup">待取货</option>
              <option value="completed">已完成</option>
              <option value="cancelled">已取消</option>
            </select>
          </div>
          <button onClick={handleSearch} className="btn btn-primary">
            搜索
          </button>
        </div>
      </div>

      {/* 订单列表 */}
      <div className="card">
        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500">暂无订单数据</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">订单号</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">商品信息</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">取机人</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">手机号</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">邮箱</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">取货门店</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">取货时间</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">订单链接</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">状态</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">付款方式</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">下单时间</th>
                </tr>
              </thead>
              <tbody className="bg-white">
                {orders.map((order) => (
                  <tr
                    key={order.id}
                    className="border-b border-gray-200 hover:bg-gray-50 transition-colors"
                  >
                    <td className="py-4 px-4">
                      <span className="font-medium text-gray-900">{order.orderNumber}</span>
                    </td>
                    <td className="py-4 px-4">
                      <div className="max-w-xs">
                        {order.products && order.products.length > 0 ? (
                          <div className="text-sm">
                            {order.products.map((product, idx) => (
                              <div key={idx} className="text-gray-900">
                                {product.name} x{product.quantity}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </div>
                    </td>
                    <td className="py-4 px-4">
                      <span className="text-gray-900">{order.recipientName || '-'}</span>
                    </td>
                    <td className="py-4 px-4">
                      <span className="text-gray-900">{order.recipientPhone || '-'}</span>
                    </td>
                    <td className="py-4 px-4">
                      <span className="text-gray-900 text-sm">{order.appleId || '-'}</span>
                    </td>
                    <td className="py-4 px-4">
                      <span className="text-gray-900">{order.pickupStore || '-'}</span>
                    </td>
                    <td className="py-4 px-4">
                      <span className="text-gray-900">{order.pickupTimeSlot || '-'}</span>
                    </td>
                    <td className="py-4 px-4">
                      {order.orderUrl && order.orderUrl !== '-' ? (
                        <a
                          href={order.orderUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:text-primary-dark hover:underline transition-colors"
                        >
                          查看订单
                        </a>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="py-4 px-4">
                      <span className={getStatusBadgeClass(order.status)}>
                        {getStatusText(order.status)}
                      </span>
                    </td>
                    <td className="py-4 px-4">
                      <span className="text-gray-900">{order.paymentMethod || '-'}</span>
                    </td>
                    <td className="py-4 px-4">
                      <span className="text-gray-600 text-sm">
                        {order.orderDate ? new Date(order.orderDate).toLocaleString('zh-CN') : '-'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 分页 */}
        {pagination.total > pagination.pageSize && (
          <div className="flex justify-between items-center mt-4 pt-4 border-t border-gray-200">
            <div className="text-sm text-gray-500">
              共 {pagination.total} 条记录，第 {pagination.page} / {Math.ceil(pagination.total / pagination.pageSize)} 页
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
                disabled={pagination.page === 1}
                className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                上一页
              </button>
              <button
                onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
                disabled={pagination.page >= Math.ceil(pagination.total / pagination.pageSize)}
                className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
