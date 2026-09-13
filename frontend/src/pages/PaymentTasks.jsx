import PaymentCodeButton from '../components/PaymentCodeButton';
import OrderDateFilter from '../components/OrderDateFilter';
import OfficialStatusFilter from '../components/OfficialStatusFilter';
import { getOfficialStatusTagClass } from '../utils/officialStatusStyle';
import { buildPaymentCopyText } from '../utils/paymentCopy';
import { copyDeferredText } from '../utils/copyDeferredText';
import { updateSelectedTaskStatuses } from '../utils/paymentTaskBatch';
import { formatOrderTime } from '../utils/orderTime';
import Pagination from '../components/Pagination';
import TagMultiSelect from '../components/TagMultiSelect';
import usePaymentRefresh from '../hooks/usePaymentRefresh';
import { getPaymentStageLabel } from '../utils/paymentStage';
import { ORDER_STATUS_LABELS } from '../constants/orderStatus';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Copy, CreditCard, RefreshCw, RotateCcw, Save, Search } from 'lucide-react';
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

const INITIAL_FILTERS = {
  processingStatus: '',
  orderNumber: '',
  productKeyword: '',
  recipientTags: [],
  officialOrderStatuses: [],
  dateFrom: '',
  dateTo: '',
};

const COPY_LINK_CONCURRENCY = 5;

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
  if (!value) return '尚未获取';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '尚未获取';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export default function PaymentTasks() {
  const { can } = useAuth();
  const canRefreshTasks = can(PERMISSIONS.PAYMENT_TASKS_REFRESH_OWN);
  const canCopyTaskInfo = can(PERMISSIONS.PAYMENT_TASKS_LINK_READ_OWN);
  const canHandleTasks = can(PERMISSIONS.PAYMENT_TASKS_HANDLE_OWN);
  const canSelectTasks = canRefreshTasks || canCopyTaskInfo || canHandleTasks;
  const [tasks, setTasks] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 0 });
  const [recipientTagOptions, setRecipientTagOptions] = useState([]);
  const loadRequest = useRef(0);
  const [filterDrafts, setFilterDrafts] = useState(INITIAL_FILTERS);
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [serverClockOffset, setServerClockOffset] = useState(0);
  const [rowActions, setRowActions] = useState({});
  const [selectedTaskIds, setSelectedTaskIds] = useState([]);
  const [batchCopyAction, setBatchCopyAction] = useState(null);
  const [wideDetails, setWideDetails] = useState(
    () => window.matchMedia('(min-width: 1200px)').matches
  );
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1200px)');
    const update = () => setWideDetails(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const [expandedTasks, setExpandedTasks] = useState([]);
  const [showFilters, setShowFilters] = useState(false);
  const [batchEditorOpen, setBatchEditorOpen] = useState(false);
  const [batchStatus, setBatchStatus] = useState('processing');
  const [batchNotes, setBatchNotes] = useState('');
  const [batchSaving, setBatchSaving] = useState(false);
  const batchLock = useRef(false);
  const [batchResults, setBatchResults] = useState([]);

  useEffect(() => {
    setBatchCopyAction(null);
  }, [selectedTaskIds]);

  const loadTasks = useCallback(
    async (preserveDrafts = false) => {
      const request = ++loadRequest.current;
      if (!preserveDrafts) setLoading(true);
      setError('');
      try {
        const params = Object.fromEntries(
          Object.entries(filters).filter(([, value]) =>
            Array.isArray(value) ? value.length > 0 : Boolean(value)
          )
        );
        if (params.recipientTags) params.recipientTags = JSON.stringify(params.recipientTags);
        if (params.officialOrderStatuses)
          params.officialOrderStatuses = JSON.stringify(params.officialOrderStatuses);
        const response = await getPaymentTasks({
          ...params,
          page,
          limit: pageSize,
        });
        if (request !== loadRequest.current) return;
        setPagination(response.data.pagination);
        setRecipientTagOptions(response.data.recipientTagOptions || []);
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
  const selectedTasks = useMemo(
    () => tasks.filter(task => selectedTaskIds.includes(task.id)),
    [selectedTaskIds, tasks]
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

  const saveSelectedStatuses = async event => {
    event.preventDefault();
    if (batchLock.current || !canHandleTasks || !selectedTasks.length) return;
    batchLock.current = true;
    // 忽略提交前已发出的列表响应，防止旧快照覆盖批量结果。
    loadRequest.current += 1;
    setBatchSaving(true);
    setBatchResults([]);
    try {
      const results = await updateSelectedTaskStatuses(
        selectedTasks,
        batchStatus,
        batchNotes,
        updatePaymentTask,
        () => crypto.randomUUID()
      );
      setBatchResults(results);
      const successful = new Map(
        results.filter(result => result.success).map(result => [result.id, result.task])
      );
      setTasks(previous => previous.map(task => successful.get(task.id) || task));
      setDrafts(previous => {
        const next = { ...previous };
        for (const [id, task] of successful) {
          // 批量操作不提交行内草稿；保留备注和付款人草稿以便用户继续编辑。
          next[id] = { ...next[id], status: task.processingStatus };
          if (batchNotes.trim()) next[id].notes = task.processingNotes || '';
        }
        return next;
      });
      setSelectedTaskIds(results.filter(result => !result.success).map(result => result.id));
      if (results.every(result => result.success)) {
        setBatchEditorOpen(false);
        setBatchNotes('');
      }
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      batchLock.current = false;
      setBatchSaving(false);
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
      await copyDeferredText(async () => {
        const response = await getPaymentTaskLink(task.id);
        return buildPaymentCopyText(task, response.data.paymentUrl);
      });
      updateRowAction(task.id, {
        copying: false,
        type: 'success',
        message: '订单信息已复制',
      });
    } catch (actionError) {
      updateRowAction(task.id, {
        copying: false,
        type: 'error',
        message: actionError.message,
      });
    }
  };

  const copySelectedTasks = async () => {
    if (selectedTasks.length === 0) return;
    setBatchCopyAction({
      copying: true,
      type: 'info',
      message: '正在获取订单信息...',
    });
    try {
      setError('');
      await copyDeferredText(async () => {
        const lines = [];
        for (let index = 0; index < selectedTasks.length; index += COPY_LINK_CONCURRENCY) {
          const chunk = selectedTasks.slice(index, index + COPY_LINK_CONCURRENCY);
          const chunkLines = await Promise.all(
            chunk.map(async task => {
              const response = await getPaymentTaskLink(task.id);
              return buildPaymentCopyText(task, response.data.paymentUrl);
            })
          );
          lines.push(...chunkLines);
        }
        return lines.join('\n\n');
      });
      setBatchCopyAction({
        copying: false,
        type: 'success',
        message: `已复制 ${selectedTasks.length} 条订单信息`,
      });
    } catch (actionError) {
      setBatchCopyAction({
        copying: false,
        type: 'error',
        message: `批量复制失败：${actionError.message}`,
      });
    }
  };

  const { progress, refreshTask, refreshSelected, submittingBatch } = usePaymentRefresh({
    submit: refreshPaymentTask,
    getJob: getPaymentTaskRefreshJob,
    onComplete: () => {
      if (!batchLock.current) return loadTasks(true);
    },
  });

  const changeFilters = next => {
    setSelectedTaskIds([]);
    setPage(1);
    setFilters(next);
  };

  const renderNotes = task => (
    <textarea
      aria-label={`订单 ${task.orderId} 处理备注`}
      className="input min-w-0"
      rows="2"
      maxLength="2000"
      disabled={!can(PERMISSIONS.PAYMENT_TASKS_HANDLE_OWN)}
      value={drafts[task.id]?.notes || ''}
      onChange={event => updateDraft(task.id, 'notes', event.target.value)}
    />
  );
  const renderPayer = task => (
    <input
      aria-label={`订单 ${task.orderId} 付款人`}
      className="input min-w-0"
      type="text"
      maxLength="100"
      placeholder="实际付款人"
      disabled={!can(PERMISSIONS.PAYMENT_TASKS_PAYER_EDIT_OWN)}
      value={drafts[task.id]?.payerName || ''}
      onChange={event => updateDraft(task.id, 'payerName', event.target.value)}
    />
  );
  const renderTime = value => (
    <span className="payment-task-time">
      {value.split(' ').map((part, index) => (
        <span key={index}>{part}</span>
      ))}
    </span>
  );

  return (
    <fieldset disabled={batchSaving} className="payment-tasks min-w-0 space-y-4">
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

      <button
        className="btn btn-secondary md:hidden"
        aria-expanded={showFilters}
        onClick={() => setShowFilters(previous => !previous)}
      >
        <Search className="mr-2 inline w-4 h-4" />
        {showFilters ? '收起筛选' : '筛选任务'}
      </button>
      <form
        className={`card p-4 ${showFilters ? '' : 'hidden md:block'}`}
        onSubmit={event => {
          event.preventDefault();
          changeFilters({ ...filterDrafts });
          setShowFilters(false);
        }}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <input
            className="input"
            placeholder="订单号"
            value={filterDrafts.orderNumber}
            onChange={event =>
              setFilterDrafts(previous => ({
                ...previous,
                orderNumber: event.target.value,
              }))
            }
          />
          <input
            className="input"
            placeholder="商品名称或型号"
            value={filterDrafts.productKeyword}
            onChange={event =>
              setFilterDrafts(previous => ({
                ...previous,
                productKeyword: event.target.value,
              }))
            }
          />
          <TagMultiSelect
            options={recipientTagOptions}
            value={filterDrafts.recipientTags}
            onChange={recipientTags =>
              setFilterDrafts(previous => ({ ...previous, recipientTags }))
            }
          />

          <OfficialStatusFilter
            value={filterDrafts.officialOrderStatuses}
            onChange={officialOrderStatuses =>
              setFilterDrafts(previous => ({ ...previous, officialOrderStatuses }))
            }
          />
          <select
            className="input"
            value={filterDrafts.processingStatus}
            onChange={event =>
              setFilterDrafts(previous => ({
                ...previous,
                processingStatus: event.target.value,
              }))
            }
          >
            <option value="">未完成任务</option>
            <option value="pending">待处理</option>
            <option value="processing">处理中</option>
            <option value="completed">已完成</option>
            <option value="exception">异常</option>
          </select>
          <OrderDateFilter
            dateFrom={filterDrafts.dateFrom}
            dateTo={filterDrafts.dateTo}
            onChange={range => setFilterDrafts(previous => ({ ...previous, ...range }))}
          />
        </div>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button className="btn btn-primary inline-flex items-center gap-2" type="submit">
            <Search className="w-4 h-4" />
            筛选
          </button>
          <button
            className="btn btn-secondary inline-flex items-center gap-2"
            type="button"
            onClick={() => {
              setFilterDrafts(INITIAL_FILTERS);
              changeFilters(INITIAL_FILTERS);
            }}
          >
            <RotateCcw className="w-4 h-4" />
            重置
          </button>
        </div>
      </form>

      {error && (
        <div className="rounded-lg bg-red-50 text-red-700 px-4 py-3 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button className="btn btn-secondary" onClick={() => loadTasks()}>
            重新加载
          </button>
        </div>
      )}
      <div className="card p-0 overflow-hidden" data-has-selection={selectedTasks.length > 0}>
        {canSelectTasks && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
            <div>
              <h2 className="font-semibold text-gray-900">任务列表</h2>
              <p className="mt-1 text-sm text-gray-500">
                已选择 {selectedTaskIds.length} 项（当前页）
              </p>
              {batchCopyAction?.message && (
                <p
                  role="status"
                  className={`mt-1 text-sm ${
                    batchCopyAction.type === 'error'
                      ? 'text-red-600'
                      : batchCopyAction.type === 'success'
                        ? 'text-green-700'
                        : 'text-gray-500'
                  }`}
                >
                  {batchCopyAction.message}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex min-h-[34px] items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-primary"
                  aria-label="全选当前页"
                  checked={tasks.length > 0 && selectedTasks.length === tasks.length}
                  disabled={loading || batchCopyAction?.copying}
                  onChange={event =>
                    setSelectedTaskIds(event.target.checked ? tasks.map(task => task.id) : [])
                  }
                />
                全选本页
              </label>
              {canHandleTasks && (
                <button
                  className="mobile-batch-action btn btn-primary inline-flex items-center gap-2"
                  disabled={
                    loading ||
                    !selectedTasks.length ||
                    Object.values(rowActions).some(action => action.saving)
                  }
                  onClick={() => setBatchEditorOpen(previous => !previous)}
                >
                  <Save className="w-4 h-4" />
                  批量修改处理状态
                </button>
              )}
              {canCopyTaskInfo && (
                <button
                  className="mobile-batch-action btn btn-secondary inline-flex items-center gap-2"
                  disabled={loading || batchCopyAction?.copying || selectedTasks.length === 0}
                  onClick={copySelectedTasks}
                >
                  <Copy className={`w-4 h-4 ${batchCopyAction?.copying ? 'animate-pulse' : ''}`} />
                  {batchCopyAction?.copying ? '复制中...' : '批量复制订单信息'}
                </button>
              )}
              {canRefreshTasks && (
                <button
                  className="mobile-batch-action btn btn-secondary inline-flex items-center gap-2"
                  disabled={
                    loading ||
                    submittingBatch ||
                    !selectedTasks.some(task => !progress[task.id]?.refreshing)
                  }
                  onClick={() => refreshSelected(selectedTasks)}
                >
                  <RefreshCw className={`w-4 h-4 ${submittingBatch ? 'animate-spin' : ''}`} />
                  {submittingBatch ? '提交中...' : '批量刷新'}
                </button>
              )}
            </div>
          </div>
        )}
        {batchEditorOpen && canHandleTasks && (
          <form
            onSubmit={saveSelectedStatuses}
            className="space-y-3 border-b border-blue-100 bg-blue-50 p-4"
          >
            <h3 className="font-medium text-primary">
              修改选中的 {selectedTasks.length} 项人工处理状态
            </h3>
            <label className="block text-sm">
              目标处理状态
              <select
                aria-label="批量目标处理状态"
                className="input mt-1"
                value={batchStatus}
                onChange={event => setBatchStatus(event.target.value)}
              >
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              统一处理备注（选填）
              <textarea
                className="input mt-1"
                rows="2"
                maxLength="2000"
                value={batchNotes}
                onChange={event => setBatchNotes(event.target.value)}
                placeholder="留空保留每单原备注；填写将替换选中单的备注"
              />
            </label>
            <p className="text-sm text-gray-600">
              仅修改人工处理状态。异常、异常恢复或官网未确认付款时完成任务，需要处理备注。逐单提交，可能部分成功；不会提交行内未保存的修改。
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className="btn btn-primary" disabled={!selectedTasks.length}>
                确认修改 {selectedTasks.length} 项
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setBatchEditorOpen(false)}
              >
                取消
              </button>
            </div>
          </form>
        )}
        {batchSaving && (
          <p role="status" className="p-4 text-primary">
            正在逐单修改，请稍候…
          </p>
        )}
        {batchResults.length > 0 && (
          <div role="status" className="p-4 text-sm space-y-1">
            <button className="btn btn-secondary mb-2" onClick={() => loadTasks(true)}>
              重新加载列表
            </button>
            <p>
              批量修改：成功 {batchResults.filter(result => result.success).length} 项，失败{' '}
              {batchResults.filter(result => !result.success).length} 项
            </p>
            {batchResults
              .filter(result => !result.success)
              .map(result => (
                <p key={result.id} className="text-red-600">
                  订单 ID {result.orderId}：{result.message}
                </p>
              ))}
          </div>
        )}
        {loading ? (
          <p className="text-center text-gray-500 py-12">加载中...</p>
        ) : tasks.length === 0 ? (
          <p className="text-center text-gray-500 py-12">暂无匹配的付款任务</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="payment-task-table w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {canSelectTasks && (
                    <th data-column="选择" className="px-4 py-3">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer accent-primary"
                        aria-label="选择当前页全部任务"
                        disabled={batchCopyAction?.copying}
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
                    '金额',
                    'TAG',
                    '下单时间',
                    '官网付款状态',
                    '付款方式',
                    '倒计时',
                    '处理状态',
                    '处理备注',
                    '付款人',
                    '最后爬数时间',
                    '操作',
                  ].map(title => (
                    <th
                      key={title}
                      data-column={title}
                      title={
                        title === '下单时间'
                          ? '北京时间，邮件或人工录入来源；缺失时采用官网精确时间'
                          : undefined
                      }
                      className="text-left px-4 py-3 text-sm font-medium text-gray-500"
                    >
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tasks.map(task => (
                  <Fragment key={task.id}>
                    <tr
                      className={`border-b border-gray-100 align-top hover:bg-gray-50 ${selectedTaskIds.includes(task.id) ? 'mobile-selected' : ''}`}
                    >
                      {canSelectTasks && (
                        <td data-label="选择" className="px-4 py-4 mobile-selection">
                          <input
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer accent-primary"
                            aria-label={`选择订单 ${task.orderNumber}`}
                            disabled={batchCopyAction?.copying}
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
                      <td data-label="订单 / 商品" className="px-4 py-4 mobile-order">
                        <div className="order-system-id mb-1 text-sm font-semibold text-gray-900">
                          订单 ID：{task.orderId ?? '-'}
                        </div>
                        <div className="font-mono text-sm font-medium text-primary">
                          {task.orderNumber}
                        </div>
                        <div className="mt-1 max-w-72 truncate text-xs text-gray-500">
                          {task.products
                            .map(product => `${product.name} ×${product.quantity}`)
                            .join('、')}
                        </div>
                      </td>
                      <td data-label="金额" className="px-4 py-4 text-sm font-medium">
                        {task.officialOrderAmount === null || task.officialOrderAmount === undefined
                          ? '尚未获取'
                          : `${task.officialOrderAmountCurrency === 'CNY' ? '¥' : task.officialOrderAmountCurrency || ''} ${Number.isFinite(Number(task.officialOrderAmount)) ? Number(task.officialOrderAmount).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : task.officialOrderAmount}`}
                      </td>
                      <td data-label="TAG" data-secondary="true" className="px-4 py-4">
                        {task.recipientTag ? (
                          <span
                            className="badge badge-info max-w-48 truncate"
                            title={task.recipientTag}
                          >
                            {task.recipientTag}
                          </span>
                        ) : (
                          <span className="text-sm text-gray-400">-</span>
                        )}
                      </td>
                      <td
                        data-label="下单时间"
                        data-secondary="true"
                        className="px-4 py-4 text-sm text-gray-600"
                      >
                        {renderTime(formatOrderTime(task.orderDate || task.officialOrderCreatedAt))}
                      </td>
                      <td data-label="官网付款状态" className="px-4 py-4 text-sm">
                        <span className={getOfficialStatusTagClass(task.officialPaymentStatus)}>
                          {task.officialPaymentConfirmed
                            ? '官网已确认付款'
                            : {
                                unpaid: '未付款',
                                paid: '已付款',
                                refunded: '已退款',
                                partially_refunded: '部分退款',
                                unknown: '待核对',
                              }[task.officialPaymentStatus] ||
                              task.officialPaymentStatus ||
                              '未知'}
                        </span>
                        {task.officialPaymentDiscrepancy && (
                          <p className="text-xs text-amber-700">人工任务尚未完成</p>
                        )}
                        <div className="hidden md:block text-xs text-gray-400">
                          {ORDER_STATUS_LABELS[task.officialOrderStatus] ||
                            task.officialOrderStatus}
                        </div>
                      </td>
                      <td
                        data-label="付款方式"
                        data-secondary="true"
                        className="px-4 py-4 text-sm text-gray-700"
                      >
                        {task.paymentMethod || '-'}
                      </td>
                      <td
                        data-label="倒计时"
                        data-secondary="true"
                        className={`px-4 py-4 text-sm ${task.remainingSeconds !== null && task.remainingSeconds <= 300 ? 'text-red-600 font-medium' : 'text-gray-700'}`}
                      >
                        {formatCountdown(task.deadlineAt, now, task)}
                      </td>
                      <td data-label="人工处理状态" className="px-4 py-4">
                        <select
                          aria-label={`订单 ${task.orderId} 人工处理状态`}
                          className={`input min-w-0 font-medium ${STATUS_STYLES[drafts[task.id]?.status || task.processingStatus]}`}
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
                      <td data-label="处理备注" data-secondary="true" className="px-4 py-4">
                        {renderNotes(task)}
                      </td>
                      <td data-label="付款人" data-secondary="true" className="px-4 py-4">
                        {renderPayer(task)}
                      </td>
                      <td
                        data-label="最后爬数时间"
                        data-secondary="true"
                        className="px-4 py-4 text-sm text-gray-600"
                      >
                        {renderTime(formatDateTime(task.lastCrawledAt))}
                      </td>
                      <td data-label="操作" className="px-4 py-4">
                        <div className="flex flex-wrap gap-2 items-center">
                          {(can(PERMISSIONS.PAYMENT_TASKS_HANDLE_OWN) ||
                            can(PERMISSIONS.PAYMENT_TASKS_PAYER_EDIT_OWN)) && (
                            <button
                              className="btn btn-primary px-2 inline-flex items-center justify-center gap-2"
                              onClick={() => saveTask(task)}
                              disabled={rowActions[task.id]?.saving}
                              title="保存本行修改"
                              aria-label="保存本行修改"
                            >
                              <Save
                                className={`w-4 h-4 ${rowActions[task.id]?.saving ? 'animate-pulse' : ''}`}
                              />
                              <span className="md:hidden">保存</span>
                            </button>
                          )}
                          {can(PERMISSIONS.PAYMENT_TASKS_LINK_READ_OWN) && (
                            <PaymentCodeButton taskId={task.id} />
                          )}
                          {can(PERMISSIONS.PAYMENT_TASKS_LINK_READ_OWN) && (
                            <button
                              className="btn btn-secondary px-2 inline-flex items-center justify-center gap-2"
                              onClick={() => copyPaymentLink(task)}
                              disabled={rowActions[task.id]?.copying}
                              title="复制订单信息"
                              aria-label="复制订单信息"
                            >
                              <Copy className="w-4 h-4" />
                              <span className="md:hidden">复制</span>
                            </button>
                          )}
                          {can(PERMISSIONS.PAYMENT_TASKS_REFRESH_OWN) && (
                            <button
                              className="btn btn-secondary px-2 inline-flex items-center justify-center gap-2"
                              onClick={() => refreshTask(task)}
                              disabled={progress[task.id]?.refreshing}
                              title="刷新官网状态"
                              aria-label="刷新官网状态"
                            >
                              <RefreshCw
                                className={`w-4 h-4 ${progress[task.id]?.refreshing ? 'animate-spin' : ''}`}
                              />
                              <span className="md:hidden">刷新</span>
                            </button>
                          )}
                        </div>
                        <button
                          type="button"
                          className="payment-task-more btn btn-secondary mt-2 items-center gap-1"
                          aria-expanded={expandedTasks.includes(task.id)}
                          aria-controls={`task-details-${task.id}`}
                          onClick={() =>
                            setExpandedTasks(previous =>
                              previous.includes(task.id)
                                ? previous.filter(id => id !== task.id)
                                : [...previous, task.id]
                            )
                          }
                        >
                          {expandedTasks.includes(task.id) ? '收起' : '更多'}
                          <ChevronDown
                            className={`h-4 w-4 ${expandedTasks.includes(task.id) ? 'rotate-180' : ''}`}
                          />
                        </button>
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
                    {expandedTasks.includes(task.id) && (
                      <tr className="payment-task-details" id={`task-details-${task.id}`}>
                        <td colSpan={(wideDetails ? 9 : 7) + (canSelectTasks ? 1 : 0)}>
                          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
                            <label className="min-w-0 space-y-1">
                              <span className="text-gray-600">处理备注</span>
                              {renderNotes(task)}
                            </label>
                            <label className="min-w-0 space-y-1">
                              <span className="text-gray-600">付款人</span>
                              {renderPayer(task)}
                            </label>
                            <div>
                              <p className="mb-1 text-gray-600">最后爬数时间</p>
                              {renderTime(formatDateTime(task.lastCrawledAt))}
                            </div>
                            <div className="min-[1200px]:hidden break-words">
                              <p className="mb-1 text-gray-600">TAG</p>
                              {task.recipientTag || '-'}
                            </div>
                            <div className="min-[1200px]:hidden">
                              <p className="mb-1 text-gray-600">下单时间</p>
                              {renderTime(
                                formatOrderTime(task.orderDate || task.officialOrderCreatedAt)
                              )}
                            </div>
                            <div className="md:hidden">
                              <p className="mb-1 text-gray-600">付款方式 / 倒计时</p>
                              {task.paymentMethod || '-'} ·{' '}
                              {formatCountdown(task.deadlineAt, now, task)}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
    </fieldset>
  );
}
