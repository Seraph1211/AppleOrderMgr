import MailForwardForm from './MailForwardForm';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Mail, RefreshCw, X } from 'lucide-react';
import {
  getOrderEmails,
  getOrderEmail,
  getOrderEmailForwards,
  downloadOrderEmailAttachment,
  replayOrderEmailLifecycle,
  reviewOrderEmailLifecycle,
} from '../api/orderMailApi';
import { formatOrderTime } from '../utils/orderTime';

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
  excluded: '本期排除',
  unknown: '未知模板',
};
const LIFECYCLE_STATUS_LABELS = {
  unknown: '待确认',
  confirmed: '订单已确认',
  processing: '处理中',
  ready_for_pickup: '可取货',
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
  const panelRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = () => {
    if (!sending) onClose();
  };

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
    const previous = document.activeElement;
    const panel = panelRef.current;
    panel?.focus();
    const onKey = event => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll('button,input,textarea,[tabindex="0"]')].filter(
        element => !element.disabled && element.offsetParent !== null
      );
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === panel)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.addEventListener('keydown', onKey);
    return () => {
      panel.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, []);

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
  }, [order.id, selectedId]);

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

  return createPortal(
    <div className="fixed inset-0 z-50 bg-gray-900/30 flex justify-end">
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-mail-title"
        tabIndex={-1}
        className="bg-white w-full max-w-4xl h-full shadow-xl flex flex-col outline-none"
      >
        <header className="p-4 border-b flex items-center justify-between gap-3">
          <div>
            <h2
              id="order-mail-title"
              className="text-lg font-semibold text-gray-900 flex items-center gap-2"
            >
              <Mail className="w-5 h-5 text-primary" />
              订单邮件
            </h2>
            <p className="text-sm text-gray-500 break-all">
              {order.orderNumber} · 订单ID {order.id}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="btn btn-secondary"
            aria-label="关闭订单邮件"
          >
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {error && (
            <p role="alert" className="bg-red-50 text-red-700 rounded-lg p-3">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="bg-blue-50 text-primary rounded-lg p-3">
              {notice}
            </p>
          )}
          {selectedId ? (
            <>
              <button
                className="btn btn-secondary inline-flex items-center gap-1"
                disabled={sending}
                onClick={() => setSelectedId(null)}
              >
                <ArrowLeft className="w-4 h-4" />
                返回邮件列表
              </button>
              {loading && (
                <p className="text-gray-500" role="status">
                  正在加载邮件…
                </p>
              )}
              {detail && (
                <>
                  <div className="border rounded-lg p-4 space-y-2 break-words">
                    <h3 className="font-semibold text-gray-900">{detail.subject || '无主题'}</h3>
                    <p className="text-sm text-gray-600">发件人：{detail.from || '-'}</p>
                    <p className="text-sm text-gray-600">原始收件人：{detail.to || '-'}</p>
                    <p className="text-sm text-gray-600">
                      邮件发信：{formatOrderTime(detail.date)}
                    </p>
                    <p className="text-sm text-gray-600">
                      实际收信：{formatOrderTime(detail.receivedAt)}
                    </p>
                    {detail.lifecycle && (
                      <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm">
                        <p className="font-medium text-gray-900">
                          {TEMPLATE_LABELS[detail.lifecycle.templateType] || '未知模板'}
                        </p>
                        <p className="mt-1 text-gray-700">
                          订单：
                          {LIFECYCLE_STATUS_LABELS[detail.lifecycle.orderStatus] || '不更新'} ·
                          付款：
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
                                  <select
                                    className="input mt-1 w-full"
                                    value={reviewOrderStatus}
                                    disabled={reviewing}
                                    onChange={event => setReviewOrderStatus(event.target.value)}
                                  >
                                    <option value="unknown">待确认</option>
                                    <option value="confirmed">订单已确认</option>
                                    <option value="processing">处理中</option>
                                    <option value="ready_for_pickup">可取货</option>
                                  </select>
                                </label>
                                <label className="text-gray-700">
                                  付款状态
                                  <select
                                    className="input mt-1 w-full"
                                    value={reviewPaymentStatus}
                                    disabled={reviewing}
                                    onChange={event => setReviewPaymentStatus(event.target.value)}
                                  >
                                    <option value="unknown">待确认</option>
                                    <option value="paid">已付款</option>
                                  </select>
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
                    <div className="border-t pt-4 whitespace-pre-wrap break-words text-gray-900">
                      {detail.text || '此邮件没有可预览的文字正文，可查看附件。'}
                    </div>
                  </div>
                  {!!detail.attachments?.length && (
                    <div className="space-y-2">
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
                  )}
                </>
              )}
              {!!history.length && (
                <div>
                  <h3 className="font-medium text-gray-900 mb-2">转发记录（最近50条）</h3>
                  <div className="overflow-x-auto border rounded-lg">
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
                                <span className="block text-xs text-gray-500">
                                  {item.errorCode}
                                </span>
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
                  {list ? SYNC_LABELS[list.sync.status] : '正在读取同步状态'}
                  {list?.sync.lastSucceededAt && (
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
                              <span className="block text-xs text-gray-500 break-all">
                                {item.to}
                              </span>
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
                                  <p>
                                    {TEMPLATE_LABELS[item.lifecycle.templateType] || '未知模板'}
                                  </p>
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
                            <td className="p-3">{item.attachments?.length || 0}</td>
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
      </section>
    </div>,
    document.body
  );
}
