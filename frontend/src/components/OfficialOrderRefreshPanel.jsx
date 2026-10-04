import { useEffect, useState } from 'react';
import {
  getOfficialOrderBatch,
  listOfficialOrderBatches,
  cancelOfficialOrderBatch,
} from '../api/officialOrderRefreshApi';
import OfficialOrderStatus from './OfficialOrderStatus';

const STATES = {
  queued: '排队中',
  running: '查询中',
  succeeded: '已更新',
  failed: '失败',
  cancelled: '已取消',
};
const ERRORS = {
  ORDER_ID_INVALID: '订单编号无效，请重新选择订单',
  ORDER_NOT_FOUND: '订单不存在或已被移除',
  ACCOUNT_ID_MISSING: '订单缺少 Apple ID，请核对订单资料',
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
  AUTH_REJECTED: '账号登录失败',
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
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    listOfficialOrderBatches()
      .then(response => {
        if (!active) return;
        setRecent(response.data || []);
        if (!batchId && response.data?.[0]) onBatchChange(response.data[0].id);
      })
      .catch(reason => {
        if (active) setError(reason.message);
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
  if (!batchId && !error) return null;
  return (
    <section className="card min-w-0 space-y-3" aria-label="官网更新进度">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-gray-900">官网更新进度</h2>
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
          {batch.counts.queued + batch.counts.running > 0 && (
            <p className="text-xs text-gray-500">
              {batch.workerOnline === false
                ? '服务器更新服务暂时离线，待处理任务已保存；恢复后继续执行。'
                : '服务器正在逐单查询，关闭页面后继续执行。失败时保留上次官网状态。'}
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
                    <th className="p-2">结果</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.jobs.map(job => (
                    <tr key={job.id} className="border-t border-gray-100">
                      <td className="p-2">
                        {job.orderId}
                        <br />
                        <span className="font-mono text-xs">{job.orderNumber}</span>
                      </td>
                      <td className="whitespace-nowrap p-2">{STATES[job.state]}</td>
                      <td className="min-w-32 p-2">
                        {job.errorCode ? (
                          <span className="text-amber-700">
                            {ERRORS[job.errorCode] || `查询未完成（${job.errorCode}）`}
                          </span>
                        ) : job.state === 'succeeded' ? (
                          <OfficialOrderStatus
                            status={job.officialStatus}
                            observedAt={job.observedAt}
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
