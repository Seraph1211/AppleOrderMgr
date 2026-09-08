import { useState, useEffect, useRef } from 'react';
import {
  Search,
  Filter,
  Download,
  RefreshCw,
  Settings,
  X,
  AlertTriangle,
  PauseCircle,
} from 'lucide-react';
import {
  getOrders,
  getOrderFilterOptions,
  exportOrders,
  getAutoRefreshStatus,
  refreshAllOrders,
  getRefreshBatch,
  refreshOrder,
  getRefreshJob,
} from '../api';
import useColumnConfig from '../hooks/useColumnConfig';
import ColumnConfigModal from '../components/ColumnConfigModal';
import OrderDetailModal from '../components/OrderDetailModal';
import OrderConflictIndicator from '../components/OrderConflictIndicator';
import {
  ORDER_STATUS_BADGES,
  ORDER_STATUS_LABELS,
  PICKUP_STATUS_LABELS,
} from '../constants/orderStatus';
import Pagination from '../components/Pagination';
import { ordersColumns } from '../constants/tableColumns';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';

export default function Orders() {
  const { can } = useAuth();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [autoRefreshStatus, setAutoRefreshStatus] = useState(null);
  const [refreshBatch, setRefreshBatch] = useState(null);
  const [refreshMessage, setRefreshMessage] = useState('');
  const [rowRefresh, setRowRefresh] = useState({});
  const refreshRequests = useRef(new Set());
  const loadOrdersRef = useRef(null);

  // 分页状态
  const [pagination, setPagination] = useState({
    currentPage: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0,
  });

  // 筛选条件
  const [filters, setFilters] = useState({
    status: '',
    productModel: '',
    recipientName: '',
    pickupStore: '',
    payerName: '',
    payment_status: '',
  });

  const [showColumnConfig, setShowColumnConfig] = useState(false);
  const { columns, saveConfig, resetConfig } = useColumnConfig('orders', ordersColumns);

  // 筛选选项（从后端获取或硬编码）
  const [filterOptions, setFilterOptions] = useState({
    productModels: [],
    stores: [],
    recipients: [],
    payers: [],
  });

  useEffect(() => {
    loadOrders();
  }, [pagination.currentPage, pagination.pageSize]);

  useEffect(() => {
    loadFilterOptions();
    loadAutoRefreshStatus();
  }, []);

  // 筛选/搜索改变时触发
  useEffect(() => {
    if (pagination.currentPage === 1) {
      loadOrders();
    } else {
      setPagination(prev => ({ ...prev, currentPage: 1 }));
    }
  }, [
    searchTerm,
    filters.status,
    filters.productModel,
    filters.recipientName,
    filters.pickupStore,
    filters.payerName,
    filters.payment_status,
  ]);

  useEffect(() => {
    if (!refreshBatch?.id || refreshBatch.status === 'completed') return undefined;
    const timer = window.setInterval(async () => {
      try {
        const response = await getRefreshBatch(refreshBatch.id);
        if (response.success) {
          setRefreshBatch(response.data);
          if (response.data.status === 'completed') {
            setRefreshMessage(
              `刷新全部完成：成功 ${response.data.succeeded}，失败 ${response.data.failed}，跳过 ${response.data.skipped}`
            );
            loadOrders();
          }
        }
      } catch (error) {
        setRefreshMessage(error.message || '刷新进度查询失败');
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshBatch?.id, refreshBatch?.status]);

  const activeRowJobs = Object.entries(rowRefresh)
    .filter(([, value]) => value.jobId && ['pending', 'running'].includes(value.status))
    .map(([orderId, value]) => `${orderId}:${value.jobId}`)
    .join(',');

  useEffect(() => {
    if (!activeRowJobs) return undefined;
    let cancelled = false;
    let querying = false;
    const timer = window.setInterval(async () => {
      if (querying) return;
      querying = true;
      try {
        const results = await Promise.all(
          activeRowJobs.split(',').map(async entry => {
            try {
              const [orderId, jobId] = entry.split(':');
              const response = await getRefreshJob(jobId);
              if (!response.success) throw new Error('刷新进度查询失败');
              return { orderId, jobId, ...response.data };
            } catch (error) {
              return { error: error.message || '刷新进度查询失败，正在重试' };
            }
          })
        );
        if (cancelled) return;
        let completed = false;
        for (const result of results) {
          if (result.error) {
            setRefreshMessage(result.error);
            continue;
          }
          const terminal = !['pending', 'running'].includes(result.status);
          completed ||= terminal;
          setRowRefresh(previous => ({
            ...previous,
            [result.orderId]: {
              jobId: result.jobId,
              status: result.status,
              message:
                result.lastErrorMessage ||
                (result.status === 'succeeded' ? '刷新成功' : terminal ? '刷新未完成，可重试' : ''),
            },
          }));
        }
        if (completed) await loadOrdersRef.current?.(true);
      } catch (error) {
        if (!cancelled) setRefreshMessage(error.message || '刷新进度查询失败');
      } finally {
        querying = false;
      }
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRowJobs]);

  const hasExistingRefresh = orders.some(order =>
    ['pending', 'running'].includes(order.refreshJob?.status)
  );
  useEffect(() => {
    if (!hasExistingRefresh || activeRowJobs) return undefined;
    let querying = false;
    const timer = window.setInterval(async () => {
      if (querying) return;
      querying = true;
      try {
        await loadOrdersRef.current?.(true);
      } catch (error) {
        setRefreshMessage(error.message || '刷新列表失败');
      } finally {
        querying = false;
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [hasExistingRefresh, activeRowJobs]);

  const handleRowRefresh = async order => {
    if (refreshRequests.current.has(order.id)) return;
    refreshRequests.current.add(order.id);
    setRowRefresh(previous => ({
      ...previous,
      [order.id]: { status: 'submitting' },
    }));
    try {
      const response = await refreshOrder(order.id);
      if (!response.success || !response.data?.jobId) throw new Error('刷新任务提交失败');
      setRowRefresh(previous => ({
        ...previous,
        [order.id]: {
          jobId: response.data.jobId,
          status: response.data.status || 'pending',
        },
      }));
    } catch (error) {
      setRowRefresh(previous => ({
        ...previous,
        [order.id]: {
          status: 'failed',
          message: error.message || '刷新失败，请重试',
        },
      }));
    } finally {
      refreshRequests.current.delete(order.id);
    }
  };

  const loadOrders = async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const params = {
        page: pagination.currentPage,
        limit: pagination.pageSize,
        keyword: searchTerm || undefined,
        ...filters,
      };
      const res = await getOrders(params);

      if (res.success) {
        const mappedOrders = res.data.orders.map(order => ({
          id: order.id,
          orderNumber: order.order_number,
          status: order.status,
          officialRawStatus: order.official_raw_status,
          officialStatusObservedAt: order.official_status_observed_at,
          officialPaymentExpiresAt: order.official_payment_expires_at,
          officialFulfillmentMessage: order.official_fulfillment_message,
          validationStatus: order.validation_status || 'unchecked',
          validationIssues: order.validation_issues || [],
          anomalyDetectedAt: order.anomaly_detected_at || null,
          autoRefreshEnabled: order.auto_refresh_enabled,
          autoRefreshStopReason: order.auto_refresh_stop_reason || null,
          autoRefreshStoppedAt: order.auto_refresh_stopped_at || null,
          paymentStatus: order.payment_status || '-',
          pickupStatus: order.pickup_status || '-',
          officialOrderAmount: order.official_order_amount ?? null,
          officialOrderAmountCurrency: order.official_order_amount_currency || null,
          officialOrderAmountParseError: order.official_order_amount_parse_error || null,
          officialProducts: order.official_products || [],
          // Apple ID 相关
          appleId: order.apple_id || '-',
          applePassword: order.apple_password || '-',
          // 收件人相关
          recipientName: order.recipient_name || '-',
          recipientTag: order.recipient_tag || '-',
          recipientIdCard: order.recipient_id_card || '-',
          recipientEmail: order.recipient_email || '-',
          recipientPhone: order.recipient_phone || '-',
          recipientAddress: order.recipient_address || '-',
          // 产品信息
          products: order.products || [],
          // 订单信息
          orderUrl: order.order_url || '-',
          orderDate: order.order_date || '-',
          // 取货信息
          pickupStore: order.pickup_store || '-',
          pickupStoreCode: order.pickup_store_code || '-',
          pickupCode: order.pickup_code || '-',
          pickupTimeSlot: order.pickup_time_slot || '-',
          actualPickupDate: order.actual_pickup_date || '-',
          // 付款信息
          paymentMethod: order.payment_method || '-',
          payerName: order.payer_name || '-',
          payerVersion: order.payer_version || 0,
          paymentScreenshot: order.payment_screenshot || [],
          // 爬虫相关
          lastCrawledAt: order.last_crawled_at || '-',
          lastOfficialUpdatedAt: order.last_crawled_at || '-',
          crawlFailCount: order.crawl_fail_count || 0,
          freshnessStatus:
            order.refresh?.job?.status === 'pending'
              ? 'pending'
              : order.refresh?.job?.status === 'running'
                ? 'refreshing'
                : order.refresh?.freshness_status || 'stale',
          refreshJob: order.refresh?.job || null,
          refreshErrorCode: order.refresh?.last_error_code || null,
          refreshErrorMessage: order.refresh?.last_error_message || null,
          // 业务字段
          tag: order.tag || '-',
          notes: order.notes || '-',
          // 时间戳
          createdAt: order.created_at,
          updatedAt: order.updated_at,
        }));
        setOrders(mappedOrders);

        // 更新分页信息
        setPagination(prev => ({
          ...prev,
          totalItems: res.data.total,
          totalPages: Math.ceil(res.data.total / prev.pageSize),
        }));
      }
    } catch (error) {
      setRefreshMessage(error.message || '加载订单失败');
    } finally {
      setLoading(false);
    }
  };

  const loadAutoRefreshStatus = async () => {
    try {
      const res = await getAutoRefreshStatus();
      if (res.success) {
        setAutoRefreshStatus(res.data);
      }
    } catch (error) {
      setRefreshMessage(error.message || '加载自动刷新状态失败');
    }
  };

  loadOrdersRef.current = loadOrders;

  const loadFilterOptions = async () => {
    try {
      const response = await getOrderFilterOptions();
      if (response.success) setFilterOptions(response.data);
    } catch (_error) {
      setFilterOptions({
        productModels: [],
        stores: [],
        recipients: [],
        payers: [],
      });
    }
  };

  const handleExport = async () => {
    await exportOrders({ keyword: searchTerm || undefined, ...filters });
  };

  const handleRefreshAll = async () => {
    if (
      !window.confirm(
        `将为全部可刷新订单提交后台任务，当前共有 ${pagination.totalItems} 条订单。继续吗？`
      )
    ) {
      return;
    }
    try {
      const response = await refreshAllOrders();
      if (response.success) {
        setRefreshBatch({
          id: response.data.batchId,
          status: response.data.status,
        });
        setRefreshMessage(
          response.data.created ? '刷新全部批次已提交' : '已有批次运行中，正在显示其进度'
        );
      }
    } catch (error) {
      setRefreshMessage(error.message || '提交刷新全部失败');
    }
  };

  const getValidationBadge = status => {
    const badges = {
      unchecked: { text: '未校验', class: 'badge-info' },
      valid: { text: '正常', class: 'badge-success' },
      abnormal: { text: '异常', class: 'badge-error' },
      unavailable: { text: '无法校验', class: 'badge-warning' },
    };
    return badges[status] || badges.unchecked;
  };

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    // 筛选条件变化时重置到第一页
    setPagination(prev => ({ ...prev, currentPage: 1 }));
  };

  const resetFilters = () => {
    setFilters({
      status: '',
      productModel: '',
      recipientName: '',
      pickupStore: '',
      payerName: '',
      payment_status: '',
    });
    setSearchTerm('');
    setPagination(prev => ({ ...prev, currentPage: 1 }));
  };

  // 分页处理函数
  const handlePageChange = page => {
    setPagination(prev => ({ ...prev, currentPage: page }));
  };

  const handlePageSizeChange = size => {
    setPagination(prev => ({
      ...prev,
      pageSize: size,
      currentPage: 1, // 改变每页条数时重置到第一页
      totalPages: Math.ceil(prev.totalItems / size),
    }));
  };

  const getStatusBadge = status => {
    return ORDER_STATUS_BADGES[status] || ORDER_STATUS_BADGES.unknown;
  };

  // 移除客户端过滤逻辑，现在由后端处理
  const visibleColumns = columns.filter(col => col.visible);

  const renderCell = (order, column) => {
    const value = order[column.key];

    switch (column.key) {
      case 'pickupStatus':
        return <span className="text-sm">{PICKUP_STATUS_LABELS[value] || '-'}</span>;
      case 'orderNumber':
        return <span className="font-mono text-sm text-primary">{value}</span>;

      case 'status': {
        const badge = getStatusBadge(value);
        return <span className={`badge ${badge.class}`}>{badge.text}</span>;
      }

      case 'validationStatus': {
        const badge = getValidationBadge(value);
        return (
          <span className={`badge ${badge.class} inline-flex items-center gap-1`}>
            {value === 'abnormal' && <AlertTriangle className="w-3 h-3" />}
            {badge.text}
          </span>
        );
      }

      case 'lastOfficialUpdatedAt':
        return (
          <span className="text-sm text-gray-600" title="最后一次成功从官网更新订单数据的时间">
            {value === '-' ? '尚未更新' : new Date(value).toLocaleString('zh-CN')}
          </span>
        );

      case 'products':
        return (
          <div className="text-sm space-y-1">
            {order.products.map((p, i) => (
              <div key={i}>
                <span>
                  {p.name} × {p.quantity}
                </span>
              </div>
            ))}
          </div>
        );

      case 'orderUrl':
        return value !== '-' ? (
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline text-sm"
          >
            查看
          </a>
        ) : (
          <span className="text-gray-400">-</span>
        );

      case 'orderDate':
      case 'lastCrawledAt':
      case 'createdAt':
      case 'updatedAt':
        return value !== '-' ? (
          <span className="text-sm text-gray-600">{new Date(value).toLocaleString('zh-CN')}</span>
        ) : (
          <span className="text-gray-400">-</span>
        );

      case 'actualPickupDate':
        return value !== '-' ? (
          <span className="text-sm text-gray-600">
            {new Date(value).toLocaleDateString('zh-CN')}
          </span>
        ) : (
          <span className="text-gray-400">-</span>
        );

      case 'paymentScreenshot':
        return value !== '-' ? (
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline text-sm"
          >
            查看
          </a>
        ) : (
          <span className="text-gray-400">-</span>
        );

      case 'applePassword':
      case 'recipientIdCard':
        return column.sensitive ? (
          <span className="text-sm text-gray-600 font-mono">******</span>
        ) : (
          <span className="text-sm text-gray-600">{value}</span>
        );

      case 'actions': {
        const progress = rowRefresh[order.id];
        const state = progress?.status || order.refreshJob?.status;
        const busy = ['submitting', 'pending', 'running'].includes(state);
        const label =
          { submitting: '提交中', pending: '排队中', running: '刷新中' }[state] || '手动刷新';
        return (
          <div className="space-y-1">
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={event => {
                  event.stopPropagation();
                  setSelectedOrder(order);
                  setShowDetailModal(true);
                }}
                className="btn btn-secondary text-sm"
              >
                查看
              </button>
              {can(PERMISSIONS.ORDERS_REFRESH) && (
                <button
                  onClick={event => {
                    event.stopPropagation();
                    handleRowRefresh(order);
                  }}
                  disabled={busy}
                  aria-label={`${label} ${order.orderNumber}`}
                  className="btn btn-secondary text-sm inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
                  {label}
                </button>
              )}
            </div>
            {progress?.message && (
              <p
                role="status"
                className={`text-xs max-w-56 ml-auto ${state === 'succeeded' ? 'text-green-700' : 'text-red-600'}`}
              >
                {progress.message}
              </p>
            )}
          </div>
        );
      }

      default:
        return <span className="text-sm text-gray-600">{value}</span>;
    }
  };

  const activeFiltersCount = Object.values(filters).filter(v => v !== '').length;

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">订单管理</h1>
          <p className="text-gray-600 mt-1">管理所有 Apple 订单</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadOrders} className="btn btn-secondary flex items-center space-x-2">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span>重新加载</span>
          </button>
          {can(PERMISSIONS.ORDERS_REFRESH) && (
            <button
              onClick={handleRefreshAll}
              className="btn btn-primary flex items-center space-x-2"
            >
              <RefreshCw className="w-4 h-4" />
              <span>刷新全部</span>
            </button>
          )}
        </div>
      </div>

      {refreshMessage && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">
          {refreshMessage}
          {refreshBatch && refreshBatch.total !== undefined && (
            <span className="ml-2">
              总计 {refreshBatch.total}，待执行 {refreshBatch.pending}，执行中{' '}
              {refreshBatch.running}，成功 {refreshBatch.succeeded}，失败 {refreshBatch.failed}
            </span>
          )}
        </div>
      )}

      {autoRefreshStatus?.isPaused && (
        <div className="border border-red-200 bg-red-50 rounded-lg px-4 py-3 flex items-start gap-3">
          <PauseCircle className="w-5 h-5 text-red-600 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-700">自动刷新已暂停</p>
            <p className="text-sm text-red-600 mt-1">
              {autoRefreshStatus.pauseReason || '系统检测到关键异常，需要管理员手动恢复'}
            </p>
          </div>
        </div>
      )}

      {/* 搜索栏 */}
      <div className="card">
        <div className="flex items-center gap-4">
          {/* 搜索框 */}
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="搜索订单号、Apple ID 或取机人..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="input pl-10"
            />
          </div>

          {/* 导出按钮 */}
          {can(PERMISSIONS.ORDERS_EXPORT) && (
            <button
              onClick={handleExport}
              className="btn btn-secondary flex items-center space-x-2"
            >
              <Download className="w-4 h-4" />
              <span>导出</span>
            </button>
          )}

          {/* 列设置按钮 */}
          <button
            onClick={() => setShowColumnConfig(true)}
            className="btn btn-secondary flex items-center space-x-2"
          >
            <Settings className="w-4 h-4" />
            <span>列设置</span>
          </button>
        </div>
      </div>

      {/* 筛选区域 */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-gray-600" />
            <h3 className="text-sm font-medium text-gray-700">筛选条件</h3>
            {activeFiltersCount > 0 && (
              <span className="badge badge-info">{activeFiltersCount}</span>
            )}
          </div>
          {activeFiltersCount > 0 && (
            <button
              onClick={resetFilters}
              className="text-sm text-gray-600 hover:text-gray-900 flex items-center gap-1"
            >
              <X className="w-4 h-4" />
              清空筛选
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
          {/* 订单状态 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">订单状态</label>
            <select
              value={filters.status}
              onChange={e => handleFilterChange('status', e.target.value)}
              className="input"
            >
              <option value="">全部状态</option>
              {Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">支付状态</label>
            <select
              value={filters.payment_status}
              onChange={event => handleFilterChange('payment_status', event.target.value)}
              className="input"
            >
              <option value="">全部支付状态</option>
              <option value="unknown">状态未知</option>
              <option value="unpaid">未付款</option>
              <option value="paid">已付款</option>
              <option value="refunded">已退款</option>
            </select>
          </div>

          {/* 产品型号 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">产品型号</label>
            <select
              value={filters.productModel}
              onChange={e => handleFilterChange('productModel', e.target.value)}
              className="input"
            >
              <option value="">全部型号</option>
              {filterOptions.productModels.map(model => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </div>

          {/* 取件人 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">取件人</label>
            <input
              type="text"
              placeholder="输入姓名"
              value={filters.recipientName}
              onChange={e => handleFilterChange('recipientName', e.target.value)}
              className="input"
            />
          </div>

          {/* 取货门店 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">取货门店</label>
            <select
              value={filters.pickupStore}
              onChange={e => handleFilterChange('pickupStore', e.target.value)}
              className="input"
            >
              <option value="">全部门店</option>
              {filterOptions.stores.map(store => (
                <option key={store} value={store}>
                  {store}
                </option>
              ))}
            </select>
          </div>

          {/* 付款人 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">付款人</label>
            <input
              type="text"
              placeholder="输入付款人"
              value={filters.payerName}
              onChange={e => handleFilterChange('payerName', e.target.value)}
              className="input"
            />
          </div>
        </div>
      </div>

      {/* 订单列表 */}
      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-gray-600">加载订单...</p>
            </div>
          </div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-600">未找到订单</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="py-3 px-3 w-10" aria-label="订单数据冲突" />
                  {visibleColumns.map(col => (
                    <th
                      key={col.key}
                      className={`text-left py-3 px-4 text-sm font-medium text-gray-500 whitespace-nowrap ${
                        col.key === 'actions' ? 'text-right sticky right-0 bg-gray-50 z-10' : ''
                      }`}
                      style={{ minWidth: col.width }}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-white">
                {orders.map(order => (
                  <tr
                    key={order.id}
                    className={`border-b border-gray-200 transition-colors ${
                      order.validationStatus === 'abnormal'
                        ? 'bg-red-50 hover:bg-red-100'
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    <td className="py-4 px-3">
                      <OrderConflictIndicator issues={order.validationIssues} />
                    </td>
                    {visibleColumns.map(col => (
                      <td
                        key={col.key}
                        className={`py-4 px-4 ${col.key === 'actions' ? `text-right sticky right-0 ${order.validationStatus === 'abnormal' ? 'bg-red-50' : 'bg-white'}` : ''}`}
                      >
                        {renderCell(order, col)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 列配置弹窗 */}
      {showColumnConfig && (
        <ColumnConfigModal
          columns={columns}
          onSave={saveConfig}
          onReset={resetConfig}
          onClose={() => setShowColumnConfig(false)}
        />
      )}

      {/* 订单详情弹窗 */}
      <OrderDetailModal
        order={selectedOrder}
        isOpen={showDetailModal}
        onClose={() => {
          setShowDetailModal(false);
          setSelectedOrder(null);
        }}
        onUpdate={updatedOrder => {
          // 更新本地订单列表
          setOrders(prevOrders =>
            prevOrders.map(o => (o.id === updatedOrder.id ? updatedOrder : o))
          );
        }}
      />

      {/* 分页组件 */}
      {!loading && pagination.totalItems > 0 && (
        <Pagination
          currentPage={pagination.currentPage}
          totalPages={pagination.totalPages}
          totalItems={pagination.totalItems}
          pageSize={pagination.pageSize}
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
          pageSizeOptions={[10, 20, 50, 100]}
        />
      )}
    </div>
  );
}
