import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Search, Filter, Download, RefreshCw, Settings, X } from 'lucide-react'
import { getOrders } from '../api'
import useColumnConfig from '../hooks/useColumnConfig'
import ColumnConfigModal from '../components/ColumnConfigModal'
import { ordersColumns } from '../constants/tableColumns'

export default function Orders() {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')

  // 筛选条件
  const [filters, setFilters] = useState({
    status: '',
    productModel: '',
    recipientName: '',
    pickupStore: '',
    payerName: ''
  })

  const [showColumnConfig, setShowColumnConfig] = useState(false)
  const { columns, saveConfig, resetConfig } = useColumnConfig('orders', ordersColumns)

  // 筛选选项（从后端获取或硬编码）
  const [filterOptions, setFilterOptions] = useState({
    productModels: [],
    stores: [],
    recipients: [],
    payers: []
  })

  useEffect(() => {
    loadOrders()
    loadFilterOptions()
  }, [])

  const loadOrders = async () => {
    setLoading(true)
    try {
      const params = {
        page: 1,
        limit: 100,
        keyword: searchTerm || undefined,
        ...filters
      }
      const res = await getOrders(params)
      if (res.success) {
        setOrders(res.data.orders.map(order => ({
          id: order.id,
          orderNumber: order.order_number,
          status: order.status,
          // Apple ID 相关
          appleId: order.apple_id || '-',
          applePassword: order.apple_password || '-',
          // 收件人相关
          recipientName: order.recipient_name || '-',
          recipientIdCard: order.recipient_id_card || '-',
          recipientEmail: order.recipient_email || '-',
          recipientPhone: order.recipient_phone || '-',
          recipientAddress: order.recipient_address || '-',
          // 产品信息
          products: order.products || [],
          // 订单信息
          orderUrl: order.order_url || '-',
          orderDate: order.order_date || '-',
          // 取货信息
          pickupStore: order.pickup_store || '-',
          pickupStoreCode: order.pickup_store_code || '-',
          pickupCode: order.pickup_code || '-',
          pickupTimeSlot: order.pickup_time_slot || '-',
          actualPickupDate: order.actual_pickup_date || '-',
          // 付款信息
          paymentMethod: order.payment_method || '-',
          payerName: order.payer_name || '-',
          paymentScreenshot: order.payment_screenshot || '-',
          // 爬虫相关
          lastCrawledAt: order.last_crawled_at || '-',
          crawlFailCount: order.crawl_fail_count || 0,
          // 业务字段
          tag: order.tag || '-',
          notes: order.notes || '-',
          // 时间戳
          createdAt: order.created_at,
          updatedAt: order.updated_at
        })))
      }
    } catch (error) {
      console.error('加载订单失败:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadFilterOptions = async () => {
    // TODO: 从后端 API 获取筛选选项
    // 临时使用硬编码数据
    setFilterOptions({
      productModels: ['iPhone 15 Pro', 'iPhone 15', 'iPhone 15 Pro Max', 'MacBook Pro', 'AirPods Pro'],
      stores: ['Apple 上海国金中心', 'Apple 北京三里屯', 'Apple 深圳万象城', 'Apple 广州天环', 'Apple 杭州湖滨银泰'],
      recipients: [],
      payers: []
    })
  }

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }))
  }

  const resetFilters = () => {
    setFilters({
      status: '',
      productModel: '',
      recipientName: '',
      pickupStore: '',
      payerName: ''
    })
    setSearchTerm('')
  }

  const getStatusBadge = (status) => {
    const badges = {
      pending: { text: '待处理', class: 'badge-warning' },
      processing: { text: '处理中', class: 'badge-info' },
      shipped: { text: '已发货', class: 'badge-info' },
      ready_for_pickup: { text: '可取货', class: 'badge-success' },
      completed: { text: '已完成', class: 'badge-success' },
      cancelled: { text: '已取消', class: 'badge-error' },
    }
    return badges[status] || badges.pending
  }

  const filteredOrders = orders.filter(order => {
    const matchesSearch =
      order.orderNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      order.appleId.toLowerCase().includes(searchTerm.toLowerCase()) ||
      order.recipientName.toLowerCase().includes(searchTerm.toLowerCase())

    const matchesStatus = !filters.status || order.status === filters.status
    const matchesRecipient = !filters.recipientName || order.recipientName.includes(filters.recipientName)
    const matchesStore = !filters.pickupStore || order.pickupStore.includes(filters.pickupStore)
    const matchesPayer = !filters.payerName || order.payerName.includes(filters.payerName)
    const matchesProduct = !filters.productModel || order.products.some(p => p.name?.includes(filters.productModel))

    return matchesSearch && matchesStatus && matchesRecipient && matchesStore && matchesPayer && matchesProduct
  })

  const visibleColumns = columns.filter(col => col.visible)

  const renderCell = (order, column) => {
    const value = order[column.key]

    switch (column.key) {
      case 'orderNumber':
        return <span className="font-mono text-sm text-primary">{value}</span>

      case 'status':
        const badge = getStatusBadge(value)
        return <span className={`badge ${badge.class}`}>{badge.text}</span>

      case 'products':
        return (
          <div className="text-sm space-y-1">
            {order.products.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                {p.imageUrl && (
                  <img src={p.imageUrl} alt={p.name} className="w-8 h-8 object-cover rounded" />
                )}
                <span>{p.name} × {p.quantity}</span>
              </div>
            ))}
          </div>
        )

      case 'orderUrl':
        return value !== '-' ? (
          <a href={value} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline text-sm">
            查看
          </a>
        ) : <span className="text-gray-400">-</span>

      case 'orderDate':
      case 'lastCrawledAt':
      case 'createdAt':
      case 'updatedAt':
        return value !== '-' ? (
          <span className="text-sm text-gray-600">
            {new Date(value).toLocaleString('zh-CN')}
          </span>
        ) : <span className="text-gray-400">-</span>

      case 'actualPickupDate':
        return value !== '-' ? (
          <span className="text-sm text-gray-600">
            {new Date(value).toLocaleDateString('zh-CN')}
          </span>
        ) : <span className="text-gray-400">-</span>

      case 'paymentScreenshot':
        return value !== '-' ? (
          <a href={value} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline text-sm">
            查看
          </a>
        ) : <span className="text-gray-400">-</span>

      case 'applePassword':
      case 'recipientIdCard':
        return column.sensitive ? (
          <span className="text-sm text-gray-600 font-mono">******</span>
        ) : <span className="text-sm text-gray-600">{value}</span>

      case 'actions':
        return (
          <Link
            to={`/orders/${order.id}`}
            className="text-primary hover:text-blue-700 text-sm transition-colors"
          >
            查看
          </Link>
        )

      default:
        return <span className="text-sm text-gray-600">{value}</span>
    }
  }

  const activeFiltersCount = Object.values(filters).filter(v => v !== '').length

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">订单管理</h1>
          <p className="text-gray-600 mt-1">管理所有 Apple 订单</p>
        </div>
        <button
          onClick={loadOrders}
          className="btn btn-primary flex items-center space-x-2"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          <span>刷新</span>
        </button>
      </div>

      {/* 搜索栏 */}
      <div className="card">
        <div className="flex items-center gap-4">
          {/* 搜索框 */}
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="搜索订单号、Apple ID 或取机人..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="input pl-10"
            />
          </div>

          {/* 导出按钮 */}
          <button className="btn btn-secondary flex items-center space-x-2">
            <Download className="w-4 h-4" />
            <span>导出</span>
          </button>

          {/* 列设置按钮 */}
          <button
            onClick={() => setShowColumnConfig(true)}
            className="btn btn-secondary flex items-center space-x-2"
          >
            <Settings className="w-4 h-4" />
            <span>列设置</span>
          </button>
        </div>
      </div>

      {/* 筛选区域 */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-gray-600" />
            <h3 className="text-sm font-medium text-gray-700">筛选条件</h3>
            {activeFiltersCount > 0 && (
              <span className="badge badge-info">{activeFiltersCount}</span>
            )}
          </div>
          {activeFiltersCount > 0 && (
            <button
              onClick={resetFilters}
              className="text-sm text-gray-600 hover:text-gray-900 flex items-center gap-1"
            >
              <X className="w-4 h-4" />
              清空筛选
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          {/* 订单状态 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              订单状态
            </label>
            <select
              value={filters.status}
              onChange={(e) => handleFilterChange('status', e.target.value)}
              className="input"
            >
              <option value="">全部状态</option>
              <option value="pending">待处理</option>
              <option value="processing">处理中</option>
              <option value="shipped">已发货</option>
              <option value="ready_for_pickup">可取货</option>
              <option value="completed">已完成</option>
              <option value="cancelled">已取消</option>
            </select>
          </div>

          {/* 产品型号 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              产品型号
            </label>
            <select
              value={filters.productModel}
              onChange={(e) => handleFilterChange('productModel', e.target.value)}
              className="input"
            >
              <option value="">全部型号</option>
              {filterOptions.productModels.map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          </div>

          {/* 取件人 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              取件人
            </label>
            <input
              type="text"
              placeholder="输入姓名"
              value={filters.recipientName}
              onChange={(e) => handleFilterChange('recipientName', e.target.value)}
              className="input"
            />
          </div>

          {/* 取货门店 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              取货门店
            </label>
            <select
              value={filters.pickupStore}
              onChange={(e) => handleFilterChange('pickupStore', e.target.value)}
              className="input"
            >
              <option value="">全部门店</option>
              {filterOptions.stores.map((store) => (
                <option key={store} value={store}>{store}</option>
              ))}
            </select>
          </div>

          {/* 付款人 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              付款人
            </label>
            <input
              type="text"
              placeholder="输入付款人"
              value={filters.payerName}
              onChange={(e) => handleFilterChange('payerName', e.target.value)}
              className="input"
            />
          </div>
        </div>
      </div>

      {/* 订单列表 */}
      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-gray-600">加载订单...</p>
            </div>
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-600">未找到订单</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  {visibleColumns.map((col) => (
                    <th
                      key={col.key}
                      className={`text-left py-3 px-4 text-sm font-medium text-gray-500 whitespace-nowrap ${
                        col.key === 'actions' ? 'text-right' : ''
                      }`}
                      style={{ minWidth: col.width }}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-white">
                {filteredOrders.map((order) => (
                  <tr key={order.id} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
                    {visibleColumns.map((col) => (
                      <td
                        key={col.key}
                        className={`py-4 px-4 ${col.key === 'actions' ? 'text-right' : ''}`}
                      >
                        {renderCell(order, col)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 列配置弹窗 */}
      {showColumnConfig && (
        <ColumnConfigModal
          columns={columns}
          onSave={saveConfig}
          onReset={resetConfig}
          onClose={() => setShowColumnConfig(false)}
        />
      )}

      {/* 分页 */}
      {!loading && filteredOrders.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-600">
            显示 {filteredOrders.length} 条订单
          </p>
          <div className="flex space-x-2">
            <button className="btn btn-secondary">上一页</button>
            <button className="btn btn-secondary">下一页</button>
          </div>
        </div>
      )}
    </div>
  )
}
