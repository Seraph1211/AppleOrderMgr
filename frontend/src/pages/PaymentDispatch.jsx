import ResponsiveSelect from '../components/responsiveSelect';
import OrderAmount from '../components/OrderAmount';
import PaymentAssignmentModal from '../components/PaymentAssignmentModal';
import PaymentCodeButton from '../components/PaymentCodeButton';
import AlipayPaymentLinkButton from '../components/AlipayPaymentLinkButton';
import AutoDismissToast from '../components/AutoDismissToast';
import OrderDateFilter from '../components/OrderDateFilter';
import ProductFilter from '../components/ProductFilter';
import ProductSummary from '../components/ProductSummary';
import EmailStatusFilter from '../components/EmailStatusFilter';
import ProcessingStatusFilter from '../components/ProcessingStatusFilter';
import PaymentNotesModal from '../components/PaymentNotesModal';
import { copyDeferredText } from '../utils/copyDeferredText';
import { readPaymentCopyText } from '../utils/paymentCopySource';
import { getPaymentDispatchCode } from '../api/paymentCodesApi';
import OrderLinkCopyButton from '../components/OrderLinkCopyButton';
import PendingPaymentOverviewModal from '../components/PendingPaymentOverviewModal';
import PaymentTagRulesModal from '../components/PaymentTagRulesModal';
import { formatOrderTime } from '../utils/orderTime';
import Pagination from '../components/Pagination';
import TagMultiSelect from '../components/TagMultiSelect';
import { formatPaymentCountdown } from '../utils/paymentCountdown';
import { isAlipayPayment } from '../utils/paymentMethod';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  ListChecks,
  Pencil,
  RotateCcw,
  Save,
  ScanSearch,
  Search,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';
import {
  getPaymentDispatchAlipayLink,
  getPaymentDispatchLink,
  getPaymentDispatchOverview,
  getPaymentDispatchTasks,
  runPaymentDispatchScan,
  updatePaymentDispatchTaskNotes,
  updatePaymentDispatchSettings,
  updatePaymentStaffSettingsBatch,
} from '../api/paymentDispatchApi';

import { getEmailOrderStatusBadge } from '../constants/orderStatus';

const STATUS_LABELS = {
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  exception: '异常',
};

const INITIAL_FILTERS = {
  orderNumber: '',
  productKeys: [],
  recipientTags: [],
  assignee: '',
  emailOrderStatuses: [],
  dateFrom: '',
  dateTo: '',
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

export default function PaymentDispatch() {
  const { can } = useAuth();
  const canCorrectTasks = can(PERMISSIONS.PAYMENT_DISPATCH_CORRECT);
  const [pendingOverviewOpen, setPendingOverviewOpen] = useState(false);
  const [overview, setOverview] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 0 });
  const [productOptions, setProductOptions] = useState([]);
  const [recipientTagOptions, setRecipientTagOptions] = useState([]);
  const loadRequest = useRef(0);
  const [staffDrafts, setStaffDrafts] = useState({});
  const [staffRows, setStaffRows] = useState([]);
  const [staffModalOpen, setStaffModalOpen] = useState(false);
  const [tagRulesOpen, setTagRulesOpen] = useState(false);
  const [staffError, setStaffError] = useState('');
  const [filterDrafts, setFilterDrafts] = useState(INITIAL_FILTERS);
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [selectedTaskIds, setSelectedTaskIds] = useState([]);
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [copyingIds, setCopyingIds] = useState([]);
  const copyLock = useRef(false);
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());
  const [serverTimeOffsetMs, setServerTimeOffsetMs] = useState(0);
  const [notesModalTask, setNotesModalTask] = useState(null);
  const [notesModalSaving, setNotesModalSaving] = useState(false);
  const [notesModalError, setNotesModalError] = useState('');
  const [toast, setToast] = useState(null);

  const showToast = useCallback((type, message) => {
    if (message) setToast({ id: Date.now(), type, message });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);
  const closeNotesModal = useCallback(() => {
    if (notesModalSaving) return;
    setNotesModalTask(null);
    setNotesModalError('');
  }, [notesModalSaving]);

  const load = useCallback(
    async (quiet = false) => {
      const request = ++loadRequest.current;
      if (!quiet) setLoading(true);
      setError('');
      try {
        const query = Object.fromEntries(
          Object.entries(filters).filter(([, value]) =>
            Array.isArray(value) ? value.length > 0 : value !== ''
          )
        );
        if (query.productKeys) query.productKeys = JSON.stringify(query.productKeys);
        if (query.recipientTags) query.recipientTags = JSON.stringify(query.recipientTags);
        if (query.emailOrderStatuses)
          query.emailOrderStatuses = JSON.stringify(query.emailOrderStatuses);
        const [overviewResponse, tasksResponse] = await Promise.all([
          getPaymentDispatchOverview(),
          getPaymentDispatchTasks({ ...query, page, limit: pageSize }),
        ]);
        if (request !== loadRequest.current) return;
        setPagination(tasksResponse.data.pagination);
        setProductOptions(tasksResponse.data.productOptions || []);
        setRecipientTagOptions(tasksResponse.data.recipientTagOptions || []);
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
  useEffect(() => {
    if (error) showToast('error', error);
  }, [error, showToast]);
  useEffect(() => {
    if (notice) showToast('success', notice);
  }, [notice, showToast]);
  const loadCurrent = useRef(load);
  loadCurrent.current = load;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date(Date.now() + serverTimeOffsetMs));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [serverTimeOffsetMs]);

  const changeFilters = next => {
    setSelectedTaskIds([]);
    setPage(1);
    setFilters(next);
  };

  const selectedTasks = useMemo(
    () => tasks.filter(task => selectedTaskIds.includes(task.id)),
    [selectedTaskIds, tasks]
  );
  const copyTasks = async items => {
    if (!items.length || copyLock.current) return;
    copyLock.current = true;
    setCopyingIds(items.map(item => item.id));
    setError('');
    setNotice('');
    try {
      await copyDeferredText(async () => {
        try {
          const lines = [];
          for (let index = 0; index < items.length; index += 5) {
            const chunk = await Promise.all(
              items
                .slice(index, index + 5)
                .map(task =>
                  readPaymentCopyText(task, getPaymentDispatchCode, getPaymentDispatchLink)
                )
            );
            lines.push(...chunk);
          }
          return lines.join('\n\n');
        } catch (copyError) {
          throw new Error(`订单信息读取失败：${copyError.message}`);
        }
      });
      setNotice(`已复制 ${items.length} 条订单信息`);
    } catch (copyError) {
      setError(`复制失败：${copyError.message}`);
    } finally {
      copyLock.current = false;
      setCopyingIds([]);
    }
  };

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

  const saveTaskNotes = async notes => {
    if (!notesModalTask || notesModalSaving) return;
    const task = notesModalTask;
    const processingNotes = String(notes || '').trim();
    if (processingNotes === (task.processingNotes || '')) {
      showToast('info', '处理备注没有变化');
      closeNotesModal();
      return;
    }
    setNotesModalSaving(true);
    setNotesModalError('');
    setError('');
    setNotice('');
    try {
      const response = await updatePaymentDispatchTaskNotes(
        task.id,
        { processingNotes, expectedVersion: task.version },
        crypto.randomUUID()
      );
      setTasks(previous =>
        previous.map(item => (item.id === task.id ? { ...item, ...response.data } : item))
      );
      setNotesModalTask(null);
      setNotice('处理备注已保存');
    } catch (saveError) {
      setNotesModalError(saveError.message);
      setError(saveError.message);
    } finally {
      setNotesModalSaving(false);
    }
  };

  const toggleTask = taskId => {
    setSelectedTaskIds(previous =>
      previous.includes(taskId) ? previous.filter(id => id !== taskId) : [...previous, taskId]
    );
  };

  const openAssignmentModal = () => {
    if (selectedTaskIds.length) setAssignModalOpen(true);
  };

  const changedStaff = staffRows.filter(person => hasStaffChanges(person, staffDrafts[person.id]));
  const openStaffSettings = () => {
    const rows = overview?.staff || [];
    setStaffRows(rows);
    setStaffDrafts(
      Object.fromEntries(
        rows.map(person => [
          person.id,
          {
            maxActiveTasks: person.maxActiveTasks,
            autoAssignEnabled: person.autoAssignEnabled,
            expectedVersion: person.version,
          },
        ])
      )
    );
    setStaffError('');
    setStaffModalOpen(true);
  };
  const saveStaffSettings = async event => {
    event.preventDefault();
    if (!changedStaff.length || busyAction) return;
    setBusyAction('staff-batch');
    setStaffError('');
    try {
      await updatePaymentStaffSettingsBatch(
        changedStaff.map(person => ({
          userId: person.id,
          ...staffDrafts[person.id],
          maxActiveTasks: Number(staffDrafts[person.id].maxActiveTasks),
        }))
      );
      setStaffModalOpen(false);
      setNotice(`已保存 ${changedStaff.length} 人的接单设置`);
      await loadCurrent.current();
    } catch (saveError) {
      setStaffError(
        `${saveError.message}。保存未确认，草稿已保留。如配置已被他人修改，请取消后刷新页面重试。`
      );
    } finally {
      setBusyAction('');
    }
  };
  useEffect(() => {
    if (!staffModalOpen) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape' && !busyAction) setStaffModalOpen(false);
      if (event.key === 'Tab') {
        const dialog = document.getElementById('staff-modal-title')?.closest('[role="dialog"]');
        const focusable = Array.from(
          dialog?.querySelectorAll('button:not(:disabled), input:not(:disabled)') || []
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [staffModalOpen, busyAction]);

  if (loading && !overview)
    return <div className="card text-center text-gray-500 py-12">加载中...</div>;

  return (
    <div className="space-y-6">
      <AutoDismissToast toast={toast} onDismiss={dismissToast} />
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
            <ListChecks className="w-6 h-6 text-primary" />
            付款任务调度
          </h1>
          <p className="text-sm text-gray-500 mt-1">配置任务范围、人员容量并完成批量分配</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className={`btn btn-primary ${BUTTON_LAYOUT_CLASS}`}
            onClick={() => setPendingOverviewOpen(true)}
          >
            <ListChecks className="w-4 h-4" />
            全局待付款概览
          </button>
          <button
            className={`btn btn-secondary ${BUTTON_LAYOUT_CLASS}`}
            disabled={loading || Boolean(busyAction)}
            onClick={openStaffSettings}
          >
            <Users className="w-4 h-4" />
            人员与容量
          </button>
        </div>
        {pendingOverviewOpen && (
          <PendingPaymentOverviewModal onClose={() => setPendingOverviewOpen(false)} />
        )}
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
            <ResponsiveSelect
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
            </ResponsiveSelect>
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
            {can(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE) && (
              <button
                className={`btn btn-secondary ${BUTTON_LAYOUT_CLASS}`}
                disabled={Boolean(busyAction)}
                onClick={() => setTagRulesOpen(true)}
              >
                TAG 分配规则
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

      <div className="card p-0 overflow-visible hover:shadow-sm">
        <div className="px-5 py-4 border-b border-gray-200 space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <h2 className="font-semibold">任务队列</h2>
              <p className="text-sm text-gray-500 mt-1">
                已选择 {selectedTaskIds.length} 项（当前页）
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {can(PERMISSIONS.PAYMENT_DISPATCH_READ) && (
                <button
                  className={`btn btn-secondary ${BUTTON_LAYOUT_CLASS}`}
                  disabled={loading || copyingIds.length > 0 || selectedTasks.length === 0}
                  onClick={() => copyTasks(selectedTasks)}
                >
                  <Copy className="w-4 h-4" />
                  {copyingIds.length > 1 ? '复制中...' : '批量复制订单信息'}
                </button>
              )}
              {can(PERMISSIONS.PAYMENT_DISPATCH_ASSIGN) && (
                <div className="flex flex-wrap gap-2">
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
          </div>

          <div className="payment-filter-fields">
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
            <div className="payment-filter-product">
              <ProductFilter
                options={productOptions}
                value={filters.productKeys}
                onChange={productKeys => {
                  setFilterDrafts(previous => ({ ...previous, productKeys }));
                  changeFilters({ ...filters, productKeys });
                }}
              />
            </div>
            <TagMultiSelect
              options={recipientTagOptions}
              value={filterDrafts.recipientTags}
              onChange={recipientTags =>
                setFilterDrafts(previous => ({ ...previous, recipientTags }))
              }
            />
            <ResponsiveSelect
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
            </ResponsiveSelect>

            <EmailStatusFilter
              value={filterDrafts.emailOrderStatuses}
              onChange={emailOrderStatuses =>
                setFilterDrafts(previous => ({
                  ...previous,
                  emailOrderStatuses,
                }))
              }
            />
            <ProcessingStatusFilter
              value={filterDrafts.processingStatus}
              onChange={processingStatus =>
                setFilterDrafts(previous => ({
                  ...previous,
                  processingStatus,
                }))
              }
            />
          </div>
          <div className="payment-filter-footer">
            <OrderDateFilter
              dateFrom={filterDrafts.dateFrom}
              dateTo={filterDrafts.dateTo}
              onChange={range => setFilterDrafts(previous => ({ ...previous, ...range }))}
            />
            <div className="payment-filter-submit">
              {JSON.stringify(filterDrafts) !== JSON.stringify(filters) && (
                <span className="text-sm text-amber-700">其他条件待应用，请点击筛选</span>
              )}
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
          <table className="w-full min-w-[2160px]">
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
                  '订单',
                  '商品信息',
                  'TAG',
                  '下单时间',
                  '邮件状态',
                  '付款方式',
                  '处理状态',
                  '负责人',
                  '付款倒计时',
                  '处理备注',
                  '数据更新时间',
                  '操作',
                ].map(title => (
                  <th
                    key={title}
                    title={title === '下单时间' ? '北京时间，邮件或人工录入来源' : undefined}
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
                  const countdown = formatPaymentCountdown(task, now);
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
                        <div className="mb-1 text-sm font-semibold text-gray-900">
                          订单 ID：{task.orderId ?? '-'}
                        </div>
                        <OrderLinkCopyButton
                          task={task}
                          getLink={getPaymentDispatchLink}
                          onResult={(type, message) => {
                            setError(type === 'error' ? message : '');
                            setNotice(type === 'success' ? message : '');
                          }}
                        />
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">
                        <div className="max-w-96 break-words">
                          <ProductSummary
                            products={task.products}
                            selectedKeys={filters.productKeys}
                          />
                          <OrderAmount amount={task.orderAmount} compact />
                        </div>
                      </td>
                      <td className="px-4 py-3">
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
                      <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                        {formatOrderTime(task.orderDate)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`badge ${getEmailOrderStatusBadge(task.emailOrderStatus).class}`}
                        >
                          {getEmailOrderStatusBadge(task.emailOrderStatus).text}
                        </span>
                        <p className="mt-2 text-xs text-gray-600">
                          {task.emailPaymentStatus === 'paid' ? '已付款' : '付款待确认'}
                        </p>
                        {task.emailStatusNeedsReview && (
                          <p className="mt-1 text-xs text-amber-700">邮件结论待核对</p>
                        )}
                        {task.paymentAssignmentHoldReason && (
                          <p className="mt-1 text-xs text-amber-700">历史付款限制：禁止重新分配</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">
                        {task.paymentMethod || '-'}
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
                      <td className="px-4 py-3">
                        {task.assignee?.username || '未分配'}
                        {task.autoAssignment && (
                          <div className="text-xs mt-1 max-w-52 space-y-1">
                            {task.autoAssignment.ruleName && (
                              <p className="text-primary break-words">
                                规则：{task.autoAssignment.ruleName}
                              </p>
                            )}
                            <p className="text-gray-500 break-words">
                              {task.autoAssignment.reason}
                            </p>
                          </div>
                        )}
                      </td>
                      <td className={`px-4 py-3 ${countdown.className}`}>{countdown.text}</td>
                      <td className="px-4 py-3">
                        <p className="max-w-80 whitespace-pre-wrap break-words text-sm text-gray-700">
                          {task.processingNotes || '-'}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {formatDateTime(task.emailLifecycleUpdatedAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="payment-dispatch-actions">
                          {can(PERMISSIONS.PAYMENT_DISPATCH_READ) &&
                            (isAlipayPayment(task.paymentMethod) ? (
                              <AlipayPaymentLinkButton
                                task={task}
                                getLink={getPaymentDispatchAlipayLink}
                                onResult={showToast}
                              />
                            ) : (
                              <PaymentCodeButton
                                taskId={task.id}
                                orderDate={task.orderDate}
                                dispatch
                              />
                            ))}
                          {can(PERMISSIONS.PAYMENT_DISPATCH_READ) && (
                            <button
                              className={`btn btn-secondary px-3 py-1.5 text-sm ${BUTTON_LAYOUT_CLASS}`}
                              disabled={copyingIds.length > 0}
                              aria-label={`复制订单信息 ${task.orderNumber}`}
                              onClick={() => copyTasks([task])}
                            >
                              <Copy className="w-4 h-4" />
                              {copyingIds.includes(task.id) ? '复制中...' : '复制订单信息'}
                            </button>
                          )}
                          {canCorrectTasks && (
                            <button
                              className={`btn btn-secondary px-3 py-1.5 text-sm ${BUTTON_LAYOUT_CLASS}`}
                              aria-label={`修改备注 订单 ${task.orderId}`}
                              onClick={() => {
                                setNotesModalError('');
                                setNotesModalTask(task);
                              }}
                            >
                              <Pencil className="w-4 h-4" />
                              修改备注
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              {loading && (
                <tr>
                  <td colSpan="13" className="px-4 py-12 text-center text-gray-500">
                    加载中...
                  </td>
                </tr>
              )}
              {!loading && tasks.length === 0 && (
                <tr>
                  <td colSpan="13" className="px-4 py-12 text-center text-gray-500">
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

      {tagRulesOpen && (
        <PaymentTagRulesModal onClose={() => setTagRulesOpen(false)} onSaved={() => load(true)} />
      )}

      {notesModalTask && (
        <PaymentNotesModal
          task={notesModalTask}
          saving={notesModalSaving}
          error={notesModalError}
          onClose={closeNotesModal}
          onSave={saveTaskNotes}
        />
      )}

      {staffModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="staff-modal-title"
            onSubmit={saveStaffSettings}
            className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden"
          >
            <div className="px-5 py-4 border-b border-gray-200 flex items-start justify-between gap-4 shrink-0">
              <div>
                <h2 id="staff-modal-title" className="text-lg font-semibold text-gray-900">
                  人员与容量
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  统一配置接单上限与自动接单，修改后点击保存全部。
                </p>
              </div>
              <button
                type="button"
                autoFocus
                aria-label="关闭人员配置"
                disabled={Boolean(busyAction)}
                className={`btn btn-secondary p-2 ${BUTTON_LAYOUT_CLASS}`}
                onClick={() => setStaffModalOpen(false)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-auto min-h-0">
              {staffError && (
                <div
                  role="alert"
                  className="m-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm break-words"
                >
                  {staffError}
                </div>
              )}
              <table className="w-full min-w-[640px]">
                <thead className="bg-gray-50">
                  <tr>
                    {['用户', '权限完整', '当前负载', '上限', '自动接单'].map(title => (
                      <th
                        key={title}
                        title={title === '下单时间' ? '北京时间，邮件或人工录入来源' : undefined}
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
                  {staffRows.map(person => (
                    <tr
                      key={person.id}
                      className="border-t border-gray-100 transition-colors hover:bg-gray-50"
                    >
                      <td className="px-4 py-3 font-medium">
                        {person.nickname || person.username}（{person.username}）
                        <div className="mt-1 text-xs text-gray-500">
                          <span
                            className={`badge ${person.assignmentMode === 'tag_only' ? 'badge-info' : 'bg-gray-100 text-gray-600'}`}
                          >
                            {person.assignmentMode === 'tag_only' ? 'TAG 专属' : '普通分配'}
                          </span>
                          <span className="ml-2">
                            {(person.tagRules || []).map(rule => rule.name).join('、')}
                          </span>
                        </div>
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
                          aria-label={`${person.username} 的接单上限`}
                          type="number"
                          required
                          min="0"
                          max="1000"
                          className="input w-24"
                          disabled={
                            Boolean(busyAction) || !can(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE)
                          }
                          value={staffDrafts[person.id]?.maxActiveTasks ?? 0}
                          onChange={event =>
                            setStaffDrafts(previous => ({
                              ...previous,
                              [person.id]: {
                                ...previous[person.id],
                                maxActiveTasks: event.target.value,
                              },
                            }))
                          }
                        />
                      </td>
                      <td className="px-4 py-3">
                        <ToggleSwitch
                          ariaLabel={`允许 ${person.nickname || person.username}（${person.username}） 自动接单`}
                          disabled={
                            Boolean(busyAction) || !can(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE)
                          }
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
                    </tr>
                  ))}
                </tbody>
              </table>
              {!staffRows.length && (
                <p className="py-10 text-center text-sm text-gray-500">暂无人员</p>
              )}
            </div>
            <div className="px-5 py-4 border-t border-gray-200 flex flex-wrap items-center justify-between gap-3 shrink-0">
              <span className="text-sm text-gray-500">已修改 {changedStaff.length} 人</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={`btn btn-secondary ${BUTTON_LAYOUT_CLASS}`}
                  disabled={Boolean(busyAction)}
                  onClick={() => setStaffModalOpen(false)}
                >
                  取消
                </button>
                {can(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE) && (
                  <button
                    type="submit"
                    className={`btn btn-primary ${BUTTON_LAYOUT_CLASS}`}
                    disabled={Boolean(busyAction) || !changedStaff.length}
                  >
                    <Save className="w-4 h-4" />
                    {busyAction === 'staff-batch' ? '保存中...' : '保存全部'}
                  </button>
                )}
              </div>
            </div>
          </form>
        </div>
      )}

      {assignModalOpen && (
        <PaymentAssignmentModal
          tasks={selectedTasks}
          staff={overview?.staff || []}
          onClose={() => {
            setAssignModalOpen(false);
            setSelectedTaskIds([]);
          }}
          onReload={() => loadCurrent.current()}
          onAssigned={async () => {
            try {
              await loadCurrent.current();
            } catch (failure) {
              setError(failure.message);
            }
          }}
        />
      )}
    </div>
  );
}
