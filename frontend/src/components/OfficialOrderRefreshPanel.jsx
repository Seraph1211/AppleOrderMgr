import { useEffect, useState } from 'react';
import {
  getOfficialOrderBatch,
  listOfficialOrderBatches,
  cancelOfficialOrderBatch,
} from '../api/officialOrderRefreshApi';
import OfficialOrderStatus from './OfficialOrderStatus';
import { formatOfficialRefreshDuration } from '../utils/officialRefreshDuration';

const STATES = {
  queued: '排队中',
  running: '查询中',
  succeeded: '已更新',
  failed: '失败',
  cancelled: '已取消',
};
const ERRORS = {
  AUTHENTICATION_REQUIRED: '官网链接需要登录，请人工核对官网',
  IPROYAL_CONFIG_INVALID: 'IPRoyal 配置缺失或无效，请联系管理员',
  IPROYAL_API_FAILED: 'IPRoyal 代理提取失败，请稍后重试',
  EGRESS_CHANGED_OR_UNVERIFIED: '代理出口未通过核验，本次结果未写入',
  HTTP_CLEANUP_PENDING: '采集清理未确认，请联系管理员',
  HTTP_TIMEOUT: '官网请求超时，请稍后手动重试',
  ORDER_ID_INVALID: '订单编号无效，请重新选择订单',
  ORDER_NOT_FOUND: '订单不存在或已被移除',
  ACCOUNT_ID_MISSING: '订单缺少 Apple ID，请核对订单资料',
  ACCOUNT_CHANGED: '订单关联的 Apple ID 已变化，请重新提交',
  LEGACY_ACCOUNT_SCOPE: '旧队列已暂停，请重新选择需要更新的订单',
  TIME_BUDGET: '账号组查询时间已用完，保留已成功的订单结果',
  ACCOUNT_REFERENCE_CONFLICT: '订单与关联 Apple ID 不一致，请核对账号关联',
  ORDER_ACCOUNT_AMBIGUOUS: '匹配到多个 Apple ID，请核对账号库',
  ACCOUNT_MARKED_INVALID: '关联 Apple ID 已标记异常，请先核对账号',
  ORDER_CREDENTIALS_MISSING: '缺少可用的账号密码，请补全订单或账号资料',
  CREDENTIAL_DECRYPT_FAILED: '账号密码读取失败，请联系管理员检查加密配置',
  CREDENTIAL_SNAPSHOT_MISMATCH: '订单密码快照与账号库不一致，请核对后重试',
  ORDER_INPUT_READ_FAILED: '订单资料读取失败，请联系管理员检查服务日志',
  INPUT_INVALID: '订单查询资料不完整或格式无效，请核对订单',
  LINK_IDENTITY_MISMATCH: '官网链接与订单不一致，请核对订单链接',
  DESTINATION_DENIED: '订单链接无效或不是支持的 Apple 官网地址',
  PRIVATE_FILE_PERMISSIONS: '服务器取数文件权限异常，请联系管理员',
  COLLECTOR_EXIT_FAILED: '采集进程异常结束，本次结果未写入',
  REQUEST_BUDGET: '本轮请求额度已用完',
  ORDER_ATTEMPT_LIMIT: '该订单今日查询次数已满',
  ACCOUNT_COOLDOWN: '账号处于冷却中',
  LOGIN_COOLDOWN: '账号登录冷却中',
  PROXY_COOLDOWN: '代理暂不可用',
  ACCOUNT_BUSY: '账号正在查询',
  COLLECTOR_BUSY: '采集器正在运行',
  AUTH_REJECTED: '官网未接受本次登录，需核对账号登录前置要求',
  AUTH_PRECONDITION_REQUIRED: 'Apple 登录需要完成额外步骤（HTTP 412），请核对官网提示',
  HTTP_AUTH_FAILED: '官网拒绝认证，需核对账号登录前置要求',
  HTTP_407: '代理认证失败，请联系管理员检查代理配置',
  PROXY_CONNECTION_FAILED: '代理连接失败，请联系管理员检查出口',
  MULTIPLE_ACCOUNT_AUTH_FAILURES: '此前多个账号登录未完成',
  LEGACY_SAFETY_HOLD: '此前批量查询已保护性暂停',
  REQUEUED_MANUALLY: '已由新的手动查询替代',
  HUMAN_VERIFICATION_REQUIRED: '官网要求人工验证',
  HTTP_541: '官网限制访问',
  HTTP_429: '官网请求限流',
  NO_VALID_ORDER_DATA: '未取得完整订单详情',
  INVALID_OFFICIAL_RESULT: '官网结果未通过校验',
  ACCESS_REVOKED: '权限或订单信息已变化',
  WORKER_INTERRUPTED: '任务中断，请手动重试',
  COLLECTOR_INTERRUPTED: '查询中断，请稍后重试',
  COLLECTOR_FAILED: '采集未完成，可重新提交；再次失败请联系管理员',
  SITE_READINESS_TIMEOUT: '官网加载超时',
  COLLECTOR_ERROR: '官网查询异常',
};

export default function OfficialOrderRefreshPanel({ batchId, onBatchChange, onUpdated }) {
  const [batch, setBatch] = useState(null);
  const [recent, setRecent] = useState([]);
  const [listing, setListing] = useState(true);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!batch) return;
    const serverTime = Date.parse(batch.serverTime);
    const baseline = Number.isFinite(serverTime) ? serverTime : Date.now();
    const receivedAt = Date.now();
    setNow(baseline);
    if (!batch.counts.running) return;
    const timer = window.setInterval(() => setNow(baseline + Date.now() - receivedAt), 1000);
    return () => window.clearInterval(timer);
  }, [batch]);

  useEffect(() => {
    let active = true;
    setListing(true);
    listOfficialOrderBatches()
      .then(response => {
        if (!active) return;
        setRecent(response.data || []);
        if (!batchId && response.data?.[0]) onBatchChange(response.data[0].id);
      })
      .catch(reason => {
        if (active) setError(reason.message);
      })
      .finally(() => {
        if (active) setListing(false);
      });
    return () => {
      active = false;
    };
  }, [batchId, onBatchChange]);

  useEffect(() => {
    setPage(1);
    setBatch(null);
  }, [batchId]);
  useEffect(() => {
    if (!batchId) return;
    let active = true;
    let timer;
    const refresh = async () => {
      try {
        const response = await getOfficialOrderBatch(batchId, page);
        if (!active) return;
        setError('');
        setBatch(response.data);
        onUpdated();
        if (response.data.counts.queued + response.data.counts.running > 0)
          timer = window.setTimeout(refresh, 5000);
      } catch (reason) {
        if (active) {
          setError(reason.message);
          timer = window.setTimeout(refresh, 15000);
        }
      }
    };
    refresh();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [batchId, page, revision, onUpdated]);

  const cancel = async () => {
    setCancelling(true);
    try {
      await cancelOfficialOrderBatch(batchId);
      setRevision(value => value + 1);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setCancelling(false);
    }
  };
  if (!batchId && !error)
    return (
      <p className="text-sm text-gray-500" role="status">
        {listing ? '正在读取任务进度…' : '暂无官网更新任务，请在订单列表中选择订单并手动更新。'}
      </p>
    );
  return (
    <section className="min-w-0 space-y-3" aria-label="官网更新进度">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-gray-500">关闭弹窗后任务继续执行</span>
        {recent.length > 1 && (
          <select
            className="input w-auto max-w-full"
            aria-label="官网更新批次"
            value={batchId || ''}
            onChange={event => onBatchChange(event.target.value)}
          >
            {recent.map(item => (
              <option key={item.id} value={item.id}>
                {new Date(item.createdAt).toLocaleString('zh-CN')} · {item.total} 单
                {item.pausedAt ? ' · 已暂停' : ''}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      {!batch && !error && <p className="text-sm text-gray-500">正在读取任务进度…</p>}
      {batch && (
        <>
          <p className="text-sm text-gray-600" role="status">
            共 {batch.total} 单 · 已更新 {batch.counts.succeeded} · 失败 {batch.counts.failed} ·
            查询中 {batch.counts.running} · 排队 {batch.counts.queued} · 已取消{' '}
            {batch.counts.cancelled}
          </p>
          {batch.pausedAt && (
            <p className="text-sm text-amber-700" role="status">
              批次已暂停：{ERRORS[batch.pauseReason] || '需要管理员核查'}。
              剩余任务不会自动重试；核查后可重新选择需要的订单更新，账号冷却仍然有效。
            </p>
          )}
          {(batch.counts.queued + batch.counts.running > 0 || batch.pausedAt) &&
            (batch.workerOnline === false || batch.pausedAt) && (
              <p className="text-xs text-gray-500">
                {batch.workerOnline === false
                  ? '官网更新后台服务离线，请联系管理员检查；已有任务和官网状态已保留。'
                  : '官网更新服务在线，此批次暂停不影响新的手动查询。'}
              </p>
            )}
          {batch.counts.queued > 0 && (
            <button className="btn btn-secondary" disabled={cancelling} onClick={cancel}>
              {cancelling ? '正在取消' : '取消待处理任务'}
            </button>
          )}
          <details>
            <summary className="cursor-pointer text-sm text-primary">查看逐单结果</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="p-2">订单</th>
                    <th className="p-2">进度</th>
                    <th className="p-2">耗时</th>
                    <th className="p-2">结果</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.jobs.map(job => (
                    <tr key={job.id} className="border-t border-gray-100">
                      <td className="whitespace-nowrap p-2">
                        {job.orderId}
                        <br />
                        <span className="font-mono text-xs">{job.orderNumber}</span>
                      </td>
                      <td className="whitespace-nowrap p-2">
                        {batch.pausedAt && job.state === 'queued' ? '已暂停' : STATES[job.state]}
                      </td>
                      <td className="whitespace-nowrap p-2 tabular-nums">
                        {formatOfficialRefreshDuration(job, now)}
                      </td>
                      <td className="min-w-32 p-2">
                        {job.errorCode ? (
                          <span className="text-amber-700">
                            {ERRORS[job.errorCode] || `查询未完成（${job.errorCode}）`}
                          </span>
                        ) : job.state === 'succeeded' || job.state === 'running' ? (
                          <OfficialOrderStatus
                            status={job.officialStatus}
                            observedAt={job.observedAt}
                            loading={job.state === 'running'}
                          />
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {batch.total > batch.limit && (
              <div className="mt-2 flex items-center gap-3 text-sm">
                <button
                  className="btn btn-secondary"
                  disabled={page <= 1}
                  onClick={() => setPage(value => value - 1)}
                >
                  上一页
                </button>
                <span>
                  {page} / {Math.ceil(batch.total / batch.limit)}
                </span>
                <button
                  className="btn btn-secondary"
                  disabled={page * batch.limit >= batch.total}
                  onClick={() => setPage(value => value + 1)}
                >
                  下一页
                </button>
              </div>
            )}
          </details>
        </>
      )}
    </section>
  );
}
