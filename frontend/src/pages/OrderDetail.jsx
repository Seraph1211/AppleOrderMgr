import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Package,
  User,
  Mail,
  CreditCard,
  MapPin,
  Calendar,
  RefreshCw,
  ExternalLink
} from 'lucide-react'

export default function OrderDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [order, setOrder] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadOrderDetail()
  }, [id])

  const loadOrderDetail = async () => {
    setLoading(true)
    // TODO: 从 API 获取数据
    setTimeout(() => {
      setOrder({
        id: parseInt(id),
        orderNumber: 'W123456789',
        appleId: 'user@example.com',
        recipient: {
          name: '张三',
          idCard: '****5904',
          phone: '138****8888'
        },
        products: [
          {
            name: 'iPhone 17 Pro Max',
            model: 'MG714CH/A',
            color: '钛金属',
            storage: '256GB',
            quantity: 2,
            price: '9999',
            image: 'https://via.placeholder.com/150'
          },
          {
            name: 'Belkin 挂绳',
            model: 'HNPW2ZM/A',
            quantity: 1,
            price: '199',
            image: 'https://via.placeholder.com/150'
          }
        ],
        totalAmount: '20197',
        status: 'processing',
        paymentMethod: '支付宝',
        pickupStore: 'Apple 三里屯',
        pickupAddress: '北京市朝阳区三里屯路 19 号',
        pickupTime: '2026-07-15 14:00',
        createdAt: '2026-07-08T10:30:00Z',
        updatedAt: '2026-07-08T11:45:00Z',
        appleUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W123456789/user@example.com',
        emailReceived: true,
        crawled: true,
        lastCrawledAt: '2026-07-08T11:45:00Z',
        notes: '水果惠活动订单'
      })
      setLoading(false)
    }, 500)
  }

  const getStatusBadge = (status) => {
    const badges = {
      pending: { text: '待处理', class: 'badge-warning' },
      processing: { text: '处理中', class: 'badge-info' },
      completed: { text: '已完成', class: 'badge-success' },
      cancelled: { text: '已取消', class: 'badge-error' },
    }
    return badges[status] || badges.pending
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-dark-muted">加载订单详情...</p>
        </div>
      </div>
    )
  }

  if (!order) {
    return (
      <div className="text-center py-12">
        <p className="text-dark-muted">订单不存在</p>
        <button onClick={() => navigate('/orders')} className="btn btn-primary mt-4">
          返回订单列表
        </button>
      </div>
    )
  }

  const badge = getStatusBadge(order.status)

  return (
    <div className="space-y-6">
      {/* 返回按钮 */}
      <button
        onClick={() => navigate('/orders')}
        className="flex items-center space-x-2 text-dark-muted hover:text-dark-text transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>返回订单列表</span>
      </button>

      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">订单详情</h1>
          <p className="text-dark-muted mt-1 font-mono">{order.orderNumber}</p>
        </div>
        <div className="flex items-center space-x-4">
          <span className={`badge ${badge.class} text-base px-4 py-2`}>{badge.text}</span>
          <button
            onClick={loadOrderDetail}
            className="btn btn-primary flex items-center space-x-2"
          >
            <RefreshCw className="w-4 h-4" />
            <span>刷新</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 左侧：商品信息 */}
        <div className="lg:col-span-2 space-y-6">
          {/* 商品列表 */}
          <div className="card">
            <h2 className="text-xl font-semibold mb-4">商品信息</h2>
            <div className="space-y-4">
              {order.products.map((product, index) => (
                <div key={index} className="flex items-center space-x-4 p-4 bg-dark-bg rounded-lg">
                  <img
                    src={product.image}
                    alt={product.name}
                    className="w-20 h-20 rounded-lg object-cover"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">{product.name}</h3>
                    {product.model && (
                      <p className="text-sm text-dark-muted font-mono">{product.model}</p>
                    )}
                    {product.color && product.storage && (
                      <p className="text-sm text-dark-muted">{product.color} · {product.storage}</p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="font-semibold">× {product.quantity}</p>
                    <p className="text-sm text-dark-muted">¥{product.price}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-dark-border flex justify-between items-center">
              <span className="text-lg font-semibold">总计</span>
              <span className="text-2xl font-bold text-primary">¥{order.totalAmount}</span>
            </div>
          </div>

          {/* 取货信息 */}
          <div className="card">
            <h2 className="text-xl font-semibold mb-4">取货信息</h2>
            <div className="space-y-3">
              <div className="flex items-start space-x-3">
                <MapPin className="w-5 h-5 text-primary mt-0.5" />
                <div>
                  <p className="font-medium">{order.pickupStore}</p>
                  <p className="text-sm text-dark-muted">{order.pickupAddress}</p>
                </div>
              </div>
              <div className="flex items-center space-x-3">
                <Calendar className="w-5 h-5 text-primary" />
                <div>
                  <p className="font-medium">预约取货时间</p>
                  <p className="text-sm text-dark-muted">{order.pickupTime}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 右侧：订单信息 */}
        <div className="space-y-6">
          {/* 基本信息 */}
          <div className="card">
            <h2 className="text-xl font-semibold mb-4">订单信息</h2>
            <div className="space-y-3">
              <div>
                <p className="text-sm text-dark-muted">订单号</p>
                <p className="font-mono text-sm mt-1">{order.orderNumber}</p>
              </div>
              <div>
                <p className="text-sm text-dark-muted">创建时间</p>
                <p className="text-sm mt-1">{new Date(order.createdAt).toLocaleString('zh-CN')}</p>
              </div>
              <div>
                <p className="text-sm text-dark-muted">更新时间</p>
                <p className="text-sm mt-1">{new Date(order.updatedAt).toLocaleString('zh-CN')}</p>
              </div>
              <div>
                <p className="text-sm text-dark-muted">Apple 订单链接</p>
                <a
                  href={order.appleUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center space-x-1 text-primary hover:text-primary-400 text-sm mt-1 transition-colors"
                >
                  <span>查看官网订单</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          </div>

          {/* Apple ID 信息 */}
          <div className="card">
            <h2 className="text-xl font-semibold mb-4 flex items-center space-x-2">
              <Mail className="w-5 h-5 text-primary" />
              <span>Apple ID</span>
            </h2>
            <p className="text-sm">{order.appleId}</p>
          </div>

          {/* 取机人信息 */}
          <div className="card">
            <h2 className="text-xl font-semibold mb-4 flex items-center space-x-2">
              <User className="w-5 h-5 text-primary" />
              <span>取机人</span>
            </h2>
            <div className="space-y-2">
              <div>
                <p className="text-sm text-dark-muted">姓名</p>
                <p className="text-sm mt-1">{order.recipient.name}</p>
              </div>
              <div>
                <p className="text-sm text-dark-muted">身份证后四位</p>
                <p className="text-sm mt-1 font-mono">{order.recipient.idCard}</p>
              </div>
              <div>
                <p className="text-sm text-dark-muted">联系电话</p>
                <p className="text-sm mt-1">{order.recipient.phone}</p>
              </div>
            </div>
          </div>

          {/* 付款信息 */}
          <div className="card">
            <h2 className="text-xl font-semibold mb-4 flex items-center space-x-2">
              <CreditCard className="w-5 h-5 text-primary" />
              <span>付款方式</span>
            </h2>
            <p className="text-sm">{order.paymentMethod}</p>
          </div>

          {/* 系统信息 */}
          <div className="card">
            <h2 className="text-xl font-semibold mb-4">系统信息</h2>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-dark-muted">邮件已接收</span>
                <span className={order.emailReceived ? 'text-green-400' : 'text-red-400'}>
                  {order.emailReceived ? '是' : '否'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-dark-muted">已爬取官网</span>
                <span className={order.crawled ? 'text-green-400' : 'text-red-400'}>
                  {order.crawled ? '是' : '否'}
                </span>
              </div>
              {order.lastCrawledAt && (
                <div>
                  <p className="text-dark-muted">最后爬取时间</p>
                  <p className="mt-1">{new Date(order.lastCrawledAt).toLocaleString('zh-CN')}</p>
                </div>
              )}
              {order.notes && (
                <div>
                  <p className="text-dark-muted">备注</p>
                  <p className="mt-1">{order.notes}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
