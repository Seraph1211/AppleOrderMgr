import { useState, useEffect } from 'react';
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
  Upload,
  Zap,
  MapPin,
  Download,
  Link,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import {
  getRecipients,
  createRecipient,
  updateRecipient,
  deleteRecipient,
  exportRecipients,
} from '../api';
import { previewImport, executeImport } from '../api/importApi';
import {
  batchGenerateContact,
  batchGenerateAddress,
  batchBindAppleIds,
} from '../api/recipientsApi';
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
import BindAppleIdModal from '../components/BindAppleIdModal';
import { recipientsColumns } from '../constants/tableColumns';
import { STATUS_OPTIONS, STATUS_BADGE_MAP } from '../constants/status';

export default function Recipients() {
  const { isAdmin } = useAuth();
  const [recipients, setRecipients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [showColumnConfig, setShowColumnConfig] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showGenerateConfirm, setShowGenerateConfirm] = useState(false);
  const [showGenerateAddressModal, setShowGenerateAddressModal] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [showAlertModal, setShowAlertModal] = useState(false);
  const [alertMessage, setAlertMessage] = useState('');
  const [showExportConfirm, setShowExportConfirm] = useState(false);
  const [showBindModal, setShowBindModal] = useState(false);
  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [generatingAddress, setGeneratingAddress] = useState(false);
  const { columns, saveConfig, resetConfig } = useColumnConfig('recipients', recipientsColumns);

  // 分页状态
  const [pagination, setPagination] = useState({
    currentPage: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0,
  });

  useEffect(() => {
    loadRecipients();
  }, [pagination.currentPage, pagination.pageSize, searchTerm, filterTag, filterStatus]);

  const loadRecipients = async () => {
    setLoading(true);
    try {
      const params = {
        page: pagination.currentPage,
        limit: pagination.pageSize,
        keyword: searchTerm || undefined,
        tag: filterTag || undefined,
        status: filterStatus || undefined,
      };
      const res = await getRecipients(params);
      if (res.success) {
        setRecipients(
          res.data.recipients.map(item => ({
            id: item.id,
            name: item.name,
            lastName: item.last_name,
            firstName: item.first_name,
            idCard: item.id_card_number || item.id_card_last4,
            phone: item.phone || '-',
            email: item.email || '-',
            address: item.masked_address || '-',
            province: item.province || '',
            city: item.city || '',
            district: item.district || '',
            boundAppleId: item.apple_id || '-',
            tag: item.tag || '-',
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
      console.error('加载取机人失败:', error);
    } finally {
      setLoading(false);
    }
  };

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
    try {
      const normalizedName = formData.name.trim();
      const payload = {
        lastName: normalizedName.slice(0, 1),
        firstName: normalizedName.slice(1),
        email: formData.email || null,
        tag: formData.tag || null,
        status: formData.status,
      };
      if (formData.idCard && !formData.idCard.includes('*')) payload.idCardNumber = formData.idCard;
      if (formData.phone && !formData.phone.includes('*')) payload.phone = formData.phone;
      const response = await updateRecipient(id, payload);

      if (response.success) {
        await loadRecipients();
      } else {
        throw new Error(response.error || '更新失败');
      }
    } catch (error) {
      console.error('更新取机人失败:', error);
      throw error;
    }
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
      console.error('删除取机人失败:', error);
      alert(error.message || '删除失败');
    }
  };

  const handleBatchImport = async formData => {
    try {
      // 第一步：预览导入数据
      const file = formData.get('file');
      const previewRes = await previewImport(file, 'recipients');

      if (!previewRes.success) {
        throw new Error(previewRes.error || '数据预览失败');
      }

      // 第二步：执行导入
      const executeRes = await executeImport(previewRes.data.sessionToken);

      if (!executeRes.success) {
        throw new Error(executeRes.error || '导入失败');
      }

      // 导入成功后重新加载列表
      await loadRecipients();

      return {
        imported: executeRes.data.imported || 0,
        skipped: executeRes.data.skipped || 0,
        errors: executeRes.data.errors || [],
      };
    } catch (error) {
      console.error('批量导入失败:', error);
      throw error;
    }
  };

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

  const handleConfirmGenerate = async () => {
    setShowGenerateConfirm(false);
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
      console.error('批量生成联系方式失败:', error);
      setSuccessMessage(error.message || '生成失败，请稍后重试');
      setShowSuccessModal(true);
    } finally {
      setGenerating(false);
    }
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

  const handleConfirmGenerateAddress = async ({ province, city, district }) => {
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
      console.error('批量生成地址失败:', error);
      setSuccessMessage(error.message || '生成地址失败，请稍后重试');
      setShowSuccessModal(true);
    } finally {
      setGeneratingAddress(false);
    }
  };

  // 导出Excel
  const handleExport = () => {
    // 如果没有选中任何记录，显示确认对话框
    if (selectedIds.length === 0) {
      setShowExportConfirm(true);
      return;
    }

    // 有选中记录，直接导出
    executeExport();
  };

  const executeExport = async () => {
    try {
      const params = selectedIds.length
        ? { ids: selectedIds.join(',') }
        : {
            keyword: searchTerm || undefined,
            tag: filterTag || undefined,
            status: filterStatus || undefined,
          };
      const blob = await exportRecipients(params);
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

  // 批量绑定 Apple ID
  const handleBatchBindAppleIds = () => {
    if (selectedIds.length === 0) {
      setAlertMessage('请先选择需要绑定 Apple ID 的取机人');
      setShowAlertModal(true);
      return;
    }

    setShowBindModal(true);
  };

  const handleConfirmBind = async () => {
    try {
      const response = await batchBindAppleIds(selectedIds);

      if (response.success) {
        const { boundCount, unboundCount, availableCount } = response.data;

        let message = `成功绑定 ${boundCount} 个取机人`;
        if (unboundCount > 0) {
          message += `，${unboundCount} 个取机人因库存不足未绑定`;
        }

        setSuccessMessage(message);
        setShowSuccessModal(true);
        setSelectedIds([]);
        await loadRecipients();
      } else {
        throw new Error(response.error || '绑定失败');
      }
    } catch (error) {
      console.error('批量绑定 Apple ID 失败:', error);
      setAlertMessage(error.message || '绑定失败，请稍后重试');
      setShowAlertModal(true);
    }
  };

  const visibleColumns = columns.filter(col => col.visible);

  const getStatusBadge = status => {
    return STATUS_BADGE_MAP[status] || { text: status, class: 'badge-secondary' };
  };

  const renderCell = (item, column) => {
    switch (column.key) {
      case 'name':
        return (
          <div className="flex items-center space-x-3">
            <div className="flex-shrink-0">
              <div className="w-10 h-10 bg-primary-50 rounded-lg flex items-center justify-center">
                <User className="w-5 h-5 text-primary" />
              </div>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">{item.name}</p>
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
      case 'email':
        return <span className="text-sm text-gray-600">{item.email}</span>;
      case 'address':
        return <span className="text-sm text-gray-600">{item.address}</span>;
      case 'boundAppleId':
        return <span className="text-sm text-gray-600">{item.boundAppleId}</span>;
      case 'tag':
        return item.tag !== '-' ? (
          <span className="badge badge-info">{item.tag}</span>
        ) : (
          <span className="text-sm text-gray-400">-</span>
        );
      case 'status': {
        const badge = getStatusBadge(item.status);
        return <span className={`badge ${badge.class}`}>{badge.text}</span>;
      }
      case 'orderCount':
        return (
          <div className="flex items-center justify-center space-x-2">
            <Package className="w-4 h-4 text-gray-400" />
            <span className="text-lg font-semibold text-primary">{item.orderCount}</span>
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
            <button
              onClick={() => handleEdit(item)}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Edit className="w-4 h-4 text-gray-400 hover:text-primary" />
            </button>
            {isAdmin() && (
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
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">取机人管理</h1>
          <p className="text-gray-500 mt-1">管理所有取机人信息</p>
        </div>
        <div className="flex items-center space-x-3">
          <button onClick={handleExport} className="btn btn-secondary flex items-center space-x-2">
            <Download className="w-4 h-4" />
            <span>导出Excel</span>
          </button>
          <button
            onClick={() => setShowBatchImport(true)}
            className="btn btn-secondary flex items-center space-x-2"
          >
            <Upload className="w-4 h-4" />
            <span>批量导入</span>
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="btn btn-primary flex items-center space-x-2"
          >
            <Plus className="w-4 h-4" />
            <span>添加取机人</span>
          </button>
        </div>
      </div>

      {/* 搜索、筛选和批量操作 */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="搜索取机人姓名或电话..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="input pl-10 w-full"
            />
          </div>
          <select
            value={filterTag}
            onChange={e => setFilterTag(e.target.value)}
            className="input flex-shrink-0"
            style={{ width: 'auto' }}
          >
            <option value="">全部标签</option>
            <option value="刘天佟 微信">刘天佟 微信</option>
            <option value="群华华 微信">群华华 微信</option>
            <option value="水果惠">水果惠</option>
          </select>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="input flex-shrink-0"
            style={{ width: 'auto' }}
          >
            <option value="">全部状态</option>
            {STATUS_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
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
          <button
            onClick={handleBatchBindAppleIds}
            className="btn btn-primary flex items-center space-x-2 flex-shrink-0 whitespace-nowrap"
          >
            <Link className="w-4 h-4" />
            <span>
              {selectedIds.length > 0 ? `绑定Apple ID (${selectedIds.length})` : '绑定Apple ID'}
            </span>
          </button>
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

      {/* 列配置弹窗 */}
      {showColumnConfig && (
        <ColumnConfigModal
          columns={columns}
          onSave={saveConfig}
          onReset={resetConfig}
          onClose={() => setShowColumnConfig(false)}
        />
      )}

      {/* 添加取机人弹窗 */}
      {showAddModal && (
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
          message={`确定要为选中的 ${selectedIds.length} 个取机人生成电话和邮箱吗？\n电话号码格式：138xxxxxxxx（11位）\n邮箱格式：电话号码@8lvv.com`}
          type="generate"
          onConfirm={handleConfirmGenerate}
          onCancel={() => setShowGenerateConfirm(false)}
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

      {/* 绑定 Apple ID 弹窗 */}
      {showBindModal && (
        <BindAppleIdModal
          selectedRecipients={recipients.filter(r => selectedIds.includes(r.id))}
          onClose={() => setShowBindModal(false)}
          onConfirm={handleConfirmBind}
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
