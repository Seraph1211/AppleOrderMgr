import OrderAmount from '../components/OrderAmount';
import OrderSources from '../components/OrderSources';
import { getOrderDetailWithLink } from '../api';
import { getDisplayOrderStatusBadge } from '../constants/orderStatus';
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, CreditCard, ExternalLink, Mail, User } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN');
}

function formatPickup(pickup) {
  if (!pickup) return '尚无邮件取货信息';
  if (pickup.appointmentMode === 'business_hours') return '营业时间内到店';
  const range = [pickup.startTime, pickup.endTime].filter(Boolean).join('–');
  return [pickup.pickupDate, range].filter(Boolean).join(' ') || '时间待确认';
}

export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadOrderDetail = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getOrderDetailWithLink(id);
      if (!response?.success || !response.data) throw new Error('订单详情响应格式异常');
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

  const statusBadge = getDisplayOrderStatusBadge(order.display_order_status);
  const products = Array.isArray(order.products) ? order.products : [];
  const reviewReasons = Array.isArray(order.email_status_review_reasons)
    ? order.email_status_review_reasons
    : [];

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
        <div className="flex items-center gap-2">
          {can(PERMISSIONS.PICKUPS_READ) && (
            <button
              className="btn btn-secondary"
              onClick={() => navigate(`/pickups?search=${order.id}`)}
            >
              查看取货记录
            </button>
          )}
          <span className={`badge ${statusBadge.class}`}>{statusBadge.text}</span>
        </div>
      </div>

      <div className="card border-blue-100 bg-blue-50/40">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">订单状态</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <p className="text-sm text-gray-500">订单状态</p>
            <p className="mt-1 font-medium text-gray-900">{statusBadge.text}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500">付款状态</p>
            <p className="mt-1 font-medium text-gray-900">
              {order.email_payment_status === 'paid' ? '已付款' : '待确认'}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500">邮件证据时间</p>
            <p className="mt-1 text-gray-900">{formatDate(order.email_status_evidence_at)}</p>
          </div>
        </div>
        {order.email_status_needs_review && (
          <p className="mt-3 text-sm text-amber-700">
            邮件结论待核对{reviewReasons.length ? `：${reviewReasons.join('、')}` : ''}
          </p>
        )}
        {order.payment_assignment_hold_reason && (
          <p className="mt-3 text-sm text-amber-700">历史付款限制：禁止重新分配付款任务</p>
        )}
        <div className="mt-4 border-t border-blue-100 pt-4 text-sm text-gray-700">
          <p className="font-medium text-gray-900">
            {order.email_pickup_info?.storeName || '门店待确认'}
          </p>
          <p>{order.email_pickup_info?.storeAddress || ''}</p>
          <p className="mt-1">{formatPickup(order.email_pickup_info)}</p>
        </div>
      </div>

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
                  {products.length ? (
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
              <span className="text-sm font-medium text-gray-600">订单金额</span>
              <OrderAmount amount={order.order_amount} />
            </div>
          </div>
          <div className="card">
            <h2 className="mb-4 text-lg font-semibold text-gray-900">来源与时间</h2>
            <OrderSources orderId={order.id} />
            <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-gray-500">下单时间</dt>
                <dd>{formatDate(order.order_date)}</dd>
              </div>
              <div>
                <dt className="text-gray-500">邮件状态更新时间</dt>
                <dd>{formatDate(order.email_lifecycle_updated_at)}</dd>
              </div>
              <div>
                <dt className="text-gray-500">创建时间</dt>
                <dd>{formatDate(order.created_at)}</dd>
              </div>
              <div>
                <dt className="text-gray-500">更新时间</dt>
                <dd>{formatDate(order.updated_at)}</dd>
              </div>
            </dl>
          </div>
        </div>
        <div className="space-y-6">
          <div className="card">
            <h2 className="mb-4 text-lg font-semibold text-gray-900">订单信息</h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-gray-500">订单号</dt>
                <dd className="font-mono">{order.order_number}</dd>
              </div>
              <div>
                <dt className="text-gray-500">创建来源</dt>
                <dd>
                  {order.ingestion_source === 'aos'
                    ? 'AOS 文件'
                    : order.ingestion_source === 'email'
                      ? '邮件'
                      : '未知'}
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">来源 TAG</dt>
                <dd>{order.source_recipient_tag || '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-500">订单链接</dt>
                {order.order_url ? (
                  <dd>
                    <a
                      href={order.order_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex max-w-full items-start gap-1 break-all text-primary hover:underline"
                    >
                      <span>{order.order_url}</span>
                      <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
                    </a>
                  </dd>
                ) : (
                  <dd className="text-gray-400">-</dd>
                )}
                {order.order_link_error && (
                  <dd className="mt-1 text-xs text-amber-700">{order.order_link_error}</dd>
                )}
              </div>
            </dl>
          </div>
          <div className="card">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-900">
              <Mail className="h-5 w-5 text-primary" />
              Apple ID
            </h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-gray-500">账号</dt>
                <dd className="break-all text-gray-900">{order.apple_id?.apple_id || '-'}</dd>
              </div>
              <div>
                <dt className="text-gray-500">密码</dt>
                <dd className="break-all font-mono text-gray-900">{order.apple_password || '-'}</dd>
              </div>
            </dl>
          </div>
          <div className="card">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-900">
              <User className="h-5 w-5 text-primary" />
              取机人
            </h2>
            <p className="text-sm text-gray-900">{order.recipient?.name || '-'}</p>
            <p className="mt-1 text-sm text-gray-500">{order.recipient_phone || '-'}</p>
            <p className="mt-1 break-all text-sm text-gray-500">{order.recipient_email || '-'}</p>
          </div>
          <div className="card">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-900">
              <CreditCard className="h-5 w-5 text-primary" />
              付款信息
            </h2>
            <p className="text-sm text-gray-900">{order.payment_method || '-'}</p>
            <p className="mt-2 text-sm text-gray-500">付款人：{order.payer_name || '-'}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
