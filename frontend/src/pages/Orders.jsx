import OrderAmount from '../components/OrderAmount';
import OrderMailDrawer from '../components/OrderMailDrawer';
import AutoDismissToast from '../components/AutoDismissToast';
import OrderExportModal from '../components/OrderExportModal';
import OrderDateFilter from '../components/OrderDateFilter';
import ProductFilter from '../components/ProductFilter';
import ProductSummary from '../components/ProductSummary';
import BrowserRefreshButton from '../components/BrowserRefreshButton';
import { formatOrderTime } from '../utils/orderTime';
import {
  reconcileRowRefresh,
  applyRefreshJobResult,
  getOrderRefreshFeedback,
  getRefreshObservation,
} from '../utils/orderRefresh';
import { copyDeferredText } from '../utils/copyDeferredText';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Filter, Download, RefreshCw, Settings, X, PauseCircle, Mail } from 'lucide-react';
import {
  getOrders,
  getOrderLink,
  getOrderFilterOptions,
  exportOrders,
  getAutoRefreshStatus,
  refreshAllOrders,
  getRefreshBatch,
  refreshOrder,
  batchRefreshOrders,
  getRefreshJob,
} from '../api';
import useColumnConfig from '../hooks/useColumnConfig';
import ColumnConfigModal from '../components/ColumnConfigModal';
import OrderDetailModal from '../components/OrderDetailModal';
import OrderConflictIndicator from '../components/OrderConflictIndicator';
import {
  EMAIL_ORDER_STATUS_BADGES,
  getEmailOrderStatusBadge,
  getOrderStatusBadge,
  ORDER_STATUS_LABELS,
  PICKUP_STATUS_LABELS,
} from '../constants/orderStatus';
import Pagination from '../components/Pagination';
import TagMultiSelect from '../components/TagMultiSelect';
import { ordersColumns } from '../constants/tableColumns';
import { getDefaultOrderExportFields } from '../constants/orderExportFields';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';
import { replayOrderMailLifecycle, replayOrderMailLifecycleBatch } from '../api/orderMailApi';

const EMAIL_ORDER_STATUS_LABELS = Object.fromEntries(
  Object.entries(EMAIL_ORDER_STATUS_BADGES).map(([key, badge]) => [key, badge.text])
);
export default function Orders() {
  const { can, user } = useAuth();
  const canRefreshOrders = can(PERMISSIONS.ORDERS_REFRESH);
  const canRefreshMailStatus = can(PERMISSIONS.ORDER_MAIL_MANAGE);
  const canExportOrders = can(PERMISSIONS.ORDERS_EXPORT);
  const canSelectOrders = canRefreshOrders || canRefreshMailStatus || canExportOrders;
  const [browserRefreshOrderId, setBrowserRefreshOrderId] = useState(null);
  const [mailOrder, setMailOrder] = useState(null);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [autoRefreshStatus, setAutoRefreshStatus] = useState(null);
  const [refreshBatch, setRefreshBatch] = useState(null);
  const [refreshMessage, setRefreshMessage] = useState('');
  const [rowRefresh, setRowRefresh] = useState({});
  const [selectedIds, setSelectedIds] = useState([]);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [mailBatchSubmitting, setMailBatchSubmitting] = useState(false);
  const [mailRefreshingIds, setMailRefreshingIds] = useState([]);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportingSelected, setExportingSelected] = useState(false);
  const [copyingOrderId, setCopyingOrderId] = useState(null);
  const [toast, setToast] = useState(null);
  const batchRequest = useRef(false);
  const refreshRequests = useRef(new Set());
  const loadOrdersRef = useRef(null);
  const ordersRequestSequence = useRef(0);
  const showToast = useCallback((type, message) => {
    if (message) setToast({ id: Date.now(), type, message });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  // 分页状态
  const [pagination, setPagination] = useState({
    currentPage: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0,
  });

  // 筛选条件
  const [filters, setFilters] = useState({
    statuses: [],
    emailOrderStatuses: [],
    productKeys: [],
    recipientName: '',
    recipientTags: [],
    pickupStores: [],
    pickupDate: '',
    dateFrom: '',
    dateTo: '',
  });

  const [showColumnConfig, setShowColumnConfig] = useState(false);
  const { columns, saveConfig, resetConfig } = useColumnConfig('orders', ordersColumns);

  // 筛选选项（从后端获取或硬编码）
  const [filterOptions, setFilterOptions] = useState({
    productOptions: [],
    stores: [],
    recipientTags: [],
  });

  useEffect(() => {
    setSelectedIds([]);
  }, [pagination.currentPage, pagination.pageSize, searchTerm, filters]);

  useEffect(() => {
    setSelectedIds(previous => previous.filter(id => orders.some(order => order.id === id)));
  }, [orders]);

  useEffect(() => {
    loadOrders();
  }, [pagination.currentPage, pagination.pageSize]);

  useEffect(() => {
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
    filters.statuses,
    filters.emailOrderStatuses,
    filters.productKeys,
    filters.recipientName,
    filters.recipientTags,
    filters.pickupStores,
    filters.pickupDate,
    filters.dateFrom,
    filters.dateTo,
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadOrdersRef.current?.(true);
    }, 15000);
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') loadOrdersRef.current?.(true);
    };
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, []);

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
          setRowRefresh(previous => applyRefreshJobResult(previous, result));
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
      if (response.data.created === false) {
        setRowRefresh(previous => {
          const next = { ...previous };
          delete next[order.id];
          return next;
        });
        await loadOrdersRef.current?.(true);
        return;
      }
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
          observedBeforeSubmit: getRefreshObservation(order),
        },
      }));
    } finally {
      refreshRequests.current.delete(order.id);
    }
  };

  const handleSelectedRefresh = async () => {
    if (batchRequest.current || !selectedIds.length || !can(PERMISSIONS.ORDERS_REFRESH)) return;
    const ids = selectedIds.filter(
      id => orders.some(order => order.id === id) && !refreshRequests.current.has(id)
    );
    if (!ids.length) return;
    batchRequest.current = true;
    setBatchSubmitting(true);
    ids.forEach(id => refreshRequests.current.add(id));
    setRowRefresh(previous => ({
      ...previous,
      ...Object.fromEntries(ids.map(id => [id, { status: 'submitting' }])),
    }));
    try {
      const response = await batchRefreshOrders(ids);
      if (!response.success || !Array.isArray(response.data?.results)) {
        throw new Error('批量刷新任务提交失败');
      }
      const results = new Map(response.data.results.map(result => [result.orderId, result]));
      const failedIds = ids.filter(id => !results.get(id)?.jobId);
      setRowRefresh(previous => {
        const next = { ...previous };
        for (const id of ids) {
          const result = results.get(id);
          // 合并任务可能归其他提交人所有，仅通过有权读取的订单列表追踪，不越权查询 job。
          if (result?.jobId && !result.created) delete next[id];
          else
            next[id] = result?.jobId
              ? { jobId: result.jobId, status: 'pending' }
              : {
                  status: 'failed',
                  message: '未能提交刷新任务，订单可能已删除或提交失败，可重试',
                  observedBeforeSubmit: getRefreshObservation(
                    orders.find(order => order.id === id)
                  ),
                };
        }
        return next;
      });
      setSelectedIds(previous => previous.filter(id => failedIds.includes(id)));
      setRefreshMessage(
        `批量刷新：已提交或合并 ${ids.length - failedIds.length} 项，未提交 ${failedIds.length} 项。执行结果请查看各行状态。`
      );
      await loadOrdersRef.current?.(true);
    } catch (error) {
      setRowRefresh(previous => ({
        ...previous,
        ...Object.fromEntries(
          ids.map(id => [
            id,
            {
              status: 'failed',
              message: '提交结果未确认，可重试；已入队任务会自动合并',
              observedBeforeSubmit: getRefreshObservation(orders.find(order => order.id === id)),
            },
          ])
        ),
      }));
      setRefreshMessage(error.message || '批量提交失败，可重试');
    } finally {
      ids.forEach(id => refreshRequests.current.delete(id));
      batchRequest.current = false;
      setBatchSubmitting(false);
    }
  };

  const mailReplayMessage = (totals, mode) => {
    if (totals.messages === 0) return '所选订单没有关联的订单邮件';
    const queued = totals.enqueued + totals.active;
    const modeHint =
      mode === 'shadow'
        ? '当前为影子模式，解析结果不会写入订单状态。'
        : '解析完成后将按生产开关更新订单状态。';
    return `已为 ${totals.orders} 个订单提交 ${queued} 封邮件，${totals.withoutMail} 个订单无关联邮件。${modeHint}`;
  };

  const handleMailStatusRefresh = async order => {
    if (mailRefreshingIds.includes(order.id)) return;
    setMailRefreshingIds(previous => [...previous, order.id]);
    try {
      const response = await replayOrderMailLifecycle(order.id);
      if (!response.success || !response.data?.totals) {
        throw new Error('邮件状态刷新任务提交失败');
      }
      const type = response.data.totals.messages === 0 ? 'warning' : 'success';
      showToast(type, mailReplayMessage(response.data.totals, response.data.mode));
      window.setTimeout(() => loadOrdersRef.current?.(true), 3000);
    } catch (error) {
      showToast('error', error.message || '邮件状态刷新任务提交失败');
    } finally {
      setMailRefreshingIds(previous => previous.filter(id => id !== order.id));
    }
  };

  const handleSelectedMailStatusRefresh = async () => {
    if (mailBatchSubmitting || selectedIds.length === 0 || !canRefreshMailStatus) return;
    setMailBatchSubmitting(true);
    try {
      const response = await replayOrderMailLifecycleBatch(selectedIds);
      if (!response.success || !response.data?.totals) {
        throw new Error('批量邮件状态刷新任务提交失败');
      }
      const type = response.data.totals.messages === 0 ? 'warning' : 'success';
      showToast(type, mailReplayMessage(response.data.totals, response.data.mode));
      setSelectedIds([]);
      window.setTimeout(() => loadOrdersRef.current?.(true), 3000);
    } catch (error) {
      showToast('error', error.message || '批量邮件状态刷新任务提交失败');
    } finally {
      setMailBatchSubmitting(false);
    }
  };

  const loadOrders = async (quiet = false) => {
    const requestSequence = ++ordersRequestSequence.current;
    if (!quiet) setLoading(true);
    try {
      const params = {
        page: pagination.currentPage,
        limit: pagination.pageSize,
        keyword: searchTerm || undefined,
        ...filters,
      };
      for (const key of [
        'statuses',
        'emailOrderStatuses',
        'productKeys',
        'pickupStores',
        'recipientTags',
      ]) {
        if (params[key].length > 0) params[key] = JSON.stringify(params[key]);
        else delete params[key];
      }
      const [res, optionResponse] = await Promise.all([
        getOrders(params),
        getOrderFilterOptions(params),
      ]);
      if (requestSequence !== ordersRequestSequence.current) return;

      if (res.success) {
        if (optionResponse.success) setFilterOptions(optionResponse.data);
        const mappedOrders = res.data.orders.map(order => ({
          id: order.id,
          orderNumber: order.order_number,
          ingestionSource: order.ingestion_source,
          sourceRecipientTag: order.source_recipient_tag,
          recipientProfileTag: order.recipient_profile_tag,
          recipientTagConflict: order.recipient_tag_conflict,
          recipientLinked: order.recipient_linked,
          status: order.status,
          emailOrderStatus: order.email_order_status || 'unknown',
          emailStatusNeedsReview: Boolean(order.email_status_needs_review),
          emailStatusReviewReasons: order.email_status_review_reasons || [],
          emailStatusEvidenceAt: order.email_status_evidence_at || null,
          emailStatusVersion: order.email_status_version || 0,
          emailPickupInfo: order.email_pickup_info || null,
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
          pickupStatus: order.pickup_status || '-',
          orderAmount: order.order_amount ?? null,
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
          pickupTime: order.pickup_time || '-',
          officialPickupDate: order.official_pickup_date || '-',
          officialPickupTimeSlot: order.official_pickup_time_slot || '-',
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
          refreshLastSuccessAt: order.refresh?.last_success_at || order.last_crawled_at || null,
          refreshLastFailureAt: order.refresh?.last_failure_at || null,
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
        setRowRefresh(previous => reconcileRowRefresh(previous, mappedOrders));

        // 更新分页信息
        setPagination(prev => ({
          ...prev,
          totalItems: res.data.total,
          totalPages: Math.ceil(res.data.total / prev.pageSize),
        }));
      }
    } catch (error) {
      if (requestSequence === ordersRequestSequence.current) {
        setRefreshMessage(error.message || '加载订单失败');
        if (!quiet) setOrders([]);
      }
    } finally {
      if (requestSequence === ordersRequestSequence.current) setLoading(false);
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

  const handleExport = async () => {
    const params = { keyword: searchTerm || undefined, ...filters };
    for (const key of [
      'statuses',
      'emailOrderStatuses',
      'productKeys',
      'pickupStores',
      'recipientTags',
    ]) {
      if (params[key].length > 0) params[key] = JSON.stringify(params[key]);
      else delete params[key];
    }
    await exportOrders(params);
  };

  const handleSelectedExport = async fields => {
    if (!canExportOrders || selectedIds.length === 0 || exportingSelected) return;
    setExportingSelected(true);
    try {
      await exportOrders({ orderIds: selectedIds, fields });
      showToast('success', `已导出 ${selectedIds.length} 个订单`);
    } catch (error) {
      showToast('error', error.message || '导出失败，请稍后重试');
      throw error;
    } finally {
      setExportingSelected(false);
    }
  };

  const handleCopyOrderLink = async order => {
    if (copyingOrderId !== null) return;
    setCopyingOrderId(order.id);
    try {
      await copyDeferredText(async () => {
        const response = await getOrderLink(order.id);
        const orderUrl = response.data?.orderUrl;
        if (!response.success || !orderUrl) throw new Error('订单链接不存在');
        return orderUrl;
      });
      showToast('success', '订单链接已复制');
    } catch (error) {
      showToast('error', error.message || '复制失败，请检查剪贴板权限');
    } finally {
      setCopyingOrderId(null);
    }
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

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    // 筛选条件变化时重置到第一页
    setPagination(prev => ({ ...prev, currentPage: 1 }));
  };

  const resetFilters = () => {
    setFilters({
      statuses: [],
      emailOrderStatuses: [],
      productKeys: [],
      recipientName: '',
      recipientTags: [],
      pickupStores: [],
      pickupDate: '',
      dateFrom: '',
      dateTo: '',
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
    return getOrderStatusBadge(status);
  };

  // 移除客户端过滤逻辑，现在由后端处理
  const visibleColumns = columns.filter(col => col.visible);

  const renderCell = (order, column) => {
    const value = order[column.key];

    switch (column.key) {
      case 'pickupStatus':
        return <span className="text-sm">{PICKUP_STATUS_LABELS[value] || '-'}</span>;
      case 'orderNumber':
        return (
          <div>
            <div className="mb-1 text-sm font-semibold text-gray-900">
              订单 ID：{order.id ?? '-'}
            </div>
            <button
              type="button"
              className="font-mono text-sm text-primary hover:underline disabled:cursor-wait disabled:opacity-60"
              disabled={copyingOrderId !== null}
              aria-label={`复制订单链接 ${value}`}
              title="点击复制订单链接"
              onClick={() => handleCopyOrderLink(order)}
            >
              {copyingOrderId === order.id ? '复制中...' : value}
            </button>
            <p className="mt-1 text-xs text-gray-500">
              {order.ingestionSource === 'aos'
                ? 'AOS 文件'
                : order.ingestionSource === 'email'
                  ? '邮件'
                  : '来源未知'}
            </p>
          </div>
        );
      case 'recipientTag':
        return (
          <div className="text-sm">
            <span>{value}</span>
            {order.recipientTagConflict && (
              <p className="mt-1 text-xs text-amber-700">
                与档案 TAG 不同：{order.recipientProfileTag}
              </p>
            )}
            {order.ingestionSource === 'aos' && !order.recipientLinked && (
              <p className="mt-1 text-xs text-amber-700">取机人待关联</p>
            )}
          </div>
        );

      case 'status': {
        const badge = getStatusBadge(value);
        return <span className={`badge ${badge.class}`}>{badge.text}</span>;
      }

      case 'emailOrderStatus': {
        const badge = getEmailOrderStatusBadge(value);
        return (
          <div className="text-sm">
            <span className={`badge ${badge.class}`}>{badge.text}</span>
            {order.emailStatusNeedsReview && (
              <p
                className="mt-1 text-xs text-amber-700"
                title={order.emailStatusReviewReasons.join('、')}
              >
                待核对
              </p>
            )}
            {order.emailStatusEvidenceAt && (
              <p className="mt-1 text-xs text-gray-500">
                证据 {formatOrderTime(order.emailStatusEvidenceAt)}
              </p>
            )}
          </div>
        );
      }

      case 'emailPickupInfo': {
        const pickup = value;
        if (!pickup) return <span className="text-gray-400">-</span>;
        const schedule =
          pickup.appointmentMode === 'business_hours'
            ? '营业时间内到店'
            : [pickup.pickupDate, [pickup.startTime, pickup.endTime].filter(Boolean).join('–')]
                .filter(Boolean)
                .join(' ');
        return (
          <div className="text-sm text-gray-700">
            <p className="font-medium text-gray-900">{pickup.storeName || '门店待确认'}</p>
            <p>{schedule || '时间待确认'}</p>
          </div>
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
            <ProductSummary products={order.products} selectedKeys={filters.productKeys} />
            <OrderAmount amount={order.orderAmount} compact />
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
        return (
          <span className="text-sm text-gray-600" title="北京时间，邮件或人工录入来源">
            {formatOrderTime(value)}
          </span>
        );

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
        const feedback = getOrderRefreshFeedback(order, rowRefresh[order.id]);
        const { status: state, busy } = feedback;
        const label =
          { submitting: '提交中', pending: '排队中', running: '刷新中' }[state] || '刷新官网';
        return (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center justify-end gap-2">
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
              {can(PERMISSIONS.ORDER_MAIL_MANAGE) && (
                <button
                  onClick={event => {
                    event.stopPropagation();
                    setMailOrder(order);
                  }}
                  className="btn btn-secondary text-sm inline-flex items-center gap-1"
                  aria-label={'订单邮件 ' + order.orderNumber}
                >
                  <Mail className="w-4 h-4" />
                  邮件
                </button>
              )}
              {can(PERMISSIONS.ORDERS_REFRESH) && (
                <button
                  onClick={event => {
                    event.stopPropagation();
                    handleRowRefresh(order);
                  }}
                  disabled={busy || browserRefreshOrderId === order.id}
                  aria-label={`${label} ${order.orderNumber}`}
                  className="btn btn-secondary text-sm inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
                  {label}
                </button>
              )}
              {canRefreshMailStatus && (
                <button
                  onClick={event => {
                    event.stopPropagation();
                    handleMailStatusRefresh(order);
                  }}
                  disabled={mailRefreshingIds.includes(order.id)}
                  aria-label={`刷新邮件状态 ${order.orderNumber}`}
                  className="btn btn-secondary text-sm inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <RefreshCw
                    className={`w-4 h-4 ${
                      mailRefreshingIds.includes(order.id) ? 'animate-spin' : ''
                    }`}
                  />
                  {mailRefreshingIds.includes(order.id) ? '提交中' : '刷新邮件状态'}
                </button>
              )}
            </div>
            {user?.role === 'admin' && can(PERMISSIONS.ORDERS_REFRESH) && (
              <BrowserRefreshButton
                order={order}
                disabled={
                  busy || (browserRefreshOrderId !== null && browserRefreshOrderId !== order.id)
                }
                onBusyChange={value => setBrowserRefreshOrderId(value ? order.id : null)}
                onUpdated={async () => {
                  setRowRefresh(previous => {
                    const next = { ...previous };
                    delete next[order.id];
                    return next;
                  });
                  await loadOrdersRef.current?.(true);
                }}
              />
            )}
            {state === 'failed' && (
              <div className="text-xs max-w-56 ml-auto text-right">
                <details onClick={event => event.stopPropagation()}>
                  <summary
                    className={`cursor-pointer ${feedback.isIdentityError ? 'text-red-700' : 'text-yellow-700'}`}
                  >
                    {feedback.label}
                  </summary>
                  <p className="mt-1 text-gray-600 break-words">{feedback.message}</p>
                  {feedback.failedAt && (
                    <p className="text-gray-500">失败时间：{formatOrderTime(feedback.failedAt)}</p>
                  )}
                </details>
                <p className="mt-1 text-gray-500">
                  {feedback.lastSuccessAt && feedback.lastSuccessAt !== '-'
                    ? '本次未更新，保留上次数据'
                    : '本次未更新，尚无官网同步数据'}
                </p>
                <p className="text-gray-500">
                  上次成功：
                  {formatOrderTime(feedback.lastSuccessAt, '尚未成功同步')}
                </p>
              </div>
            )}
            {['succeeded', 'skipped'].includes(state) && (
              <p
                role="status"
                className={`text-xs text-right ${state === 'succeeded' ? 'text-green-700' : 'text-gray-500'}`}
              >
                {feedback.label}
              </p>
            )}
          </div>
        );
      }

      default:
        return <span className="text-sm text-gray-600">{value}</span>;
    }
  };

  const activeFiltersCount = Object.values(filters).filter(value =>
    Array.isArray(value) ? value.length > 0 : value !== ''
  ).length;

  return (
    <div className="space-y-6">
      <AutoDismissToast toast={toast} onDismiss={dismissToast} />
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
              <span>刷新全部官网</span>
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
              placeholder="搜索系统订单 ID、官网订单号、Apple ID 或取机人..."
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

        <div className="order-filter-fields">
          <OrderDateFilter
            dateFrom={filters.dateFrom}
            dateTo={filters.dateTo}
            onChange={range => {
              setFilters(previous => ({ ...previous, ...range }));
              setPagination(previous => ({ ...previous, currentPage: 1 }));
            }}
          />
          {/* 官网状态 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">订单状态（邮件）</label>
            <TagMultiSelect
              options={Object.keys(EMAIL_ORDER_STATUS_LABELS)}
              optionLabels={EMAIL_ORDER_STATUS_LABELS}
              value={filters.emailOrderStatuses}
              onChange={value => handleFilterChange('emailOrderStatuses', value)}
              ariaLabel="邮件订单状态筛选"
              placeholder="全部状态"
              itemLabel="状态"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">官网状态</label>
            <TagMultiSelect
              options={Object.keys(ORDER_STATUS_LABELS)}
              optionLabels={ORDER_STATUS_LABELS}
              value={filters.statuses}
              onChange={value => handleFilterChange('statuses', value)}
              ariaLabel="官网状态筛选"
              placeholder="全部状态"
              itemLabel="状态"
            />
          </div>

          {/* 商品信息 */}
          <div className="order-filter-product">
            <label className="block text-sm font-medium text-gray-700 mb-2">商品信息</label>
            <ProductFilter
              options={filterOptions.productOptions || []}
              value={filters.productKeys}
              onChange={value => handleFilterChange('productKeys', value)}
            />
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

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">取机人 TAG</label>
            <TagMultiSelect
              options={filterOptions.recipientTags || []}
              value={filters.recipientTags}
              onChange={value => handleFilterChange('recipientTags', value)}
              ariaLabel="取机人 TAG 筛选"
              placeholder="全部 TAG"
              itemLabel="TAG"
            />
          </div>

          {/* 取货门店 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">取货门店</label>
            <TagMultiSelect
              options={filterOptions.stores}
              value={filters.pickupStores}
              onChange={value => handleFilterChange('pickupStores', value)}
              ariaLabel="取货门店筛选"
              placeholder="全部门店"
              itemLabel="门店"
            />
          </div>

          {/* 取货日期 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">取货日期</label>
            <input
              type="date"
              aria-label="取货日期筛选"
              value={filters.pickupDate}
              onChange={event => handleFilterChange('pickupDate', event.target.value)}
              className="input"
            />
          </div>
        </div>
      </div>

      {/* 订单列表 */}
      <div className="card">
        {canSelectOrders && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-gray-600">已选择 {selectedIds.length} 项（当前页）</span>
            <div className="flex flex-wrap items-center gap-2">
              {canExportOrders && (
                <button
                  className="btn btn-secondary flex items-center gap-2"
                  disabled={loading || exportingSelected || selectedIds.length === 0}
                  onClick={() => setShowExportModal(true)}
                >
                  <Download className="w-4 h-4" />
                  导出选中订单
                </button>
              )}
              {canRefreshOrders && (
                <button
                  className="btn btn-secondary flex items-center gap-2"
                  disabled={loading || batchSubmitting || selectedIds.length === 0}
                  onClick={handleSelectedRefresh}
                >
                  <RefreshCw className={`w-4 h-4 ${batchSubmitting ? 'animate-spin' : ''}`} />
                  {batchSubmitting ? '正在提交' : '批量刷新官网'}
                </button>
              )}
              {canRefreshMailStatus && (
                <button
                  className="btn btn-secondary flex items-center gap-2"
                  disabled={loading || mailBatchSubmitting || selectedIds.length === 0}
                  onClick={handleSelectedMailStatusRefresh}
                >
                  <RefreshCw className={`w-4 h-4 ${mailBatchSubmitting ? 'animate-spin' : ''}`} />
                  {mailBatchSubmitting ? '正在提交' : '批量刷新邮件状态'}
                </button>
              )}
            </div>
          </div>
        )}
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
                  {canSelectOrders && (
                    <th className="py-3 px-3 w-10">
                      <input
                        type="checkbox"
                        aria-label="全选本页订单"
                        disabled={batchSubmitting || mailBatchSubmitting || exportingSelected}
                        checked={
                          orders.length > 0 && orders.every(order => selectedIds.includes(order.id))
                        }
                        onChange={event =>
                          setSelectedIds(event.target.checked ? orders.map(order => order.id) : [])
                        }
                      />
                    </th>
                  )}
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
                    className="border-b border-gray-200 transition-colors hover:bg-gray-50"
                  >
                    {canSelectOrders && (
                      <td className="py-4 px-3">
                        <input
                          type="checkbox"
                          aria-label={`选择订单 ${order.orderNumber}`}
                          disabled={batchSubmitting || mailBatchSubmitting || exportingSelected}
                          checked={selectedIds.includes(order.id)}
                          onChange={event =>
                            setSelectedIds(previous =>
                              event.target.checked
                                ? [...previous, order.id]
                                : previous.filter(id => id !== order.id)
                            )
                          }
                        />
                      </td>
                    )}
                    <td className="py-4 px-3">
                      <OrderConflictIndicator issues={order.validationIssues} />
                    </td>
                    {visibleColumns.map(col => (
                      <td
                        key={col.key}
                        className={`py-4 px-4 ${col.key === 'actions' ? 'text-right sticky right-0 bg-white' : ''}`}
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

      {showExportModal && canExportOrders && (
        <OrderExportModal
          count={selectedIds.length}
          defaultFields={getDefaultOrderExportFields(columns)}
          onClose={() => setShowExportModal(false)}
          onExport={handleSelectedExport}
        />
      )}

      {/* 列配置弹窗 */}
      {showColumnConfig && (
        <ColumnConfigModal
          columns={columns}
          onSave={saveConfig}
          onReset={resetConfig}
          onClose={() => setShowColumnConfig(false)}
        />
      )}

      {mailOrder && can(PERMISSIONS.ORDER_MAIL_MANAGE) && (
        <OrderMailDrawer key={mailOrder.id} order={mailOrder} onClose={() => setMailOrder(null)} />
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
