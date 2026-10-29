import OrderOverlay from './orderOverlay';
import ResponsiveSelect from './responsiveSelect';
import MailForwardForm from './MailForwardForm';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, Image, RefreshCw } from 'lucide-react';
import {
  getOrderEmails,
  getOrderEmail,
  getOrderEmailForwards,
  downloadOrderEmailAttachment,
  getOrderEmailAttachmentBlob,
  replayOrderEmailLifecycle,
  reviewOrderEmailLifecycle,
} from '../api/orderMailApi';
import { formatOrderTime } from '../utils/orderTime';
import { blobToDataUrl, buildOrderMailPreviewDocument } from '../utils/orderMailPreview';

const SYNC_LABELS = {
  disabled: '订单邮件同步尚未启用，请联系管理员',
  pending: '尚未完成首次同步',
  syncing: '正在同步邮件，列表可能尚不完整',
  error: '邮件同步异常或已暂停，当前显示已保存邮件',
  ready: '邮件同步正常',
};
const DELIVERY_LABELS = {
  queued: '等待发送',
  sending: '正在发送',
  retry_wait: '等待重试',
  accepted: '已提交邮件服务器',
  failed: '发送失败',
  unknown: '结果不明，请核实收件箱后再决定是否重发',
  cancelled: '已取消（权限或内容失效）',
};
const TEMPLATE_LABELS = {
  confirmed: '订单确认',
  processing: '正在处理',
  ready_update: '可取货更新',
  ready_info: '取货信息',
  personal_setup: '个人设置辅导',
  expired: '取货安排已过期',
  cancelled: '取货安排已取消',
  excluded: '本期排除',
  return_requested: '退货申请',
  unknown: '未知模板',
};
const LIFECYCLE_STATUS_LABELS = {
  unknown: '待确认',
  confirmed: '订单已确认',
  processing: '处理中',
  ready_for_pickup: '可取货',
  picked_up: '已取货',
  partially_cancelled: '部分取消',
  partially_return_requested: '部分发起退货',
  return_requested: '已发起退货',
  expired: '已过期',
  cancelled: '已取消',
  paid: '已付款',
};
const AUTHENTICITY_LABELS = {
  verified: '订单号匹配',
  manually_verified: '人工核定',
  failed: '订单号不匹配',
  temporary_failure: '订单号核对暂时失败',
  not_checked: '等待系统订单',
};

/** 订单列表内的关联邮件抽屉；不提供独立导航或全局收件箱。 */
export default function OrderMailDrawer({ order, onClose }) {
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.ORDER_MAIL_MANAGE);
  const canForward = canManage || can(PERMISSIONS.ORDER_MAIL_FORWARD);
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [list, setList] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [downloading, setDownloading] = useState(null);
  const [replaying, setReplaying] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewReason, setReviewReason] = useState('');
  const [reviewOrderStatus, setReviewOrderStatus] = useState('unknown');
  const [reviewPaymentStatus, setReviewPaymentStatus] = useState('unknown');
  const [statusVersion, setStatusVersion] = useState(order.emailStatusVersion || 0);
  const [previewMode, setPreviewMode] = useState('text');
  const [remoteImagesEnabled, setRemoteImagesEnabled] = useState(false);
  const [inlineImages, setInlineImages] = useState({});
  const [previewWarning, setPreviewWarning] = useState('');
  const [mailSection, setMailSection] = useState('content');
  const [messageAttempt, setMessageAttempt] = useState(0);

  useEffect(() => {
    setStatusVersion(order.emailStatusVersion || 0);
  }, [order.emailStatusVersion]);

  useEffect(() => {
    if (!detail?.lifecycle) return;
    setReviewOrderStatus(detail.lifecycle.orderStatus || 'unknown');
    setReviewPaymentStatus(detail.lifecycle.paymentStatus || 'unknown');
    setReviewReason('');
  }, [detail]);

  useEffect(() => {
    setPreviewMode(detail?.html ? 'html' : 'text');
    setMailSection('content');
    setRemoteImagesEnabled(false);
    setInlineImages({});
    setPreviewWarning('');
  }, [detail?.id, detail?.html]);

  useEffect(() => {
    const indexes = detail?.inlineAttachmentIndexes || [];
    if (!detail?.html || !indexes.length) return undefined;
    let active = true;
    Promise.allSettled(
      indexes.map(async index => {
        const attachment = detail.attachments?.find(item => item.index === index);
        if (!attachment || !/^image\//i.test(attachment.contentType || ''))
          throw new Error('内嵌图片类型无效');
        const blob = await getOrderEmailAttachmentBlob(order.id, detail.id, index);
        return [String(index), await blobToDataUrl(blob, attachment.contentType)];
      })
    ).then(results => {
      if (!active) return;
      const loaded = {};
      let failed = 0;
      for (const result of results) {
        if (result.status === 'fulfilled') loaded[result.value[0]] = result.value[1];
        else failed += 1;
      }
      setInlineImages(loaded);
      if (failed) setPreviewWarning('部分内嵌图片加载失败，正文和附件仍可继续查看。');
    });
    return () => {
      active = false;
    };
  }, [detail, order.id]);

  const previewDocument = useMemo(
    () =>
      buildOrderMailPreviewDocument(detail?.html, {
        allowRemoteImages: remoteImagesEnabled,
        inlineImages,
      }),
    [detail?.html, inlineImages, remoteImagesEnabled]
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setList(null);
    getOrderEmails(order.id, page)
      .then(response => {
        if (active) setList(response.data);
      })
      .catch(failure => {
        if (active) setError(failure.message || '加载邮件失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [order.id, page, reload]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !selectedId) setReload(value => value + 1);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setHistory([]);
    setNotice('');
    setError('');
    if (!selectedId)
      return () => {
        active = false;
      };
    setLoading(true);
    Promise.allSettled([
      getOrderEmail(order.id, selectedId),
      getOrderEmailForwards(order.id, selectedId),
    ])
      .then(([message, forwards]) => {
        if (active) {
          if (message.status === 'fulfilled') setDetail(message.value.data);
          else setError(message.reason.message || '邮件正文暂不可用');
          if (forwards.status === 'fulfilled') setHistory(forwards.value.data);
          else setError(forwards.reason.message || '转发记录暂不可用');
        }
      })
      .catch(failure => {
        if (active) setError(failure.message || '加载邮件失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [order.id, selectedId, messageAttempt]);

  const hasPending = history.some(item =>
    ['queued', 'sending', 'retry_wait'].includes(item.status)
  );
  useEffect(() => {
    if (!selectedId || !hasPending) return undefined;
    let active = true;
    let busy = false;
    const timer = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await getOrderEmailForwards(order.id, selectedId);
        if (active) setHistory(response.data);
      } catch (failure) {
        if (active) {
          setError(failure.message);
          setDetail(null);
        }
      } finally {
        busy = false;
      }
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [order.id, selectedId, hasPending]);

  async function download(attachment) {
    setDownloading(attachment.index);
    setError('');
    try {
      await downloadOrderEmailAttachment(order.id, selectedId, attachment);
    } catch (failure) {
      setError(failure.message || '附件下载失败');
    } finally {
      setDownloading(null);
    }
  }

  async function replayLifecycle() {
    if (!canManage) return;
    setReplaying(true);
    setError('');
    setNotice('');
    try {
      await replayOrderEmailLifecycle(order.id, selectedId);
      setNotice('已提交重新解析；应用结果仍受服务端受控开关约束。');
      setReload(value => value + 1);
    } catch (failure) {
      setError(failure.message || '重新解析提交失败');
    } finally {
      setReplaying(false);
    }
  }

  async function reviewLifecycle(event) {
    event.preventDefault();
    if (!canManage) return;
    setReviewing(true);
    setError('');
    setNotice('');
    try {
      const response = await reviewOrderEmailLifecycle(order.id, selectedId, {
        expectedVersion: statusVersion,
        reason: reviewReason.trim(),
        orderStatus: reviewOrderStatus,
        paymentStatus: reviewPaymentStatus,
      });
      setStatusVersion(response.data.version);
      const refreshed = await getOrderEmail(order.id, selectedId);
      setDetail(refreshed.data);
      setNotice('人工核定已追加；订单与付款任务是否应用仍受服务端开关约束。');
    } catch (failure) {
      setError(failure.message || '人工核定失败，请刷新后重试');
    } finally {
      setReviewing(false);
    }
  }

  return (
    <OrderOverlay
      title="订单邮件"
      subtitle={`${order.orderNumber} · 订单 ID ${order.id}`}
      size={selectedId ? 'mail' : 'mail-list'}
      sectionKey={`${selectedId}-${mailSection}`}
      className="order-mail-dialog"
      onClose={onClose}
      busy={sending}
      navigation={
        selectedId && (
          <div className="order-mail-navigation">
            <button
              type="button"
              className="btn btn-secondary inline-flex items-center gap-1"
              disabled={sending}
              onClick={() => setSelectedId(null)}
            >
              <ArrowLeft className="h-4 w-4" />
              返回邮件列表
            </button>
            <nav className="order-detail-tabs" aria-label="邮件内容分区">
              <button
                type="button"
                aria-pressed={mailSection === 'content'}
                onClick={() => setMailSection('content')}
              >
                邮件正文
              </button>
              {(canForward || history.length > 0) && (
                <button
                  type="button"
                  aria-pressed={mailSection === 'forward'}
                  onClick={() => setMailSection('forward')}
                >
                  转发与记录
                </button>
              )}
              {detail?.lifecycle && (
                <button
                  type="button"
                  aria-pressed={mailSection === 'lifecycle'}
                  onClick={() => setMailSection('lifecycle')}
                >
                  解析与核定
                </button>
              )}
            </nav>
          </div>
        )
      }
      footer={
        <>
          <span className="order-inline-note">
            {selectedId
              ? '保留原始邮件排版、附件与来源证据'
              : `关联邮件 ${list?.total ?? '—'} 封 · 仅限当前订单`}
          </span>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={sending}>
            关闭
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <p role="alert" className="bg-red-50 text-red-700 rounded-lg p-3">
            {error}
            <button
              type="button"
              className="btn btn-secondary ml-3"
              disabled={loading}
              onClick={() => {
                if (selectedId) {
                  setMessageAttempt(value => value + 1);
                } else setReload(value => value + 1);
              }}
            >
              重新加载
            </button>
          </p>
        )}
        {notice && (
          <p role="status" className="bg-blue-50 text-primary rounded-lg p-3">
            {notice}
          </p>
        )}
        {selectedId ? (
          <>
            {loading && (
              <p className="text-gray-500" role="status">
                正在加载邮件…
              </p>
            )}
            {detail && (
              <>
                <div className="order-mail-message space-y-3 break-words">
                  <h3 className="font-semibold text-gray-900">{detail.subject || '无主题'}</h3>
                  <div className="order-mail-message-meta">
                    <p className="text-sm text-gray-600">发件人：{detail.from || '-'}</p>
                    <p className="text-sm text-gray-600">原始收件人：{detail.to || '-'}</p>
                    <p className="text-sm text-gray-600">
                      邮件发信：{formatOrderTime(detail.date)}
                    </p>
                    <p className="text-sm text-gray-600">
                      实际收信：{formatOrderTime(detail.receivedAt)}
                    </p>
                  </div>
                  {detail.lifecycle && (
                    <div className="order-mail-lifecycle" hidden={mailSection !== 'lifecycle'}>
                      <p className="font-medium text-gray-900">
                        {TEMPLATE_LABELS[detail.lifecycle.templateType] || '未知模板'}
                      </p>
                      <p className="mt-1 text-gray-700">
                        订单：
                        {LIFECYCLE_STATUS_LABELS[detail.lifecycle.orderStatus] || '不更新'} · 付款：
                        {LIFECYCLE_STATUS_LABELS[detail.lifecycle.paymentStatus] || '不更新'}
                      </p>
                      <p className="mt-1 text-gray-700">
                        来源：
                        {AUTHENTICITY_LABELS[detail.lifecycle.authenticityStatus] || '待核对'}
                      </p>
                      {detail.lifecycle.pickupInfo && (
                        <div className="mt-2 text-gray-700">
                          <p>
                            取货门店：
                            {detail.lifecycle.pickupInfo.storeName || '-'}
                          </p>
                          <p>
                            取货安排：
                            {detail.lifecycle.pickupInfo.appointmentMode === 'business_hours'
                              ? '营业时间内到店'
                              : [
                                  detail.lifecycle.pickupInfo.pickupDate,
                                  detail.lifecycle.pickupInfo.startTime &&
                                  detail.lifecycle.pickupInfo.endTime
                                    ? `${detail.lifecycle.pickupInfo.startTime}–${detail.lifecycle.pickupInfo.endTime}`
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(' ') || '-'}
                          </p>
                        </div>
                      )}
                      <p className="mt-1 text-xs text-gray-500">
                        {detail.lifecycle.appliedAt
                          ? `已应用于 ${formatOrderTime(detail.lifecycle.appliedAt)}`
                          : `已解析于 ${formatOrderTime(detail.lifecycle.parsedAt)}`}
                      </p>
                      {detail.lifecycle.needsReview && (
                        <p className="mt-1 text-amber-700">
                          该结论需要人工核对
                          {!!detail.lifecycle.reviewReasons?.length && (
                            <span className="block text-xs break-all">
                              {detail.lifecycle.reviewReasons.join('、')}
                            </span>
                          )}
                        </p>
                      )}
                      {canManage && (
                        <>
                          <button
                            type="button"
                            className="btn btn-secondary mt-3 inline-flex items-center gap-1"
                            disabled={replaying}
                            onClick={replayLifecycle}
                          >
                            <RefreshCw className={`w-4 h-4 ${replaying ? 'animate-spin' : ''}`} />
                            {replaying ? '提交中…' : '重新解析'}
                          </button>
                          <form
                            className="mt-3 space-y-2 border-t border-blue-100 pt-3"
                            onSubmit={reviewLifecycle}
                          >
                            <p className="font-medium text-gray-900">人工核定当前邮件</p>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                              <label className="text-gray-700">
                                订单状态
                                <ResponsiveSelect
                                  className="input mt-1 w-full"
                                  value={reviewOrderStatus}
                                  disabled={reviewing}
                                  onChange={event => setReviewOrderStatus(event.target.value)}
                                >
                                  <option value="unknown">待确认</option>
                                  <option value="confirmed">订单已确认</option>
                                  <option value="processing">处理中</option>
                                  <option value="ready_for_pickup">可取货</option>
                                  <option value="picked_up">已取货</option>
                                  <option value="partially_cancelled">部分取消</option>
                                  <option value="partially_return_requested">部分发起退货</option>
                                  <option value="return_requested">已发起退货</option>
                                  <option value="expired">已过期</option>
                                  <option value="cancelled">已取消</option>
                                </ResponsiveSelect>
                              </label>
                              <label className="text-gray-700">
                                付款状态
                                <ResponsiveSelect
                                  className="input mt-1 w-full"
                                  value={reviewPaymentStatus}
                                  disabled={reviewing}
                                  onChange={event => setReviewPaymentStatus(event.target.value)}
                                >
                                  <option value="unknown">待确认</option>
                                  <option value="paid">已付款</option>
                                </ResponsiveSelect>
                              </label>
                            </div>
                            <label className="block text-gray-700">
                              核定依据
                              <textarea
                                className="input mt-1 w-full"
                                rows={2}
                                minLength={5}
                                maxLength={500}
                                required
                                value={reviewReason}
                                disabled={reviewing}
                                placeholder="填写关联官方邮件中的核定依据"
                                onChange={event => setReviewReason(event.target.value)}
                              />
                            </label>
                            <button
                              type="submit"
                              className="btn btn-secondary"
                              disabled={reviewing || reviewReason.trim().length < 5}
                            >
                              {reviewing ? '保存中…' : '保存核定'}
                            </button>
                          </form>
                        </>
                      )}
                    </div>
                  )}
                  <div
                    className="order-mail-reader order-mail-section space-y-3"
                    hidden={mailSection !== 'content'}
                  >
                    {detail.html && (
                      <div className="order-mail-preview-toolbar">
                        <div
                          className="inline-flex rounded-lg border border-gray-300 bg-gray-50 p-1"
                          role="group"
                          aria-label="邮件正文显示方式"
                        >
                          <button
                            type="button"
                            className={
                              'rounded-md px-3 py-1.5 text-sm transition-colors ' +
                              (previewMode === 'html'
                                ? 'bg-white text-primary'
                                : 'text-gray-600 hover:text-gray-900')
                            }
                            aria-pressed={previewMode === 'html'}
                            onClick={() => setPreviewMode('html')}
                          >
                            原始排版
                          </button>
                          <button
                            type="button"
                            className={
                              'rounded-md px-3 py-1.5 text-sm transition-colors ' +
                              (previewMode === 'text'
                                ? 'bg-white text-primary'
                                : 'text-gray-600 hover:text-gray-900')
                            }
                            aria-pressed={previewMode === 'text'}
                            onClick={() => setPreviewMode('text')}
                          >
                            纯文本
                          </button>
                        </div>
                        {previewMode === 'html' && detail.remoteImageCount > 0 && (
                          <button
                            type="button"
                            className="btn btn-secondary inline-flex items-center gap-1"
                            disabled={remoteImagesEnabled}
                            onClick={() => setRemoteImagesEnabled(true)}
                          >
                            <Image className="w-4 h-4" />
                            {remoteImagesEnabled
                              ? '已加载远程图片'
                              : `加载远程图片（${detail.remoteImageCount}）`}
                          </button>
                        )}
                      </div>
                    )}
                    {previewWarning && (
                      <p
                        className="rounded-lg bg-amber-50 p-3 text-sm text-amber-700"
                        role="status"
                      >
                        {previewWarning}
                      </p>
                    )}
                    {previewMode === 'html' && previewDocument ? (
                      <iframe
                        className="h-[65vh] min-h-96 w-full rounded-lg border border-gray-200 bg-white"
                        title="邮件原始排版预览"
                        sandbox="allow-popups allow-popups-to-escape-sandbox"
                        referrerPolicy="no-referrer"
                        srcDoc={previewDocument}
                      />
                    ) : (
                      <div className="order-mail-text whitespace-pre-wrap break-words text-gray-900">
                        {detail.text || '此邮件没有可预览的文字正文，可查看附件。'}
                      </div>
                    )}
                  </div>
                </div>
                {!!detail.attachments?.length && (
                  <div className="order-mail-section space-y-2" hidden={mailSection !== 'content'}>
                    <h3 className="font-medium text-gray-900">附件</h3>
                    {detail.attachments.map(attachment => (
                      <button
                        key={attachment.index}
                        className="btn btn-secondary flex items-center gap-2 max-w-full"
                        disabled={downloading !== null}
                        onClick={() => download(attachment)}
                      >
                        <Download className="w-4 h-4 shrink-0" />
                        <span className="truncate">{attachment.name}</span>
                        <span className="text-xs text-gray-500">
                          {Math.ceil(attachment.size / 1024)} KB
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {canForward && (
                  <div hidden={mailSection !== 'forward'}>
                    <MailForwardForm
                      key={order.id + ':' + selectedId}
                      orderId={order.id}
                      messageId={selectedId}
                      onSendingChange={setSending}
                      onQueued={items => {
                        setHistory(previous => [
                          ...items,
                          ...previous.filter(item => !items.some(queued => queued.id === item.id)),
                        ]);
                        setNotice(
                          '已提交 ' + items.length + ' 个转发任务，可在下方分别查看发送结果。'
                        );
                      }}
                    />
                  </div>
                )}
              </>
            )}
            {!!history.length && (
              <div hidden={mailSection !== 'forward'} className="order-mail-section">
                <h3 className="font-medium text-gray-900 mb-2">转发记录（最近50条）</h3>
                <div className="order-mail-list overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="p-2">目标邮箱</th>
                        <th className="p-2">操作人ID</th>
                        <th className="p-2">时间</th>
                        <th className="p-2">结果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map(item => (
                        <tr key={item.id} className="border-t">
                          <td className="p-2 break-all">{item.recipient}</td>
                          <td className="p-2">{item.actorUserId}</td>
                          <td className="p-2 whitespace-nowrap">
                            {formatOrderTime(item.createdAt)}
                          </td>
                          <td className="p-2">
                            {DELIVERY_LABELS[item.status] || item.status}
                            {item.errorCode && (
                              <span className="block text-xs text-gray-500">{item.errorCode}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-wrap justify-between items-center gap-2">
              <p className="text-sm text-gray-600">
                {list ? SYNC_LABELS[list.sync?.status] : '正在读取同步状态'}
                {list?.sync?.lastSucceededAt && (
                  <span className="block text-xs text-gray-500">
                    最近同步：{formatOrderTime(list.sync.lastSucceededAt)}
                  </span>
                )}
              </p>
              <button
                className="btn btn-secondary inline-flex items-center gap-1"
                disabled={loading}
                onClick={() => setReload(value => value + 1)}
              >
                <RefreshCw className={'w-4 h-4 ' + (loading ? 'animate-spin' : '')} />
                刷新列表
              </button>
            </div>
            {loading ? (
              <p role="status" className="text-gray-500 py-10 text-center">
                正在加载关联邮件…
              </p>
            ) : list && !list.items.length ? (
              <div className="py-10 text-center text-gray-500">
                <p>暂未找到此订单的关联邮件</p>
                <p className="text-xs mt-2">
                  仅展示通过来源筛选且明确匹配订单号的邮件；同步尚未完成时请稍后刷新。
                </p>
              </div>
            ) : (
              list && (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="p-3">主题 / 原始收件人</th>
                        <th className="p-3">时间</th>
                        <th className="p-3">识别 / 应用结果</th>
                        <th className="p-3">附件</th>
                        <th className="p-3">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.items.map(item => (
                        <tr key={item.id} className="border-t hover:bg-gray-50">
                          <td className="p-3 min-w-40 break-words">
                            {item.subject || '邮件内容已过期'}
                            <span className="block text-xs text-gray-500 break-all">{item.to}</span>
                            <span className="block text-xs text-gray-500 break-all">
                              {item.from}
                            </span>
                          </td>
                          <td className="p-3 whitespace-nowrap">
                            <span className="block">发信 {formatOrderTime(item.date)}</span>
                            <span className="block text-xs text-gray-500">
                              收信 {formatOrderTime(item.receivedAt)}
                            </span>
                          </td>
                          <td className="p-3 min-w-40">
                            {item.lifecycle ? (
                              <div>
                                <p>{TEMPLATE_LABELS[item.lifecycle.templateType] || '未知模板'}</p>
                                <p className="text-xs text-gray-500">
                                  {item.lifecycle.needsReview
                                    ? '待核对'
                                    : item.lifecycle.appliedAt
                                      ? '已应用'
                                      : '已解析'}
                                </p>
                              </div>
                            ) : (
                              <span className="text-gray-400">等待解析</span>
                            )}
                          </td>
                          <td className="p-3" data-mail-attachments>
                            附件 {item.attachments?.length || 0}
                          </td>
                          <td className="p-3">
                            <button
                              className="btn btn-secondary whitespace-nowrap"
                              onClick={() => setSelectedId(item.id)}
                            >
                              {item.expired ? '查看记录' : '查看邮件'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
            {list && list.total > 20 && (
              <div className="flex items-center justify-end gap-3">
                <button
                  className="btn btn-secondary"
                  disabled={page === 1 || loading}
                  onClick={() => setPage(value => value - 1)}
                >
                  上一页
                </button>
                <span className="text-sm text-gray-600">
                  第 {page} 页 · 共 {list.total} 封
                </span>
                <button
                  className="btn btn-secondary"
                  disabled={page * 20 >= list.total || loading}
                  onClick={() => setPage(value => value + 1)}
                >
                  下一页
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </OrderOverlay>
  );
}
