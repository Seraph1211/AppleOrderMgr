import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  CreditCard,
  Mail,
  MapPin,
  RefreshCw,
  User,
} from 'lucide-react';
import { getOrderDetail } from '../api';

const STATUS_BADGES = {
  pending: { text: '待处理', className: 'badge-warning' },
  processing: { text: '处理中', className: 'badge-info' },
  shipped: { text: '已发货', className: 'badge-info' },
  ready_for_pickup: { text: '可取货', className: 'badge-success' },
  completed: { text: '已完成', className: 'badge-success' },
  delivered: { text: '已送达', className: 'badge-success' },
  cancelled: { text: '已取消', className: 'badge-error' },
  pickup_cancelled: { text: '取货已取消', className: 'badge-error' },
  unknown: { text: '未知', className: 'badge-info' },
};

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN');
}

function formatAmount(value, currency = 'CNY') {
  if (value === null || value === undefined || value === '') return '待官网解析';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);
  const normalizedCurrency = currency || 'CNY';
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: normalizedCurrency,
    }).format(amount);
  } catch {
    return `${normalizedCurrency} ${amount.toFixed(2)}`;
  }
}

export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadOrderDetail = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getOrderDetail(id);
      if (!response?.success || !response.data) {
        throw new Error('订单详情响应格式异常');
      }
      setOrder(response.data);
    } catch (loadError) {
      setOrder(null);
      setError(loadError.message || '订单详情加载失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadOrderDetail();
  }, [loadOrderDetail]);

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-gray-500">加载订单详情...</p>
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="card py-12 text-center">
        <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-yellow-500" />
        <p className="font-medium text-gray-900">无法显示订单详情</p>
        <p className="mt-1 text-sm text-gray-500">{error || '订单不存在'}</p>
        <div className="mt-5 flex justify-center gap-3">
          <button onClick={() => navigate('/orders')} className="btn btn-secondary">
            返回列表
          </button>
          <button onClick={loadOrderDetail} className="btn btn-primary">
            重新加载
          </button>
        </div>
      </div>
    );
  }

  const badge = STATUS_BADGES[order.status] || STATUS_BADGES.unknown;
  const products = Array.isArray(order.products) ? order.products : [];
  const validationIssues = Array.isArray(order.validation_issues) ? order.validation_issues : [];

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate('/orders')}
        className="flex items-center gap-2 text-gray-600 transition-colors hover:text-gray-900"
      >
        <ArrowLeft className="h-4 w-4" />
        <span>返回订单列表</span>
      </button>

      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">订单详情</h1>
          <p className="mt-1 font-mono text-sm text-gray-500">{order.order_number}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`badge ${badge.className}`}>{badge.text}</span>
          <button onClick={loadOrderDetail} className="btn btn-primary flex items-center gap-2">
            <RefreshCw className="h-4 w-4" />
            <span>重新加载</span>
          </button>
        </div>
      </div>

      {validationIssues.length > 0 && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            <span>官网数据校验发现 {validationIssues.length} 项异常</span>
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-6">
            {validationIssues.map((issue, index) => (
              <li key={`${issue.type || 'issue'}-${index}`}>
                {issue.message || issue.type || '未知异常'}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="card overflow-hidden p-0">
            <div className="border-b border-gray-200 px-6 py-4">
              <h2 className="text-lg font-semibold text-gray-900">商品信息</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">商品</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">型号</th>
                    <th className="px-4 py-3 text-right text-sm font-medium text-gray-500">数量</th>
                  </tr>
                </thead>
                <tbody className="bg-white">
                  {products.length > 0 ? (
                    products.map((product, index) => (
                      <tr
                        key={`${product.model || product.name || 'product'}-${index}`}
                        className="border-b border-gray-200 last:border-0"
                      >
                        <td className="px-4 py-4 text-sm text-gray-900">{product.name || '-'}</td>
                        <td className="px-4 py-4 font-mono text-sm text-gray-600">
                          {product.model || product.modelId || '-'}
                        </td>
                        <td className="px-4 py-4 text-right text-sm text-gray-900">
                          {product.quantity ?? '-'}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="3" className="px-4 py-10 text-center text-sm text-gray-500">
                        暂无商品数据
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-6 py-4">
              <span className="text-sm font-medium text-gray-600">官网订单金额</span>
              <span className="text-xl font-bold text-primary">
                {formatAmount(order.official_order_amount, order.official_order_amount_currency)}
              </span>
            </div>
          </div>

          <div className="card">
            <h2 className="mb-4 text-lg font-semibold text-gray-900">取货信息</h2>
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <MapPin className="mt-0.5 h-5 w-5 text-primary" />
                <div>
                  <p className="font-medium text-gray-900">{order.pickup_store || '-'}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Calendar className="mt-0.5 h-5 w-5 text-primary" />
                <div>
                  <p className="font-medium text-gray-900">预约取货时间</p>
                  <p className="mt-1 text-sm text-gray-500">
                    {formatDate(order.official_pickup_date || order.actual_pickup_date)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="card">
            <h2 className="mb-4 text-lg font-semibold text-gray-900">订单信息</h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-gray-500">订单号</dt>
                <dd className="mt-1 font-mono text-gray-900">{order.order_number}</dd>
              </div>
              <div>
                <dt className="text-gray-500">创建时间</dt>
                <dd className="mt-1 text-gray-900">{formatDate(order.created_at)}</dd>
              </div>
              <div>
                <dt className="text-gray-500">更新时间</dt>
                <dd className="mt-1 text-gray-900">{formatDate(order.updated_at)}</dd>
              </div>
              <div>
                <dt className="text-gray-500">最后爬取</dt>
                <dd className="mt-1 text-gray-900">{formatDate(order.last_crawled_at)}</dd>
              </div>
            </dl>
          </div>

          <div className="card">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-900">
              <Mail className="h-5 w-5 text-primary" />
              Apple ID
            </h2>
            <p className="break-all text-sm text-gray-900">{order.apple_id?.apple_id || '-'}</p>
            {order.apple_id?.nickname && (
              <p className="mt-1 text-sm text-gray-500">{order.apple_id.nickname}</p>
            )}
          </div>

          <div className="card">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-900">
              <User className="h-5 w-5 text-primary" />
              取机人
            </h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-gray-500">姓名</dt>
                <dd className="mt-1 text-gray-900">{order.recipient?.name || '-'}</dd>
              </div>
              <div>
                <dt className="text-gray-500">身份证后四位</dt>
                <dd className="mt-1 font-mono text-gray-900">
                  {order.recipient?.id_card_last4 || '-'}
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">联系电话</dt>
                <dd className="mt-1 text-gray-900">{order.recipient?.phone || '-'}</dd>
              </div>
            </dl>
          </div>

          <div className="card">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-900">
              <CreditCard className="h-5 w-5 text-primary" />
              付款信息
            </h2>
            <p className="text-sm text-gray-900">{order.payment_method || '-'}</p>
            <p className="mt-2 text-sm text-gray-500">付款状态：{order.payment_status || '-'}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
