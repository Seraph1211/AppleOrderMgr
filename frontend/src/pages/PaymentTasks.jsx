import { formatOrderTime } from '../utils/orderTime';
import Pagination from '../components/Pagination';
import usePaymentRefresh from '../hooks/usePaymentRefresh';
import { getPaymentStageLabel } from '../utils/paymentStage';
import { ORDER_STATUS_LABELS } from '../constants/orderStatus';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, CreditCard, RefreshCw, Save } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';
import {
  getPaymentTaskLink,
  getPaymentTaskRefreshJob,
  getPaymentTasks,
  refreshPaymentTask,
  updatePaymentTask,
} from '../api/paymentTasksApi';

const STATUS_LABELS = {
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  exception: '异常',
};

const STATUS_STYLES = {
  pending: 'bg-amber-50 border-amber-200 text-amber-700',
  processing: 'bg-blue-50 border-blue-200 text-blue-700',
  completed: 'bg-green-50 border-green-200 text-green-700',
  exception: 'bg-red-50 border-red-200 text-red-700',
};

const STATUS_BADGES = {
  pending: 'badge badge-warning',
  processing: 'badge badge-info',
  completed: 'badge badge-success',
  exception: 'badge badge-error',
};

function formatCountdown(deadlineAt, now, task) {
  const stage = getPaymentStageLabel(task);
  if (stage) return stage;
  if (!deadlineAt) return '待核实';
  const seconds = Math.floor((new Date(deadlineAt).getTime() - now) / 1000);
  if (seconds <= 0) return `已超时 ${Math.ceil(Math.abs(seconds) / 60)} 分钟`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export default function PaymentTasks() {
  const { can } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 0 });
  const loadRequest = useRef(0);
  const [filters, setFilters] = useState({
    processingStatus: '',
    orderNumber: '',
    productKeyword: '',
  });
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [serverClockOffset, setServerClockOffset] = useState(0);
  const [rowActions, setRowActions] = useState({});
  const [selectedTaskIds, setSelectedTaskIds] = useState([]);

  const loadTasks = useCallback(
    async (preserveDrafts = false) => {
      const request = ++loadRequest.current;
      if (!preserveDrafts) setLoading(true);
      setError('');
      try {
        const params = Object.fromEntries(Object.entries(filters).filter(([, value]) => value));
        const response = await getPaymentTasks({ ...params, page, limit: pageSize });
        if (request !== loadRequest.current) return;
        setPagination(response.data.pagination);
        const lastPage = Math.max(1, response.data.pagination.totalPages);
        if (page > lastPage) {
          setSelectedTaskIds([]);
          setPage(lastPage);
          return;
        }
        const visibleIds = new Set(response.data.items.map(task => task.id));
        setSelectedTaskIds(previous => previous.filter(id => visibleIds.has(id)));
        setTasks(response.data.items);
        setServerClockOffset(new Date(response.data.serverTime).getTime() - Date.now());
        setDrafts(previous =>
          Object.fromEntries(
            response.data.items.map(task => [
              task.id,
              preserveDrafts && previous[task.id]
                ? previous[task.id]
                : {
                    status: task.processingStatus,
                    notes: task.processingNotes || '',
                    payerName: task.payerName || '',
                  },
            ])
          )
        );
      } catch (loadError) {
        if (request === loadRequest.current) {
          setError(loadError.message);
          setTasks([]);
        }
      } finally {
        if (request === loadRequest.current) setLoading(false);
      }
    },
    [filters, page, pageSize]
  );

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);
  const loadCurrent = useRef(loadTasks);
  loadCurrent.current = loadTasks;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + serverClockOffset), 1000);
    return () => clearInterval(timer);
  }, [serverClockOffset]);
  const summary = useMemo(
    () =>
      tasks.reduce(
        (result, task) => ({
          ...result,
          [task.processingStatus]: result[task.processingStatus] + 1,
        }),
        { pending: 0, processing: 0, completed: 0, exception: 0 }
      ),
    [tasks]
  );

  const updateDraft = (taskId, field, value) => {
    setDrafts(previous => ({
      ...previous,
      [taskId]: { ...previous[taskId], [field]: value },
    }));
  };

  const updateRowAction = (taskId, patch) => {
    setRowActions(previous => ({
      ...previous,
      [taskId]: { ...previous[taskId], ...patch },
    }));
  };

  const getTaskChanges = task => {
    const draft = drafts[task.id];
    if (!draft) return {};
    const payload = {};
    if (
      can(PERMISSIONS.PAYMENT_TASKS_HANDLE_OWN) &&
      (draft.status !== task.processingStatus || draft.notes !== (task.processingNotes || ''))
    ) {
      payload.processingStatus = draft.status;
      payload.processingNotes = draft.notes;
      payload.expectedVersion = task.version;
    }
    const payerName = draft.payerName.trim();
    if (can(PERMISSIONS.PAYMENT_TASKS_PAYER_EDIT_OWN) && payerName !== (task.payerName || '')) {
      payload.payerName = payerName || null;
      payload.expectedPayerVersion = task.payerVersion;
    }
    return payload;
  };

  const saveTask = async task => {
    const payload = getTaskChanges(task);
    if (Object.keys(payload).length === 0) {
      updateRowAction(task.id, { type: 'info', message: '没有需要保存的修改' });
      return;
    }
    updateRowAction(task.id, {
      saving: true,
      type: 'info',
      message: '保存中...',
    });
    try {
      setError('');
      await updatePaymentTask(task.id, payload, crypto.randomUUID());
      await loadCurrent.current();
      updateRowAction(task.id, {
        saving: false,
        type: 'success',
        message: '保存成功',
      });
    } catch (actionError) {
      updateRowAction(task.id, {
        saving: false,
        type: 'error',
        message: actionError.message,
      });
    }
  };

  const copyPaymentLink = async task => {
    updateRowAction(task.id, {
      copying: true,
      type: 'info',
      message: '复制中...',
    });
    try {
      setError('');
      const response = await getPaymentTaskLink(task.id);
      await navigator.clipboard.writeText(response.data.paymentUrl);
      updateRowAction(task.id, {
        copying: false,
        type: 'success',
        message: '订单链接已复制',
      });
    } catch (actionError) {
      updateRowAction(task.id, {
        copying: false,
        type: 'error',
        message: actionError.message,
      });
    }
  };

  const { progress, refreshTask, refreshSelected, submittingBatch } = usePaymentRefresh({
    submit: refreshPaymentTask,
    getJob: getPaymentTaskRefreshJob,
    onComplete: () => loadTasks(true),
  });

  const changeFilters = next => {
    setSelectedTaskIds([]);
    setPage(1);
    setFilters(next);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <CreditCard className="w-6 h-6 text-primary" />
            付款任务
          </h1>
          <p className="text-sm text-gray-500 mt-1">仅显示当前分配给本人的任务</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-gray-500">本页统计</span>
          {Object.entries(STATUS_LABELS).map(([status, label]) => (
            <span key={status} className={STATUS_BADGES[status]}>
              {label} {summary[status]}
            </span>
          ))}
        </div>
      </div>

      <div className="card grid grid-cols-1 md:grid-cols-3 gap-3">
        <input
          className="input"
          placeholder="订单号"
          value={filters.orderNumber}
          onChange={event => changeFilters({ ...filters, orderNumber: event.target.value })}
        />
        <input
          className="input"
          placeholder="商品名称或型号"
          value={filters.productKeyword}
          onChange={event => changeFilters({ ...filters, productKeyword: event.target.value })}
        />
        <select
          className="input"
          value={filters.processingStatus}
          onChange={event => changeFilters({ ...filters, processingStatus: event.target.value })}
        >
          <option value="">未完成任务</option>
          <option value="pending">待处理</option>
          <option value="processing">处理中</option>
          <option value="completed">已完成</option>
          <option value="exception">异常</option>
        </select>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 text-red-700 px-4 py-3 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button className="btn btn-secondary" onClick={() => loadTasks()}>
            重新加载
          </button>
        </div>
      )}
      {can(PERMISSIONS.PAYMENT_TASKS_REFRESH_OWN) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-gray-500">
            已选择 {selectedTaskIds.length} 项（当前页）
          </span>
          <button
            className="btn btn-secondary inline-flex items-center gap-2"
            disabled={
              loading ||
              submittingBatch ||
              !tasks.some(
                task => selectedTaskIds.includes(task.id) && !progress[task.id]?.refreshing
              )
            }
            onClick={() => refreshSelected(tasks.filter(task => selectedTaskIds.includes(task.id)))}
          >
            <RefreshCw className={`w-4 h-4 ${submittingBatch ? 'animate-spin' : ''}`} />
            {submittingBatch ? '提交中...' : '批量刷新'}
          </button>
        </div>
      )}
      <div className="card p-0 overflow-hidden">
        {loading ? (
          <p className="text-center text-gray-500 py-12">加载中...</p>
        ) : tasks.length === 0 ? (
          <p className="text-center text-gray-500 py-12">暂无匹配的付款任务</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1740px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {can(PERMISSIONS.PAYMENT_TASKS_REFRESH_OWN) && (
                    <th className="px-4 py-3">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer accent-primary"
                        aria-label="选择当前页全部任务"
                        checked={tasks.length > 0 && selectedTaskIds.length === tasks.length}
                        ref={element => {
                          if (element)
                            element.indeterminate =
                              selectedTaskIds.length > 0 && selectedTaskIds.length < tasks.length;
                        }}
                        onChange={event =>
                          setSelectedTaskIds(event.target.checked ? tasks.map(task => task.id) : [])
                        }
                      />
                    </th>
                  )}
                  {[
                    '订单 / 商品',
                    '下单时间',
                    '官网状态',
                    '付款方式',
                    '倒计时',
                    '处理状态',
                    '处理备注',
                    '付款人',
                    '最后更新时间',
                    '操作',
                  ].map(title => (
                    <th
                      key={title}
                      title={
                        title === '下单时间'
                          ? '北京时间，邮件或人工录入来源；缺失时采用官网精确时间'
                          : undefined
                      }
                      className="text-left px-4 py-3 text-sm text-gray-500"
                    >
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tasks.map(task => (
                  <tr key={task.id} className="border-b border-gray-100 align-top hover:bg-gray-50">
                    {can(PERMISSIONS.PAYMENT_TASKS_REFRESH_OWN) && (
                      <td className="px-4 py-4">
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer accent-primary"
                          aria-label={`选择订单 ${task.orderNumber}`}
                          checked={selectedTaskIds.includes(task.id)}
                          onChange={() =>
                            setSelectedTaskIds(previous =>
                              previous.includes(task.id)
                                ? previous.filter(id => id !== task.id)
                                : [...previous, task.id]
                            )
                          }
                        />
                      </td>
                    )}
                    <td className="px-4 py-4">
                      <div className="font-medium">{task.orderNumber}</div>
                      <div className="text-xs text-gray-500 mt-1">
                        {task.products
                          .map(product => `${product.name} ×${product.quantity}`)
                          .join('、')}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-sm text-gray-600 whitespace-nowrap">
                      {formatOrderTime(task.orderDate || task.officialOrderCreatedAt)}
                    </td>
                    <td className="px-4 py-4 text-sm">
                      {task.officialPaymentConfirmed
                        ? '官网已确认付款'
                        : task.officialPaymentStatus || '未知'}
                      {task.officialPaymentDiscrepancy && (
                        <p className="text-xs text-amber-700">人工任务尚未完成</p>
                      )}
                      <div className="text-xs text-gray-400">
                        {ORDER_STATUS_LABELS[task.officialOrderStatus] || task.officialOrderStatus}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-sm text-gray-700">{task.paymentMethod || '-'}</td>
                    <td
                      className={`px-4 py-4 text-sm ${task.remainingSeconds !== null && task.remainingSeconds <= 300 ? 'text-red-600 font-medium' : 'text-gray-700'}`}
                    >
                      {formatCountdown(task.deadlineAt, now, task)}
                    </td>
                    <td className="px-4 py-4">
                      <select
                        className={`input min-w-28 font-medium ${STATUS_STYLES[drafts[task.id]?.status || task.processingStatus]}`}
                        disabled={!can(PERMISSIONS.PAYMENT_TASKS_HANDLE_OWN)}
                        value={drafts[task.id]?.status || task.processingStatus}
                        onChange={event => updateDraft(task.id, 'status', event.target.value)}
                      >
                        {Object.entries(STATUS_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-4">
                      <textarea
                        className="input min-w-56"
                        rows="2"
                        maxLength="2000"
                        disabled={!can(PERMISSIONS.PAYMENT_TASKS_HANDLE_OWN)}
                        value={drafts[task.id]?.notes || ''}
                        onChange={event => updateDraft(task.id, 'notes', event.target.value)}
                      />
                    </td>
                    <td className="px-4 py-4">
                      <input
                        className="input min-w-48"
                        type="text"
                        maxLength="100"
                        placeholder="输入实际付款人姓名"
                        disabled={!can(PERMISSIONS.PAYMENT_TASKS_PAYER_EDIT_OWN)}
                        value={drafts[task.id]?.payerName || ''}
                        onChange={event => updateDraft(task.id, 'payerName', event.target.value)}
                      />
                    </td>
                    <td className="px-4 py-4 text-sm text-gray-600 whitespace-nowrap">
                      {formatDateTime(task.updatedAt)}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex gap-2 items-center">
                        {(can(PERMISSIONS.PAYMENT_TASKS_HANDLE_OWN) ||
                          can(PERMISSIONS.PAYMENT_TASKS_PAYER_EDIT_OWN)) && (
                          <button
                            className="btn btn-primary px-2"
                            onClick={() => saveTask(task)}
                            disabled={rowActions[task.id]?.saving}
                            title="保存本行修改"
                            aria-label="保存本行修改"
                          >
                            <Save
                              className={`w-4 h-4 ${rowActions[task.id]?.saving ? 'animate-pulse' : ''}`}
                            />
                          </button>
                        )}
                        {can(PERMISSIONS.PAYMENT_TASKS_LINK_READ_OWN) && (
                          <button
                            className="btn btn-secondary px-2"
                            onClick={() => copyPaymentLink(task)}
                            disabled={rowActions[task.id]?.copying}
                            title="复制订单链接"
                            aria-label="复制订单链接"
                          >
                            <Copy className="w-4 h-4" />
                          </button>
                        )}
                        {can(PERMISSIONS.PAYMENT_TASKS_REFRESH_OWN) && (
                          <button
                            className="btn btn-secondary px-2"
                            onClick={() => refreshTask(task)}
                            disabled={progress[task.id]?.refreshing}
                            title="刷新官网状态"
                            aria-label="刷新官网状态"
                          >
                            <RefreshCw
                              className={`w-4 h-4 ${progress[task.id]?.refreshing ? 'animate-spin' : ''}`}
                            />
                          </button>
                        )}
                      </div>
                      {progress[task.id]?.message && (
                        <p
                          role="status"
                          className={`mt-2 text-xs max-w-44 ${progress[task.id].type === 'error' ? 'text-red-600' : progress[task.id].type === 'success' ? 'text-green-700' : 'text-gray-500'}`}
                        >
                          {progress[task.id].message}
                        </p>
                      )}
                      {rowActions[task.id]?.message && (
                        <p
                          className={`mt-2 text-xs max-w-44 ${
                            rowActions[task.id].type === 'error'
                              ? 'text-red-600'
                              : rowActions[task.id].type === 'success'
                                ? 'text-green-700'
                                : 'text-gray-500'
                          }`}
                        >
                          {rowActions[task.id].message}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!loading && pagination.total > 0 && (
        <Pagination
          currentPage={page}
          totalPages={pagination.totalPages}
          totalItems={pagination.total}
          pageSize={pageSize}
          onPageChange={next => {
            setSelectedTaskIds([]);
            setPage(next);
          }}
          onPageSizeChange={size => {
            setSelectedTaskIds([]);
            setPage(1);
            setPageSize(size);
          }}
          pageSizeOptions={[10, 20, 50, 100]}
        />
      )}
    </div>
  );
}
