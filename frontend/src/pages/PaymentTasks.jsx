import PaymentOrdersTable from '../components/PaymentOrdersTable';
import usePaymentOrderRefresh from '../hooks/usePaymentOrderRefresh';
import AutoDismissToast from '../components/AutoDismissToast';
import DateRangeFilter from '../components/dateRangeFilter';
import ProductFilter from '../components/ProductFilter';
import PaymentNotesModal from '../components/PaymentNotesModal';
import OfficialStatusFilter from '../components/OfficialStatusFilter';
import ProcessingStatusFilter from '../components/ProcessingStatusFilter';
import { readPaymentCopyText } from '../utils/paymentCopySource';
import { getPaymentTaskCode } from '../api/paymentCodesApi';
import { copyDeferredText } from '../utils/copyDeferredText';
import Pagination from '../components/Pagination';
import TagMultiSelect from '../components/TagMultiSelect';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, CreditCard, RotateCcw, Search } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';
import {
  getPaymentTaskAlipayLink,
  getPaymentTaskLink,
  getPaymentTasks,
  updatePaymentTask,
} from '../api/paymentTasksApi';

const STATUS_LABELS = {
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  exception: '异常',
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
  productKeys: [],
  recipientTags: [],
  officialOrderStatuses: [],
  dateFrom: '',
  dateTo: '',
};

const COPY_LINK_CONCURRENCY = 5;

export default function PaymentTasks() {
  const { can } = useAuth();
  const canCopyTaskInfo = can(PERMISSIONS.PAYMENT_TASKS_LINK_READ_OWN);
  const canHandleTasks = can(PERMISSIONS.PAYMENT_TASKS_HANDLE_OWN);
  const canSelectTasks = canCopyTaskInfo;
  const [tasks, setTasks] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 0 });
  const [productOptions, setProductOptions] = useState([]);
  const [recipientTagOptions, setRecipientTagOptions] = useState([]);
  const [officialStatusOptions, setOfficialStatusOptions] = useState([]);
  const loadRequest = useRef(0);
  const [filterDrafts, setFilterDrafts] = useState(INITIAL_FILTERS);
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [serverClockOffset, setServerClockOffset] = useState(0);
  const [rowActions, setRowActions] = useState({});
  const [selectedTaskIds, setSelectedTaskIds] = useState([]);
  const [batchCopyAction, setBatchCopyAction] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
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
        if (params.productKeys) params.productKeys = JSON.stringify(params.productKeys);
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
        setProductOptions(response.data.productOptions || []);
        setRecipientTagOptions(response.data.recipientTagOptions || []);
        setOfficialStatusOptions(response.data.officialOrderStatuses || []);
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
      } catch (loadError) {
        if (request === loadRequest.current) {
          setError(loadError.message);
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
  useEffect(() => {
    if (error) showToast('error', error);
  }, [error, showToast]);
  useEffect(() => {
    if (batchCopyAction?.message && !batchCopyAction.copying) {
      showToast(batchCopyAction.type, batchCopyAction.message);
    }
  }, [batchCopyAction, showToast]);
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

  const updateRowAction = (taskId, patch) => {
    setRowActions(previous => ({
      ...previous,
      [taskId]: { ...previous[taskId], ...patch },
    }));
  };

  const applyUpdatedTask = (taskId, updatedTask) => {
    setTasks(previous => previous.map(task => (task.id === taskId ? updatedTask : task)));
  };
  const officialRefresh = usePaymentOrderRefresh({ reload: loadTasks });

  const saveProcessingNotes = async notes => {
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
    updateRowAction(task.id, {
      savingNotes: true,
      type: 'info',
      message: '备注保存中...',
    });
    try {
      setError('');
      const response = await updatePaymentTask(
        task.id,
        { processingNotes, expectedVersion: task.version },
        crypto.randomUUID()
      );
      applyUpdatedTask(task.id, response.data);
      updateRowAction(task.id, {
        savingNotes: false,
        type: 'success',
        message: '处理备注已保存',
      });
      setNotesModalTask(null);
      showToast('success', '处理备注已保存');
    } catch (actionError) {
      setNotesModalError(actionError.message);
      updateRowAction(task.id, {
        savingNotes: false,
        type: 'error',
        message: actionError.message,
      });
      showToast('error', actionError.message);
    } finally {
      setNotesModalSaving(false);
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
      await copyDeferredText(() =>
        readPaymentCopyText(task, getPaymentTaskCode, getPaymentTaskLink)
      );
      updateRowAction(task.id, {
        copying: false,
        type: 'success',
        message: '订单信息已复制',
      });
      showToast('success', '订单信息已复制');
    } catch (actionError) {
      updateRowAction(task.id, {
        copying: false,
        type: 'error',
        message: actionError.message,
      });
      showToast('error', actionError.message);
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
            chunk.map(task => readPaymentCopyText(task, getPaymentTaskCode, getPaymentTaskLink))
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

  const changeFilters = next => {
    setSelectedTaskIds([]);
    setPage(1);
    setFilters(next);
  };

  return (
    <fieldset className="payment-tasks min-w-0 space-y-4">
      <AutoDismissToast toast={toast} onDismiss={dismissToast} />
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
              enableSelectAll
              hideProductCode
              options={productOptions}
              value={filters.productKeys}
              onChange={productKeys => {
                setFilterDrafts(previous => ({ ...previous, productKeys }));
                changeFilters({ ...filters, productKeys });
              }}
            />
          </div>
          <TagMultiSelect
            enableSelectAll
            options={recipientTagOptions}
            value={filters.recipientTags}
            onChange={recipientTags => {
              setFilterDrafts(previous => ({ ...previous, recipientTags }));
              changeFilters({ ...filters, recipientTags });
            }}
          />

          <OfficialStatusFilter
            options={officialStatusOptions}
            value={filters.officialOrderStatuses}
            onChange={officialOrderStatuses => {
              setFilterDrafts(previous => ({ ...previous, officialOrderStatuses }));
              changeFilters({ ...filters, officialOrderStatuses });
            }}
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
          <DateRangeFilter
            dateFrom={filters.dateFrom}
            dateTo={filters.dateTo}
            onChange={range => {
              setFilterDrafts(previous => ({ ...previous, ...range }));
              changeFilters({ ...filters, ...range });
            }}
          />
          <div className="payment-filter-submit">
            {JSON.stringify(filterDrafts) !== JSON.stringify(filters) && (
              <span className="text-sm text-amber-700">其他条件待应用，请点击筛选</span>
            )}
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
            </div>
          </div>
        )}
        <PaymentOrdersTable
          tasks={tasks}
          loading={loading}
          now={now}
          selectedKeys={filters.productKeys}
          selectedIds={selectedTaskIds}
          onSelect={setSelectedTaskIds}
          canSelect={canSelectTasks}
          canCopy={canCopyTaskInfo}
          canEdit={canHandleTasks}
          canRefresh={canHandleTasks}
          copyingIds={
            batchCopyAction?.copying
              ? selectedTaskIds
              : tasks.filter(task => rowActions[task.id]?.copying).map(task => task.id)
          }
          onCopy={copyPaymentLink}
          onEdit={task => {
            setNotesModalError('');
            setNotesModalTask(task);
          }}
          getAlipayLink={getPaymentTaskAlipayLink}
          onResult={showToast}
          refresh={officialRefresh}
        />
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
      {notesModalTask && (
        <PaymentNotesModal
          task={notesModalTask}
          saving={notesModalSaving}
          error={notesModalError}
          onClose={closeNotesModal}
          onSave={saveProcessingNotes}
        />
      )}
    </fieldset>
  );
}
