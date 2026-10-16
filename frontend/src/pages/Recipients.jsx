import ResponsiveSelect from '../components/responsiveSelect';
import ProfileAssociationModal from '../components/ProfileAssociationModal';
import ProfileDetailsModal from '../components/ProfileDetailsModal';
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Search,
  Plus,
  User,
  Package,
  CreditCard,
  Edit,
  Trash2,
  Phone,
  Settings,
  FileUp,
  Zap,
  MapPin,
  FileText,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import {
  getRecipients,
  getRecipientFilterOptions,
  createRecipient,
  updateRecipient,
  deleteRecipient,
  exportRecipients,
} from '../api';
import { batchGenerateContact, batchGenerateAddress } from '../api/recipientsApi';
import useColumnConfig from '../hooks/useColumnConfig';
import ColumnConfigModal from '../components/ColumnConfigModal';
import Pagination from '../components/Pagination';
import AddRecipientModal from '../components/AddRecipientModal';
import BatchImportModal from '../components/BatchImportModal';
import EditRecipientModal from '../components/EditRecipientModal';
import ConfirmModal from '../components/ConfirmModal';
import SuccessModal from '../components/SuccessModal';
import GenerateAddressModal from '../components/GenerateAddressModal';
import AlertModal from '../components/AlertModal';
import { recipientsColumns } from '../constants/tableColumns';
import { STATUS_OPTIONS, STATUS_BADGE_MAP } from '../constants/status';
import { PERMISSIONS } from '../constants/permissions';
import TagMultiSelect from '../components/TagMultiSelect';
import RecipientImportInfoModal from '../components/RecipientImportInfoModal';

export default function Recipients() {
  const { can, user } = useAuth();
  const canChangeOrderScope = user?.role === 'admin' || user?.orderAccess?.mode === 'all';
  const [recipients, setRecipients] = useState([]);
  const [showAssociations, setShowAssociations] = useState(false);
  const [detailItem, setDetailItem] = useState(null);
  const [pageError, setPageError] = useState('');
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterTags, setFilterTags] = useState([]);
  const [tagOptions, setTagOptions] = useState([]);
  const [filterStatus, setFilterStatus] = useState('');
  const [showColumnConfig, setShowColumnConfig] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showGenerateConfirm, setShowGenerateConfirm] = useState(false);
  const [showContactOverwriteConfirm, setShowContactOverwriteConfirm] = useState(false);
  const [showGenerateAddressModal, setShowGenerateAddressModal] = useState(false);
  const [showAddressOverwriteConfirm, setShowAddressOverwriteConfirm] = useState(false);
  const [pendingAddressParams, setPendingAddressParams] = useState(null);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [showAlertModal, setShowAlertModal] = useState(false);
  const [alertMessage, setAlertMessage] = useState('');
  const [showExportConfirm, setShowExportConfirm] = useState(false);
  const [showImportInfo, setShowImportInfo] = useState(false);
  const [importInfo, setImportInfo] = useState('');
  const [importInfoLoading, setImportInfoLoading] = useState(false);
  const [importInfoError, setImportInfoError] = useState('');
  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [generatingAddress, setGeneratingAddress] = useState(false);
  const { columns, saveConfig, resetConfig } = useColumnConfig('recipients', recipientsColumns);

  const requestSequence = useRef(0);

  // 分页状态
  const [pagination, setPagination] = useState({
    currentPage: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0,
  });

  useEffect(() => {
    setSelectedIds([]);
  }, [pagination.currentPage, pagination.pageSize, searchTerm, filterTags, filterStatus]);

  useEffect(() => {
    getRecipientFilterOptions()
      .then(response => {
        setTagOptions(response.data?.tags || []);
      })
      .catch(error => setPageError(error.message || '加载 TAG 选项失败'));
  }, []);

  const loadRecipients = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setPageError('');
    try {
      const params = {
        page: pagination.currentPage,
        limit: pagination.pageSize,
        keyword: searchTerm || undefined,
        tags: filterTags.length ? filterTags : undefined,
        status: filterStatus || undefined,
      };
      const res = await getRecipients(params);
      if (requestId !== requestSequence.current) return;
      if (!res.success) throw new Error(res.error?.message || '加载失败');
      if (res.success) {
        setRecipients(
          res.data.recipients.map(item => ({
            id: item.id,
            name: item.name,
            lastName: item.last_name,
            firstName: item.first_name,
            idCard: item.id_card_number || item.id_card_last4,
            phone: item.phone || '-',
            realPhone: item.real_phone || '',
            notes: item.notes || '',
            streetAddress: item.street_address || '',
            email: item.email || '-',
            address: item.street_address
              ? [item.province, item.city, item.district, item.street_address]
                  .filter(Boolean)
                  .join('')
              : item.masked_address || '-',
            province: item.province || '',
            city: item.city || '',
            district: item.district || '',
            tag: item.tag || '-',
            creditRating: item.credit_rating || '',
            status: item.status,
            orderCount: item.order_count || 0,
            createdAt: item.created_at,
          }))
        );

        // 更新分页信息
        setPagination(prev => ({
          ...prev,
          totalItems: res.data.total,
          totalPages: Math.ceil(res.data.total / prev.pageSize),
        }));
      }
    } catch (error) {
      if (requestId === requestSequence.current) {
        setPageError(error.message || '加载取机人失败');
        setRecipients([]);
        setPagination(previous => ({
          ...previous,
          totalItems: 0,
          totalPages: 0,
        }));
      }
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [pagination.currentPage, pagination.pageSize, searchTerm, filterTags, filterStatus]);

  useEffect(() => {
    loadRecipients();
    return () => {
      requestSequence.current += 1;
    };
  }, [loadRecipients]);

  // 分页处理函数
  const handlePageChange = page => {
    setPagination(prev => ({ ...prev, currentPage: page }));
  };

  const handlePageSizeChange = size => {
    setPagination(prev => ({
      ...prev,
      pageSize: size,
      currentPage: 1,
      totalPages: Math.ceil(prev.totalItems / size),
    }));
  };

  // 后端已按关键词和分页返回结果，不再对当前页脱敏值二次过滤。
  const filteredRecipients = recipients;
  const selectedRecipients = recipients.filter(recipient => selectedIds.includes(recipient.id));
  const existingContactCount = selectedRecipients.filter(
    recipient =>
      (recipient.phone && recipient.phone !== '-') || (recipient.email && recipient.email !== '-')
  ).length;
  const existingAddressCount = selectedRecipients.filter(
    recipient => recipient.address && recipient.address !== '-'
  ).length;

  const handleSaveRecipient = async formData => {
    const response = await createRecipient(formData);
    if (!response.success) throw new Error(response.error?.message || '保存失败');
    await loadRecipients();
  };

  const handleEdit = item => {
    setSelectedItem(item);
    setShowEditModal(true);
  };

  const handleSaveEdit = async (id, formData) => {
    await updateRecipient(id, formData);
    await loadRecipients();
  };

  const handleDelete = item => {
    setSelectedItem(item);
    setShowConfirmModal(true);
  };

  const handleConfirmDelete = async () => {
    try {
      // 调用后端 API 删除
      const response = await deleteRecipient(selectedItem.id);

      if (response.success) {
        setShowConfirmModal(false);
        setSelectedItem(null);
        await loadRecipients();
      } else {
        throw new Error(response.error || '删除失败');
      }
    } catch (error) {
      alert(error.message || '删除失败');
    }
  };

  const handleBatchImport = loadRecipients;

  // 全选/取消全选
  const handleSelectAll = e => {
    if (e.target.checked) {
      setSelectedIds(filteredRecipients.map(r => r.id));
    } else {
      setSelectedIds([]);
    }
  };

  // 单选
  const handleSelectOne = id => {
    setSelectedIds(prev => {
      if (prev.includes(id)) {
        return prev.filter(item => item !== id);
      } else {
        return [...prev, id];
      }
    });
  };

  // 批量生成联系方式
  const handleBatchGenerate = async () => {
    if (selectedIds.length === 0) {
      setAlertMessage('请先选择需要生成联系方式的取机人记录');
      setShowAlertModal(true);
      return;
    }

    setShowGenerateConfirm(true);
  };

  const executeContactGeneration = async () => {
    setGenerating(true);

    try {
      const response = await batchGenerateContact(selectedIds);

      if (response.success) {
        setSuccessMessage(`成功生成 ${response.data.updated} 个取机人的联系方式`);
        setShowSuccessModal(true);
        setSelectedIds([]);
        await loadRecipients();
      } else {
        throw new Error(response.error || '生成失败');
      }
    } catch (error) {
      setSuccessMessage(error.message || '生成失败，请稍后重试');
      setShowSuccessModal(true);
    } finally {
      setGenerating(false);
    }
  };

  const handleConfirmGenerate = () => {
    setShowGenerateConfirm(false);
    if (existingContactCount > 0) {
      setShowContactOverwriteConfirm(true);
      return;
    }

    executeContactGeneration();
  };

  const handleConfirmContactOverwrite = () => {
    setShowContactOverwriteConfirm(false);
    executeContactGeneration();
  };

  // 批量生成地址
  const handleBatchGenerateAddress = () => {
    if (selectedIds.length === 0) {
      setAlertMessage('请先选择需要生成地址的取机人记录');
      setShowAlertModal(true);
      return;
    }

    setShowGenerateAddressModal(true);
  };

  const executeAddressGeneration = async ({ province, city, district }) => {
    setGeneratingAddress(true);

    try {
      const response = await batchGenerateAddress(selectedIds, province, city, district);

      if (response.success) {
        setSuccessMessage(`成功生成 ${response.data.updated} 个取机人的地址信息`);
        setShowSuccessModal(true);
        setSelectedIds([]);
        await loadRecipients();
      } else {
        throw new Error(response.error || '生成地址失败');
      }
    } catch (error) {
      setSuccessMessage(error.message || '生成地址失败，请稍后重试');
      setShowSuccessModal(true);
    } finally {
      setGeneratingAddress(false);
    }
  };

  const handleConfirmGenerateAddress = addressParams => {
    if (existingAddressCount > 0) {
      setPendingAddressParams(addressParams);
      setShowAddressOverwriteConfirm(true);
      return;
    }

    executeAddressGeneration(addressParams);
  };

  const handleConfirmAddressOverwrite = () => {
    const addressParams = pendingAddressParams;
    setShowAddressOverwriteConfirm(false);
    setPendingAddressParams(null);
    if (addressParams) {
      executeAddressGeneration(addressParams);
    }
  };

  const handleCancelAddressOverwrite = () => {
    setShowAddressOverwriteConfirm(false);
    setPendingAddressParams(null);
  };

  // 完整录入信息在弹窗展示；无敏感权限时保留脱敏 Excel 下载。
  const handleExport = () => {
    if (can(PERMISSIONS.RECIPIENTS_EXPORT_SENSITIVE)) {
      if (selectedIds.length === 0) {
        setAlertMessage('请先选择需要查看录入信息的取机人记录');
        setShowAlertModal(true);
        return;
      }
      loadSelectedImportInfo();
      return;
    }

    if (selectedIds.length === 0) {
      setShowExportConfirm(true);
      return;
    }

    executeExport();
  };

  const loadSelectedImportInfo = async () => {
    setShowImportInfo(true);
    setImportInfo('');
    setImportInfoError('');
    setImportInfoLoading(true);
    try {
      const blob = await exportRecipients({
        ids: selectedIds.join(','),
        includeSensitive: true,
      });
      setImportInfo(await blob.text());
    } catch (error) {
      setImportInfoError(error.message || '生成录入信息失败，请稍后重试');
    } finally {
      setImportInfoLoading(false);
    }
  };

  const executeExport = async () => {
    try {
      const params = selectedIds.length
        ? { ids: selectedIds.join(',') }
        : {
            keyword: searchTerm || undefined,
            tags: filterTags.length ? filterTags : undefined,
            status: filterStatus || undefined,
          };
      const blob = await exportRecipients({
        ...params,
        includeSensitive: false,
      });
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `取机人数据_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (error) {
      setAlertMessage(error.message || '导出失败，请稍后重试');
      setShowAlertModal(true);
    }
  };

  const availableColumns = columns.filter(
    col =>
      can(PERMISSIONS.ORDERS_READ) ||
      !['orderCount', 'totalAmount', 'lastOrderDate'].includes(col.key)
  );
  const visibleColumns = availableColumns.filter(col => col.visible);

  const getStatusBadge = status => {
    return STATUS_BADGE_MAP[status] || { text: status, class: 'badge-secondary' };
  };

  const renderCell = (item, column) => {
    switch (column.key) {
      case 'name':
        return (
          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex-shrink-0">
              <div className="w-10 h-10 bg-primary-50 rounded-lg flex items-center justify-center">
                <User className="w-5 h-5 text-primary" />
              </div>
            </div>
            <div>
              <button
                className="text-sm font-medium text-primary hover:underline"
                onClick={() => setDetailItem(item)}
              >
                {item.name}
              </button>
            </div>
          </div>
        );
      case 'idCard':
        return <span className="text-sm font-mono text-gray-600">{item.idCard}</span>;
      case 'phone':
        return (
          <div className="flex items-center space-x-2 text-sm text-gray-600">
            <Phone className="w-4 h-4 text-gray-400" />
            <span>{item.phone}</span>
          </div>
        );
      case 'realPhone':
      case 'notes':
        return <span className="text-sm text-gray-600">{item[column.key] || '-'}</span>;
      case 'email':
        return <span className="text-sm text-gray-600">{item.email}</span>;
      case 'address':
        return <span className="text-sm text-gray-600">{item.address}</span>;
      case 'tag':
        return item.tag !== '-' ? (
          <span className="badge badge-info">{item.tag}</span>
        ) : (
          <span className="text-sm text-gray-400">-</span>
        );
      case 'creditRating':
        return <span className="text-sm text-gray-600">{item.creditRating || '—'}</span>;
      case 'status': {
        const badge = getStatusBadge(item.status);
        return <span className={`badge ${badge.class}`}>{badge.text}</span>;
      }
      case 'orderCount':
        return (
          <div className="flex items-center justify-center space-x-2">
            <Package className="w-4 h-4 text-gray-400" />
            <button
              className="text-lg font-semibold text-primary underline"
              disabled={!can(PERMISSIONS.ORDERS_READ)}
              onClick={() => setDetailItem(item)}
            >
              {item.orderCount}
            </button>
          </div>
        );
      case 'totalAmount':
        return (
          <div className="flex items-center justify-center space-x-2">
            <CreditCard className="w-4 h-4 text-gray-400" />
            <span className="text-lg font-semibold text-purple-600">
              ¥{parseInt(item.totalAmount).toLocaleString()}
            </span>
          </div>
        );
      case 'lastOrderDate':
        return <span className="text-sm text-gray-600">{item.lastOrderDate}</span>;
      case 'createdAt':
        return (
          <span className="text-sm text-gray-600">
            {new Date(item.createdAt).toLocaleDateString('zh-CN')}
          </span>
        );
      case 'actions':
        return (
          <div className="flex items-center justify-end space-x-2">
            {can(PERMISSIONS.ORDERS_READ) && (
              <button
                className="btn btn-secondary whitespace-nowrap"
                onClick={() => setDetailItem(item)}
              >
                名下订单
              </button>
            )}
            {can(PERMISSIONS.RECIPIENTS_EDIT) && (
              <button
                onClick={() => handleEdit(item)}
                aria-label={`编辑取机人 ${item.id}`}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <Edit className="w-4 h-4 text-gray-400 hover:text-primary" />
              </button>
            )}
            {can(PERMISSIONS.RECIPIENTS_DELETE) && canChangeOrderScope && (
              <button
                onClick={() => handleDelete(item)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <Trash2 className="w-4 h-4 text-gray-400 hover:text-red-500" />
              </button>
            )}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {pageError && (
        <p role="alert" className="text-red-700 bg-red-50 p-3 rounded">
          {pageError}
        </p>
      )}
      {/* 页面标题 */}
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">取机人管理</h1>
          <p className="text-gray-500 mt-1">管理所有取机人信息</p>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          {canChangeOrderScope &&
            ['orders.read', 'orders.edit', 'recipients.read', 'apple_ids.read'].every(can) && (
              <button className="btn btn-secondary" onClick={() => setShowAssociations(true)}>
                关联历史订单
              </button>
            )}
          {can(PERMISSIONS.RECIPIENTS_EXPORT) && (
            <button
              onClick={handleExport}
              className="btn btn-secondary flex items-center space-x-2"
            >
              <FileText className="w-4 h-4" />
              <span>
                {can(PERMISSIONS.RECIPIENTS_EXPORT_SENSITIVE) ? '导出录入信息' : '导出脱敏资料'}
              </span>
            </button>
          )}
          {can(PERMISSIONS.RECIPIENTS_IMPORT) && (
            <button
              onClick={() => setShowBatchImport(true)}
              className="btn btn-secondary flex items-center space-x-2"
            >
              <FileUp className="w-4 h-4" />
              <span>批量导入</span>
            </button>
          )}
          {can(PERMISSIONS.RECIPIENTS_CREATE) && canChangeOrderScope && (
            <button
              onClick={() => setShowAddModal(true)}
              className="btn btn-primary flex items-center space-x-2"
            >
              <Plus className="w-4 h-4" />
              <span>添加取机人</span>
            </button>
          )}
        </div>
      </div>

      {!canChangeOrderScope &&
        (can(PERMISSIONS.RECIPIENTS_CREATE) ||
          can(PERMISSIONS.RECIPIENTS_EDIT) ||
          can(PERMISSIONS.RECIPIENTS_IMPORT)) && (
          <p className="text-sm text-gray-500">
            新建取机人及修改姓名、身份证、TAG
            需要全部订单数据范围；联系方式、地址和状态等资料仍可按权限维护。
          </p>
        )}

      {/* 搜索、筛选和批量操作 */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="搜索姓名、身份证号..."
              value={searchTerm}
              onChange={e => {
                setSearchTerm(e.target.value);
                setPagination(previous => ({ ...previous, currentPage: 1 }));
              }}
              className="input pl-10 w-full"
            />
          </div>
          <div className="w-full sm:w-[240px]">
            <TagMultiSelect
              options={tagOptions}
              value={filterTags}
              onChange={value => {
                setFilterTags(value);
                setPagination(previous => ({ ...previous, currentPage: 1 }));
              }}
              ariaLabel="TAG 筛选"
              placeholder="全部 TAG"
            />
          </div>
          <ResponsiveSelect
            value={filterStatus}
            onChange={e => {
              setFilterStatus(e.target.value);
              setPagination(previous => ({ ...previous, currentPage: 1 }));
            }}
            className="input flex-shrink-0"
            style={{ width: 'auto' }}
          >
            <option value="">全部状态</option>
            {STATUS_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </ResponsiveSelect>
          {can(PERMISSIONS.RECIPIENTS_GENERATE_CONTACT) && (
            <button
              onClick={handleBatchGenerate}
              disabled={generating}
              className="btn btn-primary flex items-center space-x-2 flex-shrink-0 whitespace-nowrap"
            >
              <Zap className="w-4 h-4" />
              <span>
                {generating
                  ? '生成中...'
                  : selectedIds.length > 0
                    ? `生成联系方式 (${selectedIds.length})`
                    : '生成联系方式'}
              </span>
            </button>
          )}
          {can(PERMISSIONS.RECIPIENTS_GENERATE_ADDRESS) && (
            <button
              onClick={handleBatchGenerateAddress}
              disabled={generatingAddress}
              className="btn btn-primary flex items-center space-x-2 flex-shrink-0 whitespace-nowrap"
            >
              <MapPin className="w-4 h-4" />
              <span>
                {generatingAddress
                  ? '生成中...'
                  : selectedIds.length > 0
                    ? `生成地址 (${selectedIds.length})`
                    : '生成地址'}
              </span>
            </button>
          )}
          <button
            onClick={() => setShowColumnConfig(true)}
            className="btn btn-secondary flex items-center space-x-2 flex-shrink-0 whitespace-nowrap"
          >
            <Settings className="w-4 h-4" />
            <span>列设置</span>
          </button>
        </div>
      </div>

      {/* 取机人列表 */}
      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-gray-500">加载中...</p>
            </div>
          </div>
        ) : filteredRecipients.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500">未找到取机人</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="py-3 px-4 text-center" style={{ width: '50px' }}>
                    <input
                      type="checkbox"
                      checked={
                        selectedIds.length === filteredRecipients.length &&
                        filteredRecipients.length > 0
                      }
                      onChange={handleSelectAll}
                      className="w-4 h-4 text-primary border-gray-300 rounded focus:ring-primary"
                    />
                  </th>
                  {visibleColumns.map(col => (
                    <th
                      key={col.key}
                      className={`py-3 px-4 text-sm font-medium text-gray-500 whitespace-nowrap ${
                        col.key === 'orderCount' ||
                        col.key === 'totalAmount' ||
                        col.key === 'lastOrderDate' ||
                        col.key === 'status'
                          ? 'text-center'
                          : col.key === 'actions'
                            ? 'text-right'
                            : 'text-left'
                      }`}
                      style={{ minWidth: col.width }}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-white">
                {filteredRecipients.map(item => (
                  <tr
                    key={item.id}
                    className="border-b border-gray-200 hover:bg-gray-50 transition-colors"
                  >
                    <td className="py-4 px-4 text-center">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(item.id)}
                        onChange={() => handleSelectOne(item.id)}
                        className="w-4 h-4 text-primary border-gray-300 rounded focus:ring-primary"
                      />
                    </td>
                    {visibleColumns.map(col => (
                      <td
                        key={col.key}
                        className={`py-4 px-4 ${
                          col.key === 'orderCount' ||
                          col.key === 'totalAmount' ||
                          col.key === 'lastOrderDate' ||
                          col.key === 'status'
                            ? 'text-center'
                            : ''
                        }`}
                      >
                        {renderCell(item, col)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showAssociations && (
        <ProfileAssociationModal
          onClose={() => setShowAssociations(false)}
          onComplete={loadRecipients}
        />
      )}
      {detailItem && (
        <ProfileDetailsModal
          key={detailItem.id}
          kind="recipient"
          item={detailItem}
          onClose={() => setDetailItem(null)}
        />
      )}

      {/* 列配置弹窗 */}
      {showColumnConfig && (
        <ColumnConfigModal
          columns={availableColumns}
          onSave={saveConfig}
          onReset={resetConfig}
          onClose={() => setShowColumnConfig(false)}
        />
      )}

      {/* 添加取机人弹窗 */}
      {showAddModal && canChangeOrderScope && (
        <AddRecipientModal onClose={() => setShowAddModal(false)} onSave={handleSaveRecipient} />
      )}

      {/* 批量导入弹窗 */}
      {showBatchImport && (
        <BatchImportModal
          type="recipients"
          onClose={() => setShowBatchImport(false)}
          onImport={handleBatchImport}
        />
      )}

      {/* 编辑弹窗 */}
      {showEditModal && selectedItem && (
        <EditRecipientModal
          recipient={selectedItem}
          onClose={() => {
            setShowEditModal(false);
            setSelectedItem(null);
          }}
          onSave={handleSaveEdit}
        />
      )}

      {/* 删除确认弹窗 */}
      {showConfirmModal && selectedItem && (
        <ConfirmModal
          title="删除取机人"
          message={`确定要删除取机人 "${selectedItem.name}" 吗？删除后无法恢复。`}
          type="danger"
          onConfirm={handleConfirmDelete}
          onCancel={() => {
            setShowConfirmModal(false);
            setSelectedItem(null);
          }}
        />
      )}

      {/* 批量生成确认弹窗 */}
      {showGenerateConfirm && (
        <ConfirmModal
          title="生成联系方式"
          message={`确定要为选中的 ${selectedIds.length} 个取机人生成电话和邮箱吗？\n电话号码格式：1[3-9]xxxxxxxxx（11位）\n邮箱格式：电话号码@vvv8.net`}
          type="generate"
          onConfirm={handleConfirmGenerate}
          onCancel={() => setShowGenerateConfirm(false)}
        />
      )}

      {showContactOverwriteConfirm && (
        <ConfirmModal
          title="二次确认：覆盖联系方式"
          message={`选中的取机人中有 ${existingContactCount} 个已有电话或邮箱。\n继续生成将覆盖这些联系方式，是否确认继续？`}
          type="danger"
          onConfirm={handleConfirmContactOverwrite}
          onCancel={() => setShowContactOverwriteConfirm(false)}
        />
      )}

      {/* 生成地址弹窗 */}
      {showGenerateAddressModal && (
        <GenerateAddressModal
          isOpen={showGenerateAddressModal}
          onClose={() => setShowGenerateAddressModal(false)}
          onConfirm={handleConfirmGenerateAddress}
          selectedCount={selectedIds.length}
        />
      )}

      {showAddressOverwriteConfirm && (
        <ConfirmModal
          title="二次确认：覆盖地址"
          message={`选中的取机人中有 ${existingAddressCount} 个已有地址。\n继续生成将覆盖这些地址，是否确认继续？`}
          type="danger"
          onConfirm={handleConfirmAddressOverwrite}
          onCancel={handleCancelAddressOverwrite}
        />
      )}

      {/* 成功提示弹窗 */}
      {showSuccessModal && (
        <SuccessModal
          title="操作完成"
          message={successMessage}
          onClose={() => setShowSuccessModal(false)}
        />
      )}

      {/* 提示弹窗 */}
      {showAlertModal && (
        <AlertModal title="提示" message={alertMessage} onClose={() => setShowAlertModal(false)} />
      )}

      {showImportInfo && (
        <RecipientImportInfoModal
          content={importInfo}
          loading={importInfoLoading}
          error={importInfoError}
          onClose={() => setShowImportInfo(false)}
        />
      )}

      {/* 导出确认弹窗 */}
      {showExportConfirm && (
        <ConfirmModal
          title="导出Excel"
          message="未选择任何取机人记录。是否要导出全部取机人数据？"
          type="info"
          onConfirm={() => {
            setShowExportConfirm(false);
            executeExport();
          }}
          onCancel={() => setShowExportConfirm(false)}
        />
      )}

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
