import { formatOrderTime } from '../utils/orderTime';
import { getRefreshJob } from '../api/ordersApi';
import Pagination from '../components/Pagination';
import usePaymentRefresh from '../hooks/usePaymentRefresh';
import { getPaymentStageLabel } from '../utils/paymentStage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ListChecks, RefreshCw, RotateCcw, Save, ScanSearch, Search, Users, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';
import {
  assignPaymentTasks,
  getPaymentDispatchOverview,
  getPaymentDispatchTasks,
  refreshPaymentDispatchTask,
  reopenPaymentTask,
  runPaymentDispatchScan,
  updatePaymentDispatchSettings,
  updatePaymentStaffSettings,
} from '../api/paymentDispatchApi';

import { ORDER_STATUS_LABELS as OFFICIAL_STATUS_LABELS } from '../constants/orderStatus';

const STATUS_LABELS = {
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  exception: '异常',
};

const INITIAL_FILTERS = {
  orderNumber: '',
  productKeyword: '',
  assignee: '',
  officialOrderStatus: '',
  processingStatus: '',
};

const BUTTON_LAYOUT_CLASS =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50';
const CHECKBOX_CLASS =
  'h-4 w-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50';
const PROCESSING_STATUS_BADGE_CLASSES = {
  pending: 'badge-warning',
  processing: 'badge-info',
  completed: 'badge-success',
  exception: 'badge-error',
};

function ToggleSwitch({ ariaLabel, checked, disabled, label, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-2 text-sm text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
        disabled ? 'cursor-not-allowed' : 'cursor-pointer'
      }`}
    >
      <span
        className="relative inline-flex h-6 shrink-0 rounded-full border transition-colors duration-200"
        style={{
          width: '2.75rem',
          backgroundColor: checked ? '#1E3A8A' : '#D1D5DB',
          borderColor: checked ? '#1E3A8A' : '#D1D5DB',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <span
          className="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200"
          style={{
            transform: checked ? 'translateX(1.25rem)' : 'translateX(0)',
          }}
        />
      </span>
      {label && <span>{label}</span>}
    </button>
  );
}

function hasStaffChanges(person, staffDraft) {
  return (
    Number(staffDraft?.maxActiveTasks) !== Number(person.maxActiveTasks) ||
    Boolean(staffDraft?.autoAssignEnabled) !== Boolean(person.autoAssignEnabled)
  );
}

function formatDateTime(value) {
  if (!value) return '尚未获取';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '尚未获取';
  const part = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}/${part(date.getMonth() + 1)}/${part(date.getDate())} ${part(
    date.getHours()
  )}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function formatCountdown(deadlineAt, now, task) {
  const stage = getPaymentStageLabel(task);
  if (stage) return { text: stage, className: 'text-gray-600' };
  if (!deadlineAt) return { text: '等待官网时间', className: 'text-gray-500' };
  const seconds = Math.floor((new Date(deadlineAt).getTime() - now.getTime()) / 1000);
  if (seconds <= 0) {
    return {
      text: `已超时 ${Math.max(1, Math.ceil(Math.abs(seconds) / 60))} 分钟`,
      className: 'text-red-500 font-medium',
    };
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return {
    text: `${minutes} 分 ${String(remainingSeconds).padStart(2, '0')} 秒`,
    className: seconds <= 5 * 60 ? 'text-red-600 font-medium' : 'text-gray-700',
  };
}

export default function PaymentDispatch() {
  const { can } = useAuth();
  const [overview, setOverview] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 0 });
  const loadRequest = useRef(0);
  const [staffDrafts, setStaffDrafts] = useState({});
  const [filterDrafts, setFilterDrafts] = useState(INITIAL_FILTERS);
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [selectedTaskIds, setSelectedTaskIds] = useState([]);
  const [assignmentDraft, setAssignmentDraft] = useState({
    assigneeUserId: '',
    handoffConfirmed: false,
    reason: '',
  });
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());
  const [serverTimeOffsetMs, setServerTimeOffsetMs] = useState(0);

  const load = useCallback(
    async (quiet = false) => {
      const request = ++loadRequest.current;
      if (!quiet) setLoading(true);
      setError('');
      try {
        const query = Object.fromEntries(
          Object.entries(filters).filter(([, value]) => value !== '')
        );
        const [overviewResponse, tasksResponse] = await Promise.all([
          getPaymentDispatchOverview(),
          getPaymentDispatchTasks({ ...query, page, limit: pageSize }),
        ]);
        if (request !== loadRequest.current) return;
        setPagination(tasksResponse.data.pagination);
        const lastPage = Math.max(1, tasksResponse.data.pagination.totalPages);
        if (page > lastPage) {
          setSelectedTaskIds([]);
          setPage(lastPage);
          return;
        }
        setOverview(overviewResponse.data);
        setTasks(tasksResponse.data.items);
        const serverTime = new Date(tasksResponse.data.serverTime);
        setNow(serverTime);
        setServerTimeOffsetMs(serverTime.getTime() - Date.now());
        if (!quiet)
          setStaffDrafts(
            Object.fromEntries(
              overviewResponse.data.staff.map(item => [
                item.id,
                {
                  autoAssignEnabled: item.autoAssignEnabled,
                  maxActiveTasks: item.maxActiveTasks,
                },
              ])
            )
          );
        const visibleIds = new Set(tasksResponse.data.items.map(item => item.id));
        setSelectedTaskIds(previous => previous.filter(id => visibleIds.has(id)));
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
    load();
  }, [load]);
  const loadCurrent = useRef(load);
  loadCurrent.current = load;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date(Date.now() + serverTimeOffsetMs));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [serverTimeOffsetMs]);

  const { progress, refreshTask, refreshSelected, submittingBatch } = usePaymentRefresh({
    submit: refreshPaymentDispatchTask,
    getJob: (_taskId, jobId) => getRefreshJob(jobId),
    onComplete: () => load(true),
  });
  const changeFilters = next => {
    setSelectedTaskIds([]);
    setPage(1);
    setFilters(next);
  };

  const selectedTasks = useMemo(
    () => tasks.filter(task => selectedTaskIds.includes(task.id)),
    [selectedTaskIds, tasks]
  );
  const assignmentHasTransfer = useMemo(() => {
    const assigneeUserId = Number(assignmentDraft.assigneeUserId);
    if (!assigneeUserId) return false;
    return selectedTasks.some(task => task.assignee && Number(task.assignee.id) !== assigneeUserId);
  }, [assignmentDraft.assigneeUserId, selectedTasks]);
  const allVisibleSelected = tasks.length > 0 && selectedTaskIds.length === tasks.length;

  const runAction = async (actionKey, action, successMessage) => {
    setError('');
    setNotice('');
    setBusyAction(actionKey);
    try {
      await action();
      if (successMessage) setNotice(successMessage);
      await loadCurrent.current();
      return true;
    } catch (actionError) {
      setError(actionError.message);
      return false;
    } finally {
      setBusyAction('');
    }
  };

  const toggleTask = taskId => {
    setSelectedTaskIds(previous =>
      previous.includes(taskId) ? previous.filter(id => id !== taskId) : [...previous, taskId]
    );
  };

  const openAssignmentModal = () => {
    if (selectedTaskIds.length === 0) return;
    setError('');
    setAssignmentDraft({
      assigneeUserId: '',
      handoffConfirmed: false,
      reason: '',
    });
    setAssignModalOpen(true);
  };

  const confirmAssignment = async () => {
    const assigneeUserId = Number(assignmentDraft.assigneeUserId);
    if (!assigneeUserId) {
      setError('请选择负责人');
      return;
    }
    if (
      assignmentHasTransfer &&
      (!assignmentDraft.handoffConfirmed || !assignmentDraft.reason.trim())
    ) {
      setError('批量中包含转派任务，请确认原负责人已停止并填写转派原因');
      return;
    }
    const succeeded = await runAction(
      'assign-selected',
      () =>
        assignPaymentTasks(
          {
            tasks: selectedTasks.map(task => ({
              id: task.id,
              expectedVersion: task.version,
            })),
            assigneeUserId,
            handoffConfirmed: assignmentHasTransfer ? assignmentDraft.handoffConfirmed : false,
            reason: assignmentHasTransfer ? assignmentDraft.reason.trim() : undefined,
          },
          crypto.randomUUID()
        ),
      `已分配 ${selectedTasks.length} 个付款任务`
    );
    if (succeeded) {
      setSelectedTaskIds([]);
      setAssignModalOpen(false);
    }
  };

  if (loading && !overview)
    return <div className="card text-center text-gray-500 py-12">加载中...</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
          <ListChecks className="w-6 h-6 text-primary" />
          付款任务调度
        </h1>
        <p className="text-sm text-gray-500 mt-1">配置任务范围、人员容量并完成批量分配</p>
      </div>
      {error && (
        <div className="rounded-lg bg-red-50 text-red-700 px-4 py-3 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button className="btn btn-secondary" onClick={() => load()}>
            重新加载
          </button>
        </div>
      )}
      {notice && <div className="rounded-lg bg-green-50 text-green-700 px-4 py-3">{notice}</div>}

      <div className="card hover:shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h2 className="font-semibold text-gray-900">全局调度</h2>
            <p className="text-sm text-gray-500 mt-1">
              范围启用时间：
              {overview?.settings.scopeStartedAt
                ? formatDateTime(overview.settings.scopeStartedAt)
                : '未启用'}
            </p>
          </div>
          <div className="flex flex-wrap gap-3 items-center">
            <ToggleSwitch
              label="启用新订单纳入"
              disabled={!can(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE)}
              checked={Boolean(overview?.settings.enabled)}
              onChange={enabled =>
                setOverview(previous => ({
                  ...previous,
                  settings: {
                    ...previous.settings,
                    enabled,
                  },
                }))
              }
            />
            <select
              className="input w-32"
              disabled={!can(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE)}
              value={overview?.settings.mode || 'manual'}
              onChange={event =>
                setOverview(previous => ({
                  ...previous,
                  settings: { ...previous.settings, mode: event.target.value },
                }))
              }
            >
              <option value="manual">手动</option>
              <option value="auto">自动</option>
            </select>
            {can(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE) && (
              <button
                className={`btn btn-primary ${BUTTON_LAYOUT_CLASS}`}
                disabled={Boolean(busyAction)}
                onClick={() =>
                  runAction(
                    'save-settings',
                    () =>
                      updatePaymentDispatchSettings({
                        enabled: overview.settings.enabled,
                        mode: overview.settings.mode,
                        expectedVersion: overview.settings.version,
                      }),
                    '全局调度设置已保存'
                  )
                }
              >
                <Save className="w-4 h-4" />
                {busyAction === 'save-settings' ? '保存中...' : '保存设置'}
              </button>
            )}
            {can(PERMISSIONS.PAYMENT_DISPATCH_ASSIGN) && (
              <button
                className={`btn btn-secondary ${BUTTON_LAYOUT_CLASS}`}
                disabled={Boolean(busyAction)}
                onClick={() => runAction('scan', runPaymentDispatchScan, '调度扫描已完成')}
              >
                <ScanSearch className="w-4 h-4" />
                {busyAction === 'scan' ? '扫描中...' : '立即扫描'}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card p-0 overflow-hidden hover:shadow-sm">
        <div className="px-5 py-4 border-b border-gray-200">
          <h2 className="font-semibold">人员与容量</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead className="bg-gray-50">
              <tr>
                {['用户', '权限完整', '当前负载', '上限', '自动接单', '操作'].map(title => (
                  <th
                    key={title}
                    title={
                      title === '下单时间'
                        ? '北京时间，邮件或人工录入来源；缺失时采用官网精确时间'
                        : undefined
                    }
                    className={`px-4 py-3 text-sm font-medium text-gray-500 ${
                      title === '操作' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {overview?.staff.map(person => (
                <tr
                  key={person.id}
                  className="border-t border-gray-100 transition-colors hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium">
                    {person.nickname || person.username}（{person.username}）
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`badge ${person.hasExecutionPermissions ? 'badge-success' : 'badge-warning'}`}
                    >
                      {person.hasExecutionPermissions ? '完整' : '缺失'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {person.activeCount} / {person.maxActiveTasks}
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="number"
                      min="0"
                      max="1000"
                      className="input w-24"
                      disabled={!can(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE)}
                      value={staffDrafts[person.id]?.maxActiveTasks ?? 0}
                      onChange={event =>
                        setStaffDrafts(previous => ({
                          ...previous,
                          [person.id]: {
                            ...previous[person.id],
                            maxActiveTasks: Number(event.target.value),
                          },
                        }))
                      }
                    />
                  </td>
                  <td className="px-4 py-3">
                    <ToggleSwitch
                      ariaLabel={`允许 ${person.nickname || person.username}（${person.username}） 自动接单`}
                      disabled={!can(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE)}
                      checked={Boolean(staffDrafts[person.id]?.autoAssignEnabled)}
                      onChange={autoAssignEnabled =>
                        setStaffDrafts(previous => ({
                          ...previous,
                          [person.id]: {
                            ...previous[person.id],
                            autoAssignEnabled,
                          },
                        }))
                      }
                    />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {can(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE) && (
                      <button
                        className={`btn btn-secondary px-3 py-1.5 text-sm ${BUTTON_LAYOUT_CLASS}`}
                        disabled={
                          Boolean(busyAction) || !hasStaffChanges(person, staffDrafts[person.id])
                        }
                        onClick={() =>
                          runAction(
                            `staff-${person.id}`,
                            () =>
                              updatePaymentStaffSettings(person.id, {
                                ...staffDrafts[person.id],
                                expectedVersion: person.version,
                              }),
                            `${person.nickname || person.username}（${person.username}） 的接单设置已保存`
                          )
                        }
                      >
                        {busyAction === `staff-${person.id}` ? '保存中...' : '保存'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-0 overflow-hidden hover:shadow-sm">
        <div className="px-5 py-4 border-b border-gray-200 space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <h2 className="font-semibold">任务队列</h2>
              <p className="text-sm text-gray-500 mt-1">
                已选择 {selectedTaskIds.length} 项（当前页）
              </p>
            </div>
            {can(PERMISSIONS.PAYMENT_DISPATCH_ASSIGN) && (
              <div className="flex flex-wrap gap-2">
                <button
                  className={`btn btn-secondary ${BUTTON_LAYOUT_CLASS}`}
                  disabled={
                    loading ||
                    submittingBatch ||
                    Boolean(busyAction) ||
                    !selectedTasks.some(task => !progress[task.id]?.refreshing)
                  }
                  onClick={() => {
                    setNotice('');
                    refreshSelected(selectedTasks);
                  }}
                >
                  <RefreshCw className={`w-4 h-4 ${submittingBatch ? 'animate-spin' : ''}`} />
                  {submittingBatch ? '提交中...' : '批量刷新'}
                </button>
                <button
                  className={`btn btn-primary ${BUTTON_LAYOUT_CLASS}`}
                  disabled={loading || selectedTaskIds.length === 0 || Boolean(busyAction)}
                  onClick={openAssignmentModal}
                >
                  <Users className="w-4 h-4" />
                  分配所选订单
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
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
            <select
              className="input"
              value={filterDrafts.assignee}
              onChange={event =>
                setFilterDrafts(previous => ({
                  ...previous,
                  assignee: event.target.value,
                }))
              }
            >
              <option value="">全部负责人</option>
              <option value="unassigned">未分配</option>
              {overview?.staff.map(person => (
                <option key={person.id} value={person.id}>
                  {person.nickname || person.username}（{person.username}）
                </option>
              ))}
            </select>
            <select
              className="input"
              value={filterDrafts.officialOrderStatus}
              onChange={event =>
                setFilterDrafts(previous => ({
                  ...previous,
                  officialOrderStatus: event.target.value,
                }))
              }
            >
              <option value="">全部官网状态</option>
              {Object.entries(OFFICIAL_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
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
              <option value="">全部处理状态</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <div className="col-span-full flex justify-end gap-2">
              <button
                className={`btn btn-primary ${BUTTON_LAYOUT_CLASS}`}
                onClick={() => changeFilters({ ...filterDrafts })}
              >
                <Search className="w-4 h-4" />
                筛选
              </button>
              <button
                className={`btn btn-secondary ${BUTTON_LAYOUT_CLASS}`}
                onClick={() => {
                  setFilterDrafts(INITIAL_FILTERS);
                  changeFilters(INITIAL_FILTERS);
                }}
              >
                <RotateCcw className="w-4 h-4" />
                重置
              </button>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1660px]">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left">
                  <input
                    type="checkbox"
                    className={CHECKBOX_CLASS}
                    aria-label="选择当前页全部任务"
                    disabled={loading}
                    ref={element => {
                      if (element)
                        element.indeterminate =
                          selectedTaskIds.length > 0 && selectedTaskIds.length < tasks.length;
                    }}
                    checked={allVisibleSelected}
                    onChange={event =>
                      setSelectedTaskIds(event.target.checked ? tasks.map(task => task.id) : [])
                    }
                  />
                </th>
                {[
                  '订单 / 商品',
                  '下单时间',
                  '官网状态',
                  '付款方式',
                  '处理状态',
                  '负责人',
                  '付款倒计时',
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
                    className={`px-4 py-3 text-sm font-medium text-gray-500 ${
                      title === '操作' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!loading &&
                tasks.map(task => {
                  const countdown = formatCountdown(task.deadlineAt, now, task);
                  return (
                    <tr
                      key={task.id}
                      className="border-t border-gray-100 transition-colors hover:bg-gray-50"
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          className={CHECKBOX_CLASS}
                          aria-label={`选择订单 ${task.orderNumber}`}
                          checked={selectedTaskIds.includes(task.id)}
                          onChange={() => toggleTask(task.id)}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{task.orderNumber}</div>
                        <div className="text-xs text-gray-500 max-w-72 truncate">
                          {task.products
                            .map(product => `${product.name || ''} ${product.model || ''}`.trim())
                            .join('、') || '无商品信息'}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                        {formatOrderTime(task.orderDate || task.officialOrderCreatedAt)}
                      </td>
                      <td className="px-4 py-3">
                        {OFFICIAL_STATUS_LABELS[task.officialOrderStatus] ||
                          task.officialOrderStatus ||
                          '未知'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">
                        {task.paymentMethod || '-'}
                        {task.officialPaymentDiscrepancy && (
                          <p className="text-xs text-amber-700 mt-1">
                            官网已收款，人工任务尚未完成
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`badge ${
                            PROCESSING_STATUS_BADGE_CLASSES[task.processingStatus] ||
                            'bg-gray-100 text-gray-700'
                          }`}
                        >
                          {STATUS_LABELS[task.processingStatus] || task.processingStatus || '未知'}
                        </span>
                      </td>
                      <td className="px-4 py-3">{task.assignee?.username || '未分配'}</td>
                      <td className={`px-4 py-3 ${countdown.className}`}>{countdown.text}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {formatDateTime(task.lastCrawledAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          {can(PERMISSIONS.PAYMENT_DISPATCH_ASSIGN) && (
                            <button
                              className={`btn btn-secondary px-3 py-1.5 text-sm ${BUTTON_LAYOUT_CLASS}`}
                              disabled={progress[task.id]?.refreshing}
                              aria-label={`刷新官网状态 ${task.orderNumber}`}
                              onClick={() => {
                                setNotice('');
                                refreshTask(task);
                              }}
                            >
                              <RefreshCw
                                className={`w-4 h-4 ${progress[task.id]?.refreshing ? 'animate-spin' : ''}`}
                              />
                              {progress[task.id]?.status === 'submitting'
                                ? '提交中...'
                                : progress[task.id]?.status === 'pending'
                                  ? '排队中'
                                  : progress[task.id]?.status === 'running'
                                    ? '刷新中...'
                                    : '刷新'}
                            </button>
                          )}
                          {can(PERMISSIONS.PAYMENT_DISPATCH_CORRECT) &&
                            task.processingStatus === 'completed' && (
                              <button
                                className={`btn btn-secondary px-3 py-1.5 text-sm ${BUTTON_LAYOUT_CLASS}`}
                                disabled={Boolean(busyAction)}
                                onClick={() => {
                                  const reason = window.prompt('请输入重开原因');
                                  if (reason)
                                    runAction(
                                      `reopen-${task.id}`,
                                      () =>
                                        reopenPaymentTask(
                                          task.id,
                                          {
                                            reason,
                                            expectedVersion: task.version,
                                          },
                                          crypto.randomUUID()
                                        ),
                                      `订单 ${task.orderNumber} 已重开为异常`
                                    );
                                }}
                              >
                                重开为异常
                              </button>
                            )}
                        </div>
                        {progress[task.id]?.message && (
                          <p
                            role="status"
                            className={`mt-2 text-xs ${progress[task.id].type === 'error' ? 'text-red-600' : progress[task.id].type === 'success' ? 'text-green-700' : 'text-gray-500'}`}
                          >
                            {progress[task.id].message}
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              {loading && (
                <tr>
                  <td colSpan="10" className="px-4 py-12 text-center text-gray-500">
                    加载中...
                  </td>
                </tr>
              )}
              {!loading && tasks.length === 0 && (
                <tr>
                  <td colSpan="10" className="px-4 py-12 text-center text-gray-500">
                    没有符合条件的付款任务
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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

      {assignModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
          <div className="w-full rounded-xl bg-white shadow-xl" style={{ maxWidth: '28rem' }}>
            <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-gray-900">批量分配付款任务</h2>
                <p className="text-sm text-gray-500 mt-1">共选择 {selectedTasks.length} 个订单</p>
              </div>
              <button
                className={`btn btn-secondary p-2 ${BUTTON_LAYOUT_CLASS}`}
                aria-label="关闭批量分配弹窗"
                onClick={() => setAssignModalOpen(false)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {error && (
                <div className="rounded-lg bg-red-50 text-red-700 px-4 py-3 flex items-center justify-between gap-3">
                  <span>{error}</span>
                  <button className="btn btn-secondary" onClick={() => load()}>
                    重新加载
                  </button>
                </div>
              )}
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 mb-2">负责人</span>
                <select
                  className="input w-full"
                  value={assignmentDraft.assigneeUserId}
                  onChange={event =>
                    setAssignmentDraft(previous => ({
                      ...previous,
                      assigneeUserId: event.target.value,
                    }))
                  }
                >
                  <option value="">请选择负责人</option>
                  {overview?.staff
                    .filter(person => person.hasExecutionPermissions)
                    .map(person => (
                      <option key={person.id} value={person.id}>
                        {person.nickname || person.username}（{person.username}）（剩余容量{' '}
                        {person.remainingCapacity}）
                      </option>
                    ))}
                </select>
              </label>
              {assignmentHasTransfer && (
                <>
                  <label className="block">
                    <span className="block text-sm font-medium text-gray-700 mb-2">转派原因</span>
                    <textarea
                      className="input w-full min-h-24"
                      maxLength="500"
                      value={assignmentDraft.reason}
                      onChange={event =>
                        setAssignmentDraft(previous => ({
                          ...previous,
                          reason: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="flex items-start gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      className={`${CHECKBOX_CLASS} mt-1`}
                      checked={assignmentDraft.handoffConfirmed}
                      onChange={event =>
                        setAssignmentDraft(previous => ({
                          ...previous,
                          handoffConfirmed: event.target.checked,
                        }))
                      }
                    />
                    已确认原负责人停止处理所选转派订单
                  </label>
                </>
              )}
            </div>
            <div className="px-5 py-4 border-t border-gray-200 flex justify-end gap-2">
              <button
                className={`btn btn-secondary ${BUTTON_LAYOUT_CLASS}`}
                onClick={() => setAssignModalOpen(false)}
              >
                取消
              </button>
              <button
                className={`btn btn-primary ${BUTTON_LAYOUT_CLASS}`}
                disabled={busyAction === 'assign-selected'}
                onClick={confirmAssignment}
              >
                {busyAction === 'assign-selected' ? '分配中...' : '确认分配'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
