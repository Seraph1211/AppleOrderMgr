import OrderAmount from '../components/OrderAmount';
import OrderMailDrawer from '../components/OrderMailDrawer';
import AutoDismissToast from '../components/AutoDismissToast';
import OrderExportModal from '../components/OrderExportModal';
import OrderDateFilter from '../components/OrderDateFilter';
import ProductFilter from '../components/ProductFilter';
import ProductSummary from '../components/ProductSummary';
import TableHeaderHint from '../components/TableHeaderHint';
import { formatOrderTime } from '../utils/orderTime';
import { copyDeferredText } from '../utils/copyDeferredText';
import { groupDisplayProducts } from '../utils/productDisplay';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Filter, Download, RefreshCw, Settings, X, Mail } from 'lucide-react';
import { getOrders, getOrderLink, getOrderFilterOptions, exportOrders } from '../api';
import useColumnConfig from '../hooks/useColumnConfig';
import ColumnConfigModal from '../components/ColumnConfigModal';
import OrderDetailModal from '../components/OrderDetailModal';
import { EMAIL_ORDER_STATUS_BADGES, getEmailOrderStatusBadge } from '../constants/orderStatus';
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
  const { can } = useAuth();
  const canReadMail = can(PERMISSIONS.ORDER_MAIL_READ) || can(PERMISSIONS.ORDER_MAIL_MANAGE);
  const canRefreshMailStatus = can(PERMISSIONS.ORDER_MAIL_MANAGE);
  const canExportOrders = can(PERMISSIONS.ORDERS_EXPORT);
  const canSelectOrders = canRefreshMailStatus || canExportOrders;
  const [mailOrder, setMailOrder] = useState(null);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [mailBatchSubmitting, setMailBatchSubmitting] = useState(false);
  const [mailRefreshingIds, setMailRefreshingIds] = useState([]);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportingSelected, setExportingSelected] = useState(false);
  const [copyingOrderId, setCopyingOrderId] = useState(null);
  const [toast, setToast] = useState(null);
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
  const [showMobileFilters, setShowMobileFilters] = useState(false);
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

  // 筛选/搜索改变时触发
  useEffect(() => {
    if (pagination.currentPage === 1) {
      loadOrders();
    } else {
      setPagination(prev => ({ ...prev, currentPage: 1 }));
    }
  }, [
    searchTerm,
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
      for (const key of ['emailOrderStatuses', 'productKeys', 'pickupStores', 'recipientTags']) {
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
          emailOrderStatus: order.email_order_status || 'unknown',
          emailStatusNeedsReview: Boolean(order.email_status_needs_review),
          emailStatusReviewReasons: order.email_status_review_reasons || [],
          emailStatusEvidenceAt: order.email_status_evidence_at || null,
          emailStatusVersion: order.email_status_version || 0,
          emailPickupInfo: order.email_pickup_info || null,
          emailLifecycleUpdatedAt: order.email_lifecycle_updated_at || '-',
          paymentAssignmentHoldReason: order.payment_assignment_hold_reason || null,
          orderAmount: order.order_amount ?? null,
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
          // 付款信息
          paymentMethod: order.payment_method || '-',
          payerName: order.payer_name || '-',
          payerVersion: order.payer_version || 0,
          paymentScreenshot: order.payment_screenshot || [],
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
      if (requestSequence === ordersRequestSequence.current) {
        showToast('error', error.message || '加载订单失败');
        if (!quiet) setOrders([]);
      }
    } finally {
      if (requestSequence === ordersRequestSequence.current) setLoading(false);
    }
  };

  loadOrdersRef.current = loadOrders;

  const handleExport = async () => {
    const params = { keyword: searchTerm || undefined, ...filters };
    for (const key of ['emailOrderStatuses', 'productKeys', 'pickupStores', 'recipientTags']) {
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

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    // 筛选条件变化时重置到第一页
    setPagination(prev => ({ ...prev, currentPage: 1 }));
  };

  const resetFilters = () => {
    setFilters({
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

  // 移除客户端过滤逻辑，现在由后端处理
  const visibleColumns = columns.filter(col => col.visible);

  const renderCell = (order, column) => {
    const value = order[column.key];

    switch (column.key) {
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

      case 'emailLifecycleUpdatedAt':
        return (
          <span className="text-sm text-gray-600" title="最后一次邮件解析并更新订单数据的时间">
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

      case 'createdAt':
      case 'updatedAt':
        return value !== '-' ? (
          <span className="text-sm text-gray-600">{new Date(value).toLocaleString('zh-CN')}</span>
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
        return (
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
            {canReadMail && (
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
    <div className="orders-page min-w-0 space-y-4 md:space-y-6">
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
        </div>
      </div>

      {/* 搜索栏 */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          {/* 搜索框 */}
          <div className="relative w-full min-w-0 sm:w-auto sm:flex-1">
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
      <button
        type="button"
        className="btn btn-secondary flex w-full items-center justify-between md:hidden"
        aria-expanded={showMobileFilters}
        aria-controls="orders-filters"
        onClick={() => setShowMobileFilters(previous => !previous)}
      >
        <span className="inline-flex items-center gap-2">
          <Filter className="w-4 h-4" />
          筛选条件 {activeFiltersCount > 0 && `(${activeFiltersCount})`}
        </span>
        <span>{showMobileFilters ? '收起' : '展开'}</span>
      </button>
      <div id="orders-filters" className={`card ${showMobileFilters ? '' : 'hidden md:block'}`}>
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
          {/* 邮件订单状态 */}
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
      <div className="card min-w-0">
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
          <>
            <div className="orders-mobile-list space-y-3 md:hidden">
              {orders.map(order => {
                const products = groupDisplayProducts(order.products);
                const status = getEmailOrderStatusBadge(order.emailOrderStatus);
                return (
                  <article key={order.id} className="rounded-lg border border-gray-200 bg-white p-3">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs text-gray-500">订单 ID：{order.id}</p>
                        <button
                          type="button"
                          className="mt-1 break-all text-left font-mono text-sm font-semibold text-primary"
                          disabled={copyingOrderId !== null}
                          aria-label={`复制订单链接 ${order.orderNumber}`}
                          onClick={() => handleCopyOrderLink(order)}
                        >
                          {copyingOrderId === order.id ? '复制中...' : order.orderNumber}
                        </button>
                      </div>
                      {canSelectOrders && (
                        <input
                          type="checkbox"
                          className="h-6 w-6 shrink-0"
                          aria-label={`选择订单 ${order.orderNumber}`}
                          disabled={mailBatchSubmitting || exportingSelected}
                          checked={selectedIds.includes(order.id)}
                          onChange={event =>
                            setSelectedIds(previous =>
                              event.target.checked
                                ? [...previous, order.id]
                                : previous.filter(id => id !== order.id)
                            )
                          }
                        />
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className={`badge ${status.class}`}>{status.text}</span>
                      {order.emailStatusNeedsReview && (
                        <span className="text-xs text-amber-700">待核对</span>
                      )}
                      <span className="text-xs text-gray-500">
                        {formatOrderTime(order.orderDate)}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 break-words text-sm text-gray-900">
                      {products.length
                        ? `${products[0].name} ×${products[0].quantity ?? '待核实'}`
                        : '商品待核实'}
                      {products.length > 1 && `，另 ${products.length - 1} 款`}
                    </p>
                    <p className="mt-1 truncate text-xs text-gray-600">
                      取机人：{order.recipientName || '-'}
                      {order.recipientTag && order.recipientTag !== '-'
                        ? ` · ${order.recipientTag}`
                        : ''}
                    </p>
                    <div className="orders-mobile-actions mt-3 border-t border-gray-100 pt-3">
                      {renderCell(order, { key: 'actions' })}
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="hidden min-w-0 md:block md:overflow-x-auto">
              <table className="w-full min-w-max">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    {canSelectOrders && (
                      <th className="py-3 px-3 w-10">
                        <input
                          type="checkbox"
                          aria-label="全选本页订单"
                          disabled={mailBatchSubmitting || exportingSelected}
                          checked={
                            orders.length > 0 && orders.every(order => selectedIds.includes(order.id))
                          }
                          onChange={event =>
                            setSelectedIds(event.target.checked ? orders.map(order => order.id) : [])
                          }
                        />
                      </th>
                    )}
                    {visibleColumns.map(col => (
                      <th
                        key={col.key}
                        className={`text-left py-3 px-4 text-sm font-medium text-gray-500 whitespace-nowrap ${
                          col.key === 'actions' ? 'text-right sticky right-0 bg-gray-50 z-10' : ''
                        }`}
                        style={{ minWidth: col.width }}
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {col.key === 'emailOrderStatus' && (
                            <TableHeaderHint label="订单状态说明">
                              <p>订单已确认：已下单，待付款</p>
                              <p>处理中：订单已付款</p>
                              <p>可取货：订单可取货</p>
                            </TableHeaderHint>
                          )}
                          {col.key === 'emailPickupInfo' && (
                            <TableHeaderHint label="取货信息说明">基于邮件数据更新</TableHeaderHint>
                          )}
                        </span>
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
                            disabled={mailBatchSubmitting || exportingSelected}
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
          </>
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

      {mailOrder && canReadMail && (
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
