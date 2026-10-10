import ResponsiveSelect from './responsiveSelect';
import { useEffect, useRef, useState } from 'react';
import { X, RefreshCw } from 'lucide-react';
import { assignPaymentTasks, previewPaymentAssignment } from '../api/paymentDispatchApi';

/** 分配前逐条预检；合格子集由管理员明确选择，提交仍为原子操作。 */
export default function PaymentAssignmentModal({ tasks, staff, onClose, onAssigned, onReload }) {
  const [userId, setUserId] = useState('');
  const [handoff, setHandoff] = useState(false);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [revision, setRevision] = useState(0);
  const dialogRef = useRef(null);
  const submitLock = useRef(false);
  const attempt = useRef(null);
  const signature = JSON.stringify(
    tasks.map(task => ({ id: task.id, expectedVersion: task.version }))
  );
  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    setPreview(null);
    const check = async () => {
      try {
        const response = await previewPaymentAssignment({
          tasks: JSON.parse(signature),
          assigneeUserId: userId || undefined,
        });
        if (!cancelled) setPreview(response.data);
      } catch (failure) {
        if (!cancelled) setError(`预检失败：${failure.message}`);
      } finally {
        if (!cancelled) setChecking(false);
      }
    };
    check();
    return () => {
      cancelled = true;
    };
  }, [signature, userId, revision]);

  useEffect(() => {
    const escape = event => {
      if (event.key === 'Escape' && !submitLock.current) onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.focus({ preventScroll: true });
    const trap = event => {
      if (event.key !== 'Tab') return;
      const nodes = [
        ...dialog.querySelectorAll(
          'button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled)'
        ),
      ].filter(node => node.getClientRects().length);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog?.addEventListener('keydown', trap);
    return () => {
      dialog?.removeEventListener('keydown', trap);
      previous?.focus();
    };
  }, []);

  const items = preview?.items || [];
  const eligible = items.filter(item => item.eligible);
  const hasTransfer = eligible.some(item => item.hasTransfer);
  const unavailable = person =>
    person.status !== 'active'
      ? '账号不可用'
      : !person.hasExecutionPermissions
        ? '付款权限不完整'
        : person.maxActiveTasks <= 0
          ? '未设置接单容量'
          : '';

  const submit = async partial => {
    if (submitLock.current || checking || !preview || !userId) return;
    const chosen = partial ? eligible : items;
    if (!chosen.length || chosen.some(item => !item.eligible)) return;
    if (hasTransfer && !handoff) {
      setError('请确认原负责人已停止处理转派订单');
      return;
    }
    submitLock.current = true;
    setBusy(true);
    setError('');
    const chosenIds = new Set(chosen.map(item => Number(item.id)));
    const payload = {
      tasks: JSON.parse(signature).filter(item => chosenIds.has(Number(item.id))),
      assigneeUserId: Number(userId),
      handoffConfirmed: hasTransfer && handoff,
      reason: reason.trim() || undefined,
    };
    const fingerprint = JSON.stringify(payload);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: crypto.randomUUID() };
    try {
      const response = await assignPaymentTasks(payload, attempt.current.key);
      setResult({
        count: response.data.count,
        items: items.map(item => ({ ...item, assigned: chosenIds.has(Number(item.id)) })),
      });
      await onAssigned(response.data.count);
    } catch (failure) {
      setError(
        `${failure.message}${failure.details?.requestId ? `（请求编号：${failure.details.requestId}）` : ''}`
      );
      // 明确拒绝后可重新预检；网络结果未知则保留幂等键，重试同一请求。
      if (failure.response?.status && failure.response.status < 500) {
        attempt.current = null;
        setRevision(value => value + 1);
      }
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  };
  const reload = async () => {
    setError('');
    try {
      await onReload();
      setRevision(value => value + 1);
    } catch (failure) {
      setError(failure.message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="assignment-title"
        className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-xl bg-white shadow-xl"
      >
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 id="assignment-title" className="font-semibold text-gray-900">
            批量分配付款任务
          </h2>
          <button
            className="btn btn-secondary p-2"
            disabled={busy}
            aria-label="关闭批量分配弹窗"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          {error && (
            <p role="alert" className="text-sm text-red-700 break-words">
              {error}
            </p>
          )}
          {result ? (
            <p role="status" className="text-sm text-gray-700">
              已分配 {result.count} 条，未分配 {result.items.length - result.count} 条。
            </p>
          ) : (
            <>
              <label className="block text-sm font-medium text-gray-700">
                负责人
                <ResponsiveSelect
                  aria-label="负责人"
                  className="input w-full mt-2"
                  value={userId}
                  disabled={busy}
                  onChange={event => {
                    setUserId(event.target.value);
                    setHandoff(false);
                    setError('');
                  }}
                >
                  <option value="">请选择负责人</option>
                  {staff.map(person => (
                    <option
                      key={person.id}
                      value={person.id}
                      disabled={Boolean(unavailable(person))}
                    >
                      {person.nickname || person.username}（{person.username}） {person.activeCount}
                      /{person.maxActiveTasks}，剩余 {person.remainingCapacity}
                      {unavailable(person) ? ` · ${unavailable(person)}` : ''}
                    </option>
                  ))}
                </ResponsiveSelect>
              </label>
              <p className="text-xs text-gray-500">
                手动分配不受自动接单开关和 TAG 专属规则限制。待处理、处理中、异常任务占用容量。
              </p>
              {checking ? (
                <p role="status" className="text-sm text-gray-500">
                  正在检查分配条件…
                </p>
              ) : (
                <p role="status" className="text-sm text-gray-700">
                  共 {items.length} 条，可分配 {eligible.length} 条，阻塞{' '}
                  {items.length - eligible.length} 条{!userId ? '；请选择负责人检查容量' : ''}。
                </p>
              )}
              {items.some(item => item.expired) && (
                <p className="rounded-lg bg-amber-50 text-amber-800 p-3 text-sm">
                  包含已超时任务，允许手动分配；分配不会延长付款时间。
                </p>
              )}
            </>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm text-left">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="p-2 whitespace-nowrap">订单 ID</th>
                  <th className="p-2">分配情况</th>
                  <th className="p-2">处理建议与提示</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(result?.items || items).map(item => (
                  <tr key={item.id}>
                    <td className="p-2">
                      {item.orderId ||
                        tasks.find(task => Number(task.id) === Number(item.id))?.orderId ||
                        '-'}
                    </td>
                    <td className={`p-2 ${item.eligible ? 'text-gray-700' : 'text-red-700'}`}>
                      {result
                        ? item.assigned
                          ? '已分配'
                          : `未分配：${item.reason}`
                        : item.eligible
                          ? '可分配'
                          : item.reason}
                    </td>
                    <td className="p-2 text-gray-600">
                      {[item.solution, item.expired && '已超时', ...(item.warnings || [])]
                        .filter(Boolean)
                        .join('；') || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!result && hasTransfer && (
            <>
              <label className="block text-sm text-gray-700">
                转派原因（选填）
                <textarea
                  className="input w-full mt-2"
                  maxLength={500}
                  disabled={busy}
                  value={reason}
                  onChange={event => setReason(event.target.value)}
                />
              </label>
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={handoff}
                  onChange={event => setHandoff(event.target.checked)}
                />
                已确认原负责人停止处理所选转派订单
              </label>
            </>
          )}
        </div>
        <div className="px-5 py-4 border-t border-gray-200 flex flex-wrap justify-end gap-2">
          <button
            className="btn btn-secondary inline-flex items-center gap-2 whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={busy}
            onClick={onClose}
          >
            {result ? '完成' : '取消'}
          </button>
          {!result && (
            <>
              <button
                className="btn btn-secondary inline-flex items-center gap-2 whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={busy || checking}
                onClick={reload}
              >
                <RefreshCw className="w-4 h-4" />
                重新检查
              </button>
              {preview?.blockedCount > 0 && (
                <button
                  className="btn btn-primary inline-flex items-center gap-2 whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={
                    busy || checking || !userId || !eligible.length || (hasTransfer && !handoff)
                  }
                  onClick={() => submit(true)}
                >
                  仅分配符合条件的 {eligible.length} 条
                </button>
              )}
              <button
                className="btn btn-primary inline-flex items-center gap-2 whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={
                  busy ||
                  checking ||
                  !userId ||
                  !eligible.length ||
                  Boolean(preview?.blockedCount) ||
                  (hasTransfer && !handoff)
                }
                onClick={() => submit(false)}
              >
                {busy ? '分配中…' : '确认全部分配'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
