import AlertModal from './AlertModal';
import OrderAmount from './OrderAmount';
import OrderSources from './OrderSources';
import OrderPickupPhotos from './orderPickupPhotos';
import { getOrderDetailWithLink, updateOrder, updateOrderPayer } from '../api/ordersApi';
import { getDisplayOrderStatusBadge } from '../constants/orderStatus';
import { PERMISSIONS } from '../constants/permissions';
import { useAuth } from '../contexts/AuthContext';
import { formatOrderTime } from '../utils/orderTime';
import { ExternalLink, Save, Upload, X } from 'lucide-react';
import { useEffect, useState } from 'react';

function readScreenshots(order) {
  const value = order.paymentScreenshots || order.paymentScreenshot;
  if (Array.isArray(value)) return value.filter(Boolean);
  return typeof value === 'string' && value !== '-' ? [value] : [];
}

function formatPickup(pickup) {
  if (!pickup) return '尚无邮件取货信息';
  if (pickup.appointmentMode === 'business_hours') return '营业时间内到店';
  const range = [pickup.startTime, pickup.endTime].filter(Boolean).join('–');
  return [pickup.pickupDate, range].filter(Boolean).join(' ') || '时间待确认';
}

/** 展示订单邮件状态与来源数据，并支持既有付款信息维护。 */
export default function OrderDetailModal({ order, isOpen, onClose, onUpdate }) {
  const { can } = useAuth();
  const [formData, setFormData] = useState({ payerName: '', paymentScreenshots: [] });
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [alertInfo, setAlertInfo] = useState(null);
  const [detailExtras, setDetailExtras] = useState({
    applePassword: null,
    orderUrl: null,
    orderLinkError: null,
  });
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!order) return;
    setFormData({
      payerName: order.payerName || '',
      paymentScreenshots: readScreenshots(order),
    });
  }, [order]);

  useEffect(() => {
    if (!isOpen || !order?.id) return undefined;
    let active = true;
    setDetailLoading(true);
    setDetailExtras({ applePassword: null, orderUrl: null, orderLinkError: null });
    getOrderDetailWithLink(order.id)
      .then(response => {
        if (!active) return;
        setDetailExtras({
          applePassword: response.data?.apple_password || null,
          orderUrl: response.data?.order_url || null,
          orderLinkError: response.data?.order_link_error || null,
        });
      })
      .catch(error => {
        if (!active) return;
        setDetailExtras({
          applePassword: null,
          orderUrl: null,
          orderLinkError: error.message || '订单详情加载失败',
        });
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isOpen, order?.id]);

  if (!isOpen || !order) return null;

  const handleFileUpload = async event => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    const remaining = 9 - formData.paymentScreenshots.length;
    if (files.length > remaining) {
      setAlertInfo({ title: '上传数量超限', message: `最多可再上传 ${remaining} 张图片` });
      return;
    }
    if (files.some(file => !file.type.startsWith('image/') || file.size > 5 * 1024 * 1024)) {
      setAlertInfo({ title: '图片不符合要求', message: '请上传 5MB 以内的图片文件' });
      return;
    }
    setUploading(true);
    try {
      const images = await Promise.all(
        files.map(
          file =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = loadEvent => resolve(loadEvent.target.result);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            })
        )
      );
      setFormData(previous => ({
        ...previous,
        paymentScreenshots: [...previous.paymentScreenshots, ...images],
      }));
    } catch (_error) {
      setAlertInfo({ title: '上传失败', message: '图片读取失败，请重试' });
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (can(PERMISSIONS.ORDERS_EDIT)) {
        await updateOrder(order.id, { paymentScreenshot: formData.paymentScreenshots });
      }
      let payerVersion = order.payerVersion || 0;
      const payerName = formData.payerName.trim();
      if (can(PERMISSIONS.ORDERS_PAYER_EDIT) && payerName !== (order.payerName || '')) {
        const response = await updateOrderPayer(
          order.id,
          { payerName: payerName || null, expectedVersion: payerVersion },
          crypto.randomUUID()
        );
        payerVersion = response.data.payerVersion;
      }
      onUpdate?.({
        ...order,
        paymentScreenshot: formData.paymentScreenshots,
        paymentScreenshots: formData.paymentScreenshots,
        payerName: payerName || null,
        payerVersion,
      });
      setAlertInfo({ title: '保存成功', message: '付款信息已保存' });
    } catch (error) {
      setAlertInfo({ title: '保存失败', message: error.message || '请重试' });
    } finally {
      setSaving(false);
    }
  };

  const statusBadge = getDisplayOrderStatusBadge(order.displayOrderStatus);

  return (
    <div className="order-detail-modal fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-0 sm:p-4">
      <div className="flex h-[100dvh] w-full max-w-4xl flex-col overflow-hidden bg-white shadow-xl sm:h-auto sm:max-h-[90vh] sm:rounded-lg">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 sm:p-6">
          <div>
            <h2 className="text-2xl font-bold">订单详情</h2>
            <p className="mt-1 font-mono text-gray-600">{order.orderNumber}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭订单详情"
            className="text-gray-400 hover:text-gray-600"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 sm:p-6">
          <OrderSources orderId={order.id} />
          <div className="card border-blue-100 bg-blue-50/40">
            <h3 className="mb-4 text-lg font-semibold">订单状态</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <p className="text-sm text-gray-600">订单状态</p>
                <span className={`badge mt-1 ${statusBadge.class}`}>{statusBadge.text}</span>
              </div>
              <div>
                <p className="text-sm text-gray-600">邮件证据时间</p>
                <p className="mt-1 text-sm">{formatOrderTime(order.emailStatusEvidenceAt)}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">邮件状态更新时间</p>
                <p className="mt-1 text-sm">{formatOrderTime(order.emailLifecycleUpdatedAt)}</p>
              </div>
            </div>
            {order.emailStatusNeedsReview && (
              <p className="mt-3 text-sm text-amber-700">
                邮件结论待核对
                {order.emailStatusReviewReasons?.length
                  ? `：${order.emailStatusReviewReasons.join('、')}`
                  : ''}
              </p>
            )}
            {order.paymentAssignmentHoldReason && (
              <p className="mt-3 text-sm text-amber-700">历史付款限制：禁止重新分配付款任务</p>
            )}
            <div className="mt-4 border-t border-blue-100 pt-4 text-sm">
              <p className="font-medium">{order.emailPickupInfo?.storeName || '门店待确认'}</p>
              <p>{order.emailPickupInfo?.storeAddress || ''}</p>
              <p className="mt-1">{formatPickup(order.emailPickupInfo)}</p>
            </div>
          </div>

          <div className="card">
            <h3 className="mb-4 text-lg font-semibold">基本信息</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <p className="text-sm text-gray-600">下单时间</p>
                <p className="mt-1 text-sm">{formatOrderTime(order.orderDate)}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">取机人 / TAG</p>
                <p className="mt-1 break-words text-sm">
                  {order.recipientName || '-'} / {order.recipientTag || '-'}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600">下单手机号</p>
                <p className="mt-1 break-all font-mono text-sm">{order.recipientPhone || '-'}</p>
              </div>
              <div className="min-w-0">
                <p className="text-sm text-gray-600">下单邮箱号</p>
                <p className="mt-1 break-all text-sm">{order.recipientEmail || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Serial No.</p>
                {order.serialNumbers?.length ? (
                  order.serialNumbers.map(serial => (
                    <p key={serial} className="mt-1 break-all font-mono text-sm">
                      {serial}
                    </p>
                  ))
                ) : (
                  <p className="mt-1 text-sm">-</p>
                )}
              </div>
              <div>
                <p className="text-sm text-gray-600">Apple ID</p>
                <p className="mt-1 break-all text-sm">{order.appleId}</p>
                <p className="mt-3 text-sm text-gray-600">密码</p>
                <p className="mt-1 break-all font-mono text-sm">
                  {detailLoading ? '加载中...' : detailExtras.applePassword || '-'}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600">订单来源</p>
                <p className="mt-1 text-sm">
                  {order.ingestionSource === 'aos'
                    ? 'AOS 文件'
                    : order.ingestionSource === 'email'
                      ? '邮件'
                      : '未知'}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600">订单链接</p>
                {detailExtras.orderUrl ? (
                  <a
                    href={detailExtras.orderUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex max-w-full items-start gap-1 break-all text-sm text-primary hover:underline"
                  >
                    <span>{detailExtras.orderUrl}</span>
                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
                  </a>
                ) : (
                  <p className="mt-1 text-sm text-gray-400">{detailLoading ? '加载中...' : '-'}</p>
                )}
                {!detailLoading && detailExtras.orderLinkError && (
                  <p className="mt-1 text-xs text-amber-700">{detailExtras.orderLinkError}</p>
                )}
              </div>
            </div>
          </div>

          <OrderPickupPhotos orderId={order.id} orderNumber={order.orderNumber} />

          <div className="card overflow-hidden p-0">
            <div className="border-b border-gray-200 px-5 py-4">
              <h3 className="text-lg font-semibold">商品信息</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="px-4 py-3 text-left text-sm text-gray-500">型号</th>
                    <th className="px-4 py-3 text-left text-sm text-gray-500">名称</th>
                    <th className="px-4 py-3 text-right text-sm text-gray-500">数量</th>
                  </tr>
                </thead>
                <tbody>
                  {(order.products || []).map((product, index) => (
                    <tr
                      key={`${product.model || product.name}-${index}`}
                      className="border-t border-gray-100"
                    >
                      <td className="px-4 py-3 font-mono text-sm">
                        {product.model || product.modelId || '-'}
                      </td>
                      <td className="px-4 py-3 text-sm">{product.name || '-'}</td>
                      <td className="px-4 py-3 text-right text-sm">{product.quantity ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card border-2 border-blue-200 bg-blue-50">
            <h3 className="mb-4 text-lg font-semibold">付款信息</h3>
            <div className="space-y-4">
              <div>
                <p className="text-sm text-gray-600">付款方式</p>
                <p className="mt-1 text-sm">{order.paymentMethod}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">订单金额</p>
                <OrderAmount amount={order.orderAmount} />
              </div>
              <label className="block text-sm font-medium text-gray-700">
                付款人
                {can(PERMISSIONS.ORDERS_PAYER_EDIT) ? (
                  <input
                    className="input mt-1"
                    maxLength="100"
                    value={formData.payerName}
                    onChange={event =>
                      setFormData(previous => ({ ...previous, payerName: event.target.value }))
                    }
                  />
                ) : (
                  <p className="mt-1 font-normal">{order.payerName || '-'}</p>
                )}
              </label>
              <div>
                <p className="mb-2 text-sm font-medium text-gray-700">
                  付款截图 ({formData.paymentScreenshots.length}/9)
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {formData.paymentScreenshots.map((src, index) => (
                    <div key={`${src.slice(0, 32)}-${index}`} className="relative">
                      <img
                        src={src}
                        alt={`付款截图 ${index + 1}`}
                        className="h-32 w-full rounded border border-gray-200 object-cover"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setFormData(previous => ({
                            ...previous,
                            paymentScreenshots: previous.paymentScreenshots.filter(
                              (_, itemIndex) => itemIndex !== index
                            ),
                          }))
                        }
                        className="absolute right-1 top-1 rounded bg-white/90 p-1 text-red-600"
                        aria-label={`删除付款截图 ${index + 1}`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              {can(PERMISSIONS.ORDERS_EDIT) && formData.paymentScreenshots.length < 9 && (
                <label className="btn btn-secondary inline-flex cursor-pointer items-center gap-2">
                  <Upload className="h-4 w-4" />
                  {uploading ? '读取中...' : '添加付款截图'}
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    disabled={uploading}
                    onChange={handleFileUpload}
                  />
                </label>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-gray-200 p-4 sm:p-6">
          <button onClick={onClose} className="btn btn-secondary">
            关闭
          </button>
          {(can(PERMISSIONS.ORDERS_EDIT) || can(PERMISSIONS.ORDERS_PAYER_EDIT)) && (
            <button
              onClick={handleSave}
              disabled={saving || uploading}
              className="btn btn-primary inline-flex items-center gap-2"
            >
              <Save className="h-4 w-4" />
              {saving ? '保存中...' : '保存付款信息'}
            </button>
          )}
        </div>
      </div>
      {alertInfo && (
        <AlertModal
          title={alertInfo.title}
          message={alertInfo.message}
          onClose={() => setAlertInfo(null)}
        />
      )}
    </div>
  );
}
