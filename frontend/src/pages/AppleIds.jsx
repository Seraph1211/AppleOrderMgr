import { useState, useEffect } from 'react'
import { Search, Plus, Mail, Package, Edit, Trash2, Settings, Upload } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { getAppleIds, updateAppleId, deleteAppleId } from '../api'
import { previewImport, executeImport } from '../api/importApi'
import useColumnConfig from '../hooks/useColumnConfig'
import ColumnConfigModal from '../components/ColumnConfigModal'
import Pagination from '../components/Pagination'
import AddAppleIdModal from '../components/AddAppleIdModal'
import BatchImportModal from '../components/BatchImportModal'
import EditAppleIdModal from '../components/EditAppleIdModal'
import ConfirmModal from '../components/ConfirmModal'
import { appleIdsColumns } from '../constants/tableColumns'
import { STATUS_OPTIONS, STATUS_BADGE_MAP } from '../constants/status'

export default function AppleIds() {
  const { isAdmin } = useAuth()
  const [appleIds, setAppleIds] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterCountry, setFilterCountry] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [showColumnConfig, setShowColumnConfig] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [showBatchImport, setShowBatchImport] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [selectedItem, setSelectedItem] = useState(null)
  const { columns, saveConfig, resetConfig } = useColumnConfig('appleIds', appleIdsColumns)

  // 分页状态
  const [pagination, setPagination] = useState({
    currentPage: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0
  })

  useEffect(() => {
    loadAppleIds()
  }, [pagination.currentPage, pagination.pageSize, searchTerm, filterCountry, filterStatus])

  const loadAppleIds = async () => {
    setLoading(true)
    try {
      const params = {
        page: pagination.currentPage,
        limit: pagination.pageSize,
        keyword: searchTerm || undefined,
        country: filterCountry || undefined,
        status: filterStatus || undefined
      }
      const res = await getAppleIds(params)
      if (res.success) {
        setAppleIds(res.data.apple_ids.map(item => ({
          id: item.id,
          appleId: item.apple_id,
          password: item.password || '-',
          nickname: item.nickname || '-',
          securityQa: item.security_qa || null,
          country: item.country || '-',
          isModified: item.is_modified ? '是' : '否',
          status: item.status,
          orderCount: item.order_count || 0,
          lastOrderDate: item.last_order_date ? new Date(item.last_order_date).toLocaleDateString('zh-CN') : '-',
          createdAt: item.created_at,
          updatedAt: item.updated_at
        })))

        // 更新分页信息
        setPagination(prev => ({
          ...prev,
          totalItems: res.data.total,
          totalPages: Math.ceil(res.data.total / prev.pageSize)
        }))
      }
    } catch (error) {
      console.error('加载 Apple ID 失败:', error)
    } finally {
      setLoading(false)
    }
  }

  // 分页处理函数
  const handlePageChange = (page) => {
    setPagination(prev => ({ ...prev, currentPage: page }))
  }

  const handlePageSizeChange = (size) => {
    setPagination(prev => ({
      ...prev,
      pageSize: size,
      currentPage: 1,
      totalPages: Math.ceil(prev.totalItems / size)
    }))
  }

  const handleSaveAppleId = async (formData) => {
    // TODO: 调用后端 API 保存 Apple ID
    console.log('保存 Apple ID:', formData)
    // const response = await createAppleId(formData)
    // if (response.success) {
    //   await loadAppleIds()
    // }
    alert('保存成功！（演示模式）')
    await loadAppleIds()
  }

  const handleEdit = (item) => {
    setSelectedItem(item)
    setShowEditModal(true)
  }

  const handleSaveEdit = async (id, formData) => {
    try {
      // 构建密保 JSONB 对象
      const securityQa = (formData.question1 && formData.answer1) ? {
        question1: formData.question1,
        answer1: formData.answer1,
        question2: formData.question2 || null,
        answer2: formData.answer2 || null,
        question3: formData.question3 || null,
        answer3: formData.answer3 || null,
      } : null

      // 调用后端 API 更新
      const response = await updateAppleId(id, {
        password: formData.password,
        nickname: formData.nickname || null,
        country: formData.country || null,
        status: formData.status,
        security_qa: securityQa,
        is_modified: formData.isModified,
      })

      if (response.success) {
        await loadAppleIds()
      } else {
        throw new Error(response.error || '更新失败')
      }
    } catch (error) {
      console.error('更新 Apple ID 失败:', error)
      throw error
    }
  }

  const handleDelete = (item) => {
    setSelectedItem(item)
    setShowConfirmModal(true)
  }

  const handleConfirmDelete = async () => {
    try {
      // 调用后端 API 删除
      const response = await deleteAppleId(selectedItem.id)

      if (response.success) {
        setShowConfirmModal(false)
        setSelectedItem(null)
        await loadAppleIds()
      } else {
        throw new Error(response.error || '删除失败')
      }
    } catch (error) {
      console.error('删除 Apple ID 失败:', error)
      alert(error.message || '删除失败')
    }
  }

  const handleBatchImport = async (formData) => {
    try {
      // 第一步：预览导入数据
      const file = formData.get('file')
      const previewRes = await previewImport(file, 'apple_ids')

      if (!previewRes.success) {
        throw new Error(previewRes.error || '数据预览失败')
      }

      // 第二步：执行导入
      const executeRes = await executeImport('apple_ids', previewRes.data.preview)

      if (!executeRes.success) {
        throw new Error(executeRes.error || '导入失败')
      }

      // 导入成功后重新加载列表
      await loadAppleIds()

      return {
        imported: executeRes.data.imported || 0,
        skipped: executeRes.data.skipped || 0,
        errors: executeRes.data.errors || []
      }
    } catch (error) {
      console.error('批量导入失败:', error)
      throw error
    }
  }

  const visibleColumns = columns.filter(col => col.visible)

  const getStatusBadge = (status) => {
    return STATUS_BADGE_MAP[status] || { text: status, class: 'badge-secondary' }
  }

  const renderCell = (item, column) => {
    switch (column.key) {
      case 'appleId':
        return (
          <div className="flex items-center space-x-3">
            <div className="flex-shrink-0">
              <div className="w-10 h-10 bg-primary-50 rounded-lg flex items-center justify-center">
                <Mail className="w-5 h-5 text-primary" />
              </div>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">{item.appleId}</p>
            </div>
          </div>
        )
      case 'password':
        return <span className="text-sm text-gray-900 font-mono">{item.password}</span>
      case 'nickname':
        return <span className="text-sm text-gray-900">{item.nickname}</span>
      case 'securityQa':
        if (!item.securityQa) {
          return <span className="text-sm text-gray-400">未设置</span>
        }
        return (
          <div className="text-xs space-y-1">
            {item.securityQa.question1 && (
              <div>
                <span className="text-gray-500">问题1:</span> {item.securityQa.question1}
                <span className="text-gray-500 ml-2">答案:</span> <span className="font-mono">{item.securityQa.answer1}</span>
              </div>
            )}
            {item.securityQa.question2 && (
              <div>
                <span className="text-gray-500">问题2:</span> {item.securityQa.question2}
                <span className="text-gray-500 ml-2">答案:</span> <span className="font-mono">{item.securityQa.answer2}</span>
              </div>
            )}
            {item.securityQa.question3 && (
              <div>
                <span className="text-gray-500">问题3:</span> {item.securityQa.question3}
                <span className="text-gray-500 ml-2">答案:</span> <span className="font-mono">{item.securityQa.answer3}</span>
              </div>
            )}
          </div>
        )
      case 'country':
        return <span className="text-sm text-gray-600">{item.country}</span>
      case 'isModified':
        return <span className="text-sm text-gray-600">{item.isModified}</span>
      case 'status': {
        const badge = getStatusBadge(item.status)
        return <span className={`badge ${badge.class}`}>{badge.text}</span>
      }
      case 'orderCount':
        return (
          <div className="flex items-center justify-center space-x-2">
            <Package className="w-4 h-4 text-gray-400" />
            <span className="text-lg font-semibold text-primary">{item.orderCount}</span>
          </div>
        )
      case 'lastOrderDate':
        return <span className="text-sm text-gray-600">{item.lastOrderDate}</span>
      case 'createdAt':
        return <span className="text-sm text-gray-600">{new Date(item.createdAt).toLocaleDateString('zh-CN')}</span>
      case 'updatedAt':
        return <span className="text-sm text-gray-600">{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</span>
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
        )
      default:
        return null
    }
  }

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Apple ID 管理</h1>
          <p className="text-gray-500 mt-1">管理所有 Apple ID 账号</p>
        </div>
        <div className="flex items-center space-x-3">
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
            <span>添加 Apple ID</span>
          </button>
        </div>
      </div>

      {/* 搜索和筛选 */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="搜索 Apple ID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="input pl-10 w-full"
            />
          </div>
          <select
            value={filterCountry}
            onChange={(e) => setFilterCountry(e.target.value)}
            className="input flex-shrink-0"
            style={{ width: 'auto' }}
          >
            <option value="">全部国家地区</option>
            <option value="美国">美国</option>
            <option value="中国">中国</option>
            <option value="日本">日本</option>
            <option value="英国">英国</option>
            <option value="澳大利亚">澳大利亚</option>
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="input flex-shrink-0"
            style={{ width: 'auto' }}
          >
            <option value="">全部状态</option>
            {STATUS_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <button
            onClick={() => setShowColumnConfig(true)}
            className="btn btn-secondary flex items-center space-x-2 flex-shrink-0 whitespace-nowrap"
          >
            <Settings className="w-4 h-4" />
            <span>列设置</span>
          </button>
        </div>
      </div>

      {/* Apple ID 列表 */}
      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-gray-500">加载中...</p>
            </div>
          </div>
        ) : appleIds.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500">未找到 Apple ID</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  {visibleColumns.map((col) => (
                    <th
                      key={col.key}
                      className={`py-3 px-4 text-sm font-medium text-gray-500 whitespace-nowrap ${
                        col.key === 'orderCount' || col.key === 'lastOrderDate' || col.key === 'status'
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
                {appleIds.map((item) => (
                  <tr key={item.id} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
                    {visibleColumns.map((col) => (
                      <td
                        key={col.key}
                        className={`py-4 px-4 ${
                          col.key === 'orderCount' || col.key === 'lastOrderDate' || col.key === 'status'
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

      {/* 添加 Apple ID 弹窗 */}
      {showAddModal && (
        <AddAppleIdModal
          onClose={() => setShowAddModal(false)}
          onSave={handleSaveAppleId}
        />
      )}

      {/* 批量导入弹窗 */}
      {showBatchImport && (
        <BatchImportModal
          type="appleIds"
          onClose={() => setShowBatchImport(false)}
          onImport={handleBatchImport}
        />
      )}

      {/* 编辑弹窗 */}
      {showEditModal && selectedItem && (
        <EditAppleIdModal
          appleId={selectedItem}
          onClose={() => {
            setShowEditModal(false)
            setSelectedItem(null)
          }}
          onSave={handleSaveEdit}
        />
      )}

      {/* 删除确认弹窗 */}
      {showConfirmModal && selectedItem && (
        <ConfirmModal
          title="删除 Apple ID"
          message={`确定要删除 Apple ID "${selectedItem.appleId}" 吗？删除后无法恢复。`}
          type="danger"
          onConfirm={handleConfirmDelete}
          onCancel={() => {
            setShowConfirmModal(false)
            setSelectedItem(null)
          }}
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
  )
}
