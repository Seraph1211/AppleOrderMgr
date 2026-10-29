import { formatProductStorageText } from '../utils/productStorage';
import ProductName from '../components/ProductName';
import RecipientTag from './RecipientTag';
import OrderSerialEditor from './OrderSerialEditor';
import OrderOverlay from './orderOverlay';
import OfficialOrderStatus from './OfficialOrderStatus';
import OrderAmount from './OrderAmount';
import OrderSources from './OrderSources';
import OrderPickupPhotos from './orderPickupPhotos';
import { getOrderDetailWithLink, updateOrder, updateOrderPayer } from '../api/ordersApi';
import { getDisplayOrderStatusBadge } from '../constants/orderStatus';
import { PERMISSIONS } from '../constants/permissions';
import { useAuth } from '../contexts/AuthContext';
import { formatOrderTime } from '../utils/orderTime';
import { ExternalLink, Pencil, Save, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

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

/** 展示订单邮件状态与来源数据，并支持备注及既有付款信息维护。 */
export default function OrderDetailModal({ order, isOpen, onClose, onUpdate, onEditNotes }) {
  const { can } = useAuth();
  const [formData, setFormData] = useState({ payerName: '', paymentScreenshots: [] });
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [alertInfo, setAlertInfo] = useState(null);
  const [activeSection, setActiveSection] = useState('overview');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [detailExtras, setDetailExtras] = useState({
    orderId: null,
    recipientPhone: null,
    recipientTag: null,
    recipientTagState: null,
    recipientTagSource: null,
    tagLoaded: false,
    applePassword: null,
    orderUrl: null,
    orderLinkError: null,
  });
  const [detailLoading, setDetailLoading] = useState(false);

  const formOrderIdRef = useRef(null);
  const paymentUploadRef = useRef(null);
  const orderId = order?.id;
  const payerName = order?.payerName;
  const paymentScreenshots = order?.paymentScreenshots;
  const paymentScreenshot = order?.paymentScreenshot;

  useEffect(() => {
    if (isOpen) {
      setActiveSection('overview');
      setConfirmDiscard(false);
    }
  }, [isOpen, orderId]);

  useEffect(() => {
    if (!isOpen || !orderId) {
      formOrderIdRef.current = null;
      return;
    }
    // 同一次详情打开期间，备注回显和列表轮询均不覆盖付款草稿。
    if (formOrderIdRef.current === orderId) return;
    formOrderIdRef.current = orderId;
    setFormData({
      payerName: payerName || '',
      paymentScreenshots: readScreenshots({ paymentScreenshots, paymentScreenshot }),
    });
  }, [isOpen, orderId, payerName, paymentScreenshots, paymentScreenshot]);

  useEffect(() => {
    if (!isOpen || !order?.id) return undefined;
    let active = true;
    setDetailLoading(true);
    setDetailExtras({
      orderId: order.id,
      recipientPhone: null,
      recipientTag: null,
      recipientTagState: null,
      recipientTagSource: null,
      tagLoaded: false,
      applePassword: null,
      orderUrl: null,
      orderLinkError: null,
    });
    getOrderDetailWithLink(order.id)
      .then(response => {
        if (!active) return;
        setDetailExtras({
          orderId: order.id,
          recipientPhone: response.data?.recipient_phone || null,
          recipientTag: response.data?.recipient_tag ?? null,
          recipientTagState: response.data?.recipient_tag_state,
          recipientTagSource: response.data?.recipient_tag_source,
          tagLoaded: true,
          applePassword: response.data?.apple_password || null,
          orderUrl: response.data?.order_url || null,
          orderLinkError: response.data?.order_link_error || null,
        });
      })
      .catch(error => {
        if (!active) return;
        setDetailExtras({
          orderId: order.id,
          recipientPhone: null,
          recipientTag: null,
          recipientTagState: null,
          recipientTagSource: null,
          tagLoaded: false,
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
  }, [
    isOpen,
    order?.id,
    order?.recipientTag,
    order?.recipientTagState,
    order?.recipientTagSource,
    detailAttempt,
  ]);

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

  const paymentDirty =
    formData.payerName.trim() !== (order.payerName || '') ||
    JSON.stringify(formData.paymentScreenshots) !== JSON.stringify(readScreenshots(order));
  const requestClose = () => {
    if (saving || uploading) return;
    if (paymentDirty) setConfirmDiscard(true);
    else onClose();
  };
  const sections = [
    ['overview', '订单概览'],
    ['payment', '付款信息'],
    ...(can(PERMISSIONS.PICKUPS_READ) ? [['photos', '取货照片']] : []),
    ...(can(PERMISSIONS.INGESTION_READ) ? [['sources', '来源记录']] : []),
  ];

  let footerHint = '官网状态与邮件证据分别展示';
  if (activeSection === 'payment') {
    footerHint =
      can(PERMISSIONS.ORDERS_EDIT) || can(PERMISSIONS.ORDERS_PAYER_EDIT)
        ? '尚无待保存的修改'
        : '当前为只读展示';
  }
  if (paymentDirty) footerHint = '付款信息有未保存的修改';

  return (
    <>
      <OrderOverlay
        title="订单详情"
        subtitle={`订单 ID ${order.id} · ${order.orderNumber}`}
        className="order-detail-modal"
        sectionKey={activeSection}
        size="large"
        onClose={requestClose}
        busy={saving || uploading}
        navigation={
          <nav className="order-detail-tabs" aria-label="订单详情分区">
            {sections.map(([key, label]) => (
              <button
                type="button"
                key={key}
                aria-pressed={activeSection === key}
                onClick={() => setActiveSection(key)}
              >
                {label}
              </button>
            ))}
          </nav>
        }
        footer={
          <>
            <span className="order-inline-note" role="status">
              {footerHint}
            </span>
            <button
              type="button"
              onClick={requestClose}
              disabled={saving || uploading}
              className="btn btn-secondary"
            >
              关闭
            </button>
            {activeSection === 'payment' &&
              (can(PERMISSIONS.ORDERS_EDIT) || can(PERMISSIONS.ORDERS_PAYER_EDIT)) && (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || uploading || !paymentDirty}
                  className="btn btn-primary inline-flex items-center gap-2"
                >
                  <Save className="h-4 w-4" />
                  {saving ? '保存中...' : '保存付款信息'}
                </button>
              )}
          </>
        }
      >
        {detailExtras.orderLinkError && !detailLoading && (
          <div className="order-panel-note mb-4" role="alert">
            {detailExtras.orderLinkError}{' '}
            <button
              type="button"
              className="text-primary ml-2"
              onClick={() => setDetailAttempt(value => value + 1)}
            >
              重新读取详情
            </button>
          </div>
        )}
        <div hidden={activeSection !== 'overview'}>
          <div className="order-section">
            <h3 className="mb-4 text-lg font-semibold">订单状态</h3>
            <div className="order-detail-status-grid">
              <div>
                <p className="text-sm text-gray-600">官网订单状态</p>
                <OfficialOrderStatus
                  status={order.officialOrderStatus}
                  observedAt={order.officialStatusObservedAt}
                />
              </div>
              <div>
                <p className="text-sm text-gray-600">邮件订单状态</p>
                <span className={`badge mt-1 ${statusBadge.class}`}>{statusBadge.text}</span>
              </div>
            </div>
            <div className="order-detail-evidence-row">
              <div className="order-detail-evidence-time">
                <p className="text-sm text-gray-600">邮件证据时间</p>
                <p className="text-sm">{formatOrderTime(order.emailStatusEvidenceAt)}</p>
              </div>
              <div className="order-detail-evidence-time">
                <p className="text-sm text-gray-600">邮件状态更新时间</p>
                <p className="text-sm">{formatOrderTime(order.emailLifecycleUpdatedAt)}</p>
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

          <div className="order-section">
            <div className="order-detail-section-heading">
              <h3 className="text-lg font-semibold">商品信息</h3>
            </div>
            <div className="order-detail-products overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="px-4 py-3 text-left text-sm text-gray-500">型号</th>
                    <th className="px-4 py-3 text-left text-sm text-gray-500">名称</th>
                    <th className="px-4 py-3 text-right text-sm text-gray-500">数量</th>
                  </tr>
                </thead>
                <tbody>
                  {!order.products?.length && (
                    <tr>
                      <td colSpan={3} className="text-gray-500">
                        暂无商品信息
                      </td>
                    </tr>
                  )}
                  {(order.products || []).map((product, index) => (
                    <tr
                      key={`${product.model || product.name}-${index}`}
                      className="border-t border-gray-100"
                    >
                      <td className="px-4 py-3 font-mono text-sm">
                        {formatProductStorageText(product.model || product.modelId || '-')}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <ProductName product={product} />
                      </td>
                      <td className="px-4 py-3 text-right text-sm">{product.quantity ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h3 className="mb-4 text-lg font-semibold">基本信息</h3>
            <div className="order-detail-form-grid">
              <div>
                <p className="text-sm text-gray-600">下单时间</p>
                <p className="mt-1 text-sm">{formatOrderTime(order.orderDate)}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">取机人 / 订单 TAG</p>
                <p className="mt-1 break-words text-sm">
                  {order.recipientName || '-'} /{' '}
                  {detailLoading || detailExtras.orderId !== order.id ? (
                    '加载中…'
                  ) : detailExtras.tagLoaded ? (
                    <RecipientTag
                      value={detailExtras.recipientTag}
                      state={detailExtras.recipientTagState}
                      source={detailExtras.recipientTagSource}
                      showSource
                    />
                  ) : (
                    'TAG 读取失败'
                  )}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600">AOS 原始 TAG</p>
                <p className="mt-1 break-words whitespace-pre-wrap text-sm">
                  {order.sourceRecipientTag || '—'}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600">下单手机号</p>
                <p className="mt-1 break-all font-mono text-sm">
                  {detailLoading || detailExtras.orderId !== order.id
                    ? '加载中…'
                    : detailExtras.recipientPhone || '-'}
                </p>
              </div>
              <div className="min-w-0">
                <p className="text-sm text-gray-600">下单邮箱号</p>
                <p className="mt-1 break-all text-sm">{order.recipientEmail || '-'}</p>
              </div>
              <OrderSerialEditor
                key={order.id}
                orderId={order.id}
                canEdit={can(PERMISSIONS.ORDERS_EDIT)}
                onChange={serialNumbers => onUpdate?.({ ...order, serialNumbers })}
              />
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
              </div>
            </div>
          </div>

          <section className="card" aria-labelledby="order-detail-notes-title">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 id="order-detail-notes-title" className="text-lg font-semibold">
                订单备注
              </h3>
              {can(PERMISSIONS.ORDERS_EDIT) && onEditNotes && (
                <button
                  type="button"
                  className="btn btn-secondary inline-flex shrink-0 items-center gap-2"
                  disabled={saving || uploading}
                  onClick={() => onEditNotes(order)}
                >
                  <Pencil className="h-4 w-4" />
                  修改备注
                </button>
              )}
            </div>
            <p className="whitespace-pre-wrap break-words text-sm text-gray-700">
              {order.notes || '暂无备注'}
            </p>
          </section>
        </div>
        <div hidden={activeSection !== 'payment'}>
          <div className="order-section">
            <h3 className="mb-4 text-lg font-semibold">付款信息</h3>
            <div className="space-y-4">
              <div className="order-detail-payment-grid">
                <div>
                  <p className="text-sm text-gray-600">付款方式</p>
                  <p className="mt-1 text-sm">{order.paymentMethod}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">订单金额</p>
                  <OrderAmount amount={order.orderAmount} />
                </div>
              </div>
              <label className="order-detail-payer block text-sm font-medium text-gray-700">
                付款人
                {can(PERMISSIONS.ORDERS_PAYER_EDIT) ? (
                  <input
                    className="input mt-1"
                    maxLength="100"
                    disabled={saving || uploading}
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
                {!formData.paymentScreenshots.length && (
                  <p className="order-panel-note">尚未添加付款截图。最多9张，每张不超过5MB。</p>
                )}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {formData.paymentScreenshots.map((src, index) => (
                    <div key={`${src.slice(0, 32)}-${index}`} className="relative">
                      <img
                        src={src}
                        alt={`付款截图 ${index + 1}`}
                        className="h-32 w-full rounded border border-gray-200 object-cover"
                      />
                      {can(PERMISSIONS.ORDERS_EDIT) && (
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
                          disabled={saving || uploading}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              {can(PERMISSIONS.ORDERS_EDIT) && formData.paymentScreenshots.length < 9 && (
                <div>
                  <button
                    type="button"
                    className="btn btn-secondary inline-flex items-center gap-2"
                    disabled={saving || uploading}
                    onClick={() => paymentUploadRef.current?.click()}
                  >
                    <Upload className="h-4 w-4" />
                    {uploading ? '读取中...' : '添加付款截图'}
                  </button>
                  <input
                    ref={paymentUploadRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    aria-label="上传付款截图"
                    disabled={saving || uploading}
                    onChange={handleFileUpload}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
        {can(PERMISSIONS.PICKUPS_READ) && (
          <div hidden={activeSection !== 'photos'}>
            <OrderPickupPhotos orderId={order.id} orderNumber={order.orderNumber} />
          </div>
        )}
        {can(PERMISSIONS.INGESTION_READ) && (
          <div hidden={activeSection !== 'sources'}>
            <OrderSources orderId={order.id} ordersUi />
          </div>
        )}
      </OrderOverlay>
      {alertInfo && (
        <OrderOverlay
          title={alertInfo.title}
          size="small"
          onClose={() => setAlertInfo(null)}
          footer={
            <button type="button" className="btn btn-primary" onClick={() => setAlertInfo(null)}>
              确定
            </button>
          }
        >
          <p role="status">{alertInfo.message}</p>
        </OrderOverlay>
      )}
      {confirmDiscard && (
        <OrderOverlay
          title="放弃未保存的付款修改？"
          size="small"
          onClose={() => setConfirmDiscard(false)}
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmDiscard(false)}
              >
                继续编辑
              </button>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                放弃修改并关闭
              </button>
            </>
          }
        >
          <p>当前付款人或付款截图的修改尚未保存。</p>
        </OrderOverlay>
      )}
    </>
  );
}
