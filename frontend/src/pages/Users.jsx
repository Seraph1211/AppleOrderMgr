import { useState, useEffect } from 'react'
import { Plus, Edit, Trash2, Unlock, Users as UsersIcon } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import client from '../api/client'
import AlertModal from '../components/AlertModal'
import ConfirmModal from '../components/ConfirmModal'
import AddUserModal from '../components/AddUserModal'
import EditUserModal from '../components/EditUserModal'

export default function Users() {
  const { isAdmin } = useAuth()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [alertModal, setAlertModal] = useState(null)
  const [confirmModal, setConfirmModal] = useState(null)
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [selectedUser, setSelectedUser] = useState(null)

  const [pagination, setPagination] = useState({ total: 0, page: 1, limit: 10 })

  // 获取用户列表
  const fetchUsers = async (page = 1) => {
    setLoading(true)
    try {
      const response = await client.get(`/users?page=${page}&limit=${pagination.limit}`)
      if (response.success && response.data) {
        setUsers(response.data.users)
        setPagination((prev) => ({
          ...prev,
          total: response.data.total ?? prev.total,
          page: response.data.page ?? page,
          limit: response.data.limit ?? prev.limit,
        }))
      }
    } catch (error) {
      setAlertModal({
        title: '加载失败',
        message: error.message || '获取用户列表失败',
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!isAdmin()) {
      setAlertModal({
        title: '权限不足',
        message: '您没有权限访问此页面',
      })
      return
    }
    fetchUsers(1)
  }, [])

  // 打开新增用户Modal
  const handleAdd = () => {
    setAddModalOpen(true)
  }

  // 打开编辑用户Modal
  const handleEdit = (user) => {
    setSelectedUser(user)
    setEditModalOpen(true)
  }

  // 删除用户
  const handleDelete = (user) => {
    setConfirmModal({
      title: '确认删除',
      message: `确定要删除用户 "${user.username}" 吗？此操作不可恢复。`,
      onConfirm: async () => {
        try {
          const response = await client.delete(`/users/${user.id}`)
          if (response.success) {
            setAlertModal({
              title: '成功',
              message: '用户删除成功',
            })
            fetchUsers(1)
          } else {
            setAlertModal({
              title: '删除失败',
              message: response.message || '用户删除失败',
            })
          }
        } catch (error) {
          setAlertModal({
            title: '删除失败',
            message: error.message || '用户删除失败',
          })
        }
        setConfirmModal(null)
      },
      onCancel: () => setConfirmModal(null),
    })
  }

  // 解锁用户
  const handleUnlock = (user) => {
    setConfirmModal({
      title: '确认解锁',
      message: `确定要解锁用户 "${user.username}" 吗？解锁后该用户可以正常登录。`,
      onConfirm: async () => {
        try {
          const response = await client.put(`/users/${user.id}/unlock`)
          if (response.success) {
            setAlertModal({
              title: '成功',
              message: '用户解锁成功',
            })
            fetchUsers(1)
          } else {
            setAlertModal({
              title: '解锁失败',
              message: response.message || '用户解锁失败',
            })
          }
        } catch (error) {
          setAlertModal({
            title: '解锁失败',
            message: error.message || '用户解锁失败',
          })
        }
        setConfirmModal(null)
      },
      onCancel: () => setConfirmModal(null),
    })
  }

  // 格式化日期
  const formatDate = (dateString) => {
    if (!dateString) return '-'
    const date = new Date(dateString)
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  // 渲染角色徽章
  const renderRoleBadge = (role) => {
    if (role === 'admin') {
      return <span className="badge badge-error">管理员</span>
    }
    return <span className="badge badge-info">普通用户</span>
  }

  // 渲染状态徽章
  const renderStatusBadge = (status) => {
    if (status === 'active') {
      return <span className="badge badge-success">正常</span>
    }
    return <span className="badge badge-warning">锁定</span>
  }

  if (!isAdmin()) {
    return null
  }

  return (
    <div>
      {/* 页面标题 */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-primary-50 rounded-lg flex items-center justify-center">
            <UsersIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">用户管理</h1>
            <p className="text-sm text-gray-500 mt-1">管理系统用户账号和权限</p>
          </div>
        </div>
        <button onClick={handleAdd} className="btn btn-primary">
          <Plus className="w-4 h-4 mr-2" />
          新增用户
        </button>
      </div>

      {/* 用户列表 */}
      <div className="card">
        {loading ? (
          <div className="text-center py-12">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            <p className="text-gray-500 mt-4">加载中...</p>
          </div>
        ) : users.length === 0 ? (
          <div className="text-center py-12">
            <UsersIcon className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500">暂无用户数据</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">用户名</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">角色</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">状态</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">最后登录</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">失败次数</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">创建时间</th>
                    <th className="text-right py-3 px-4 text-sm font-medium text-gray-500">操作</th>
                  </tr>
                </thead>
                <tbody className="bg-white">
                  {users.map((user) => (
                    <tr
                      key={user.id}
                      className="border-b border-gray-200 hover:bg-gray-50 transition-colors"
                    >
                      <td className="py-4 px-4">
                        <span className="font-medium text-gray-900">{user.username}</span>
                      </td>
                      <td className="py-4 px-4">{renderRoleBadge(user.role)}</td>
                      <td className="py-4 px-4">{renderStatusBadge(user.status)}</td>
                      <td className="py-4 px-4 text-sm text-gray-600">
                        {formatDate(user.lastLoginAt)}
                      </td>
                      <td className="py-4 px-4 text-sm text-gray-600">
                        {user.failedLoginAttempts || 0}
                      </td>
                      <td className="py-4 px-4 text-sm text-gray-600">
                        {formatDate(user.createdAt)}
                      </td>
                      <td className="py-4 px-4">
                        <div className="flex items-center justify-end space-x-2">
                          <button
                            onClick={() => handleEdit(user)}
                            className="text-primary hover:text-primary/80 transition-colors"
                            title="编辑"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                          {user.status === 'locked' && (
                            <button
                              onClick={() => handleUnlock(user)}
                              className="text-warning hover:text-warning/80 transition-colors"
                              title="解锁"
                            >
                              <Unlock className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(user)}
                            className="text-error hover:text-error/80 transition-colors"
                            title="删除"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 分页控件 */}
            {pagination.total > pagination.limit && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
                <p className="text-sm text-gray-500">
                  共 {pagination.total} 条，第 {pagination.page} 页 / 共{' '}
                  {Math.ceil(pagination.total / pagination.limit)} 页
                </p>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => fetchUsers(pagination.page - 1)}
                    disabled={pagination.page <= 1}
                    className="btn btn-secondary px-3 py-1 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    上一页
                  </button>
                  {Array.from(
                    { length: Math.ceil(pagination.total / pagination.limit) },
                    (_, i) => i + 1
                  ).map((pageNum) => (
                    <button
                      key={pageNum}
                      onClick={() => fetchUsers(pageNum)}
                      className={`px-3 py-1 text-sm rounded-lg transition-colors ${
                        pageNum === pagination.page
                          ? 'btn btn-primary'
                          : 'btn btn-secondary'
                      }`}
                    >
                      {pageNum}
                    </button>
                  ))}
                  <button
                    onClick={() => fetchUsers(pagination.page + 1)}
                    disabled={pagination.page >= Math.ceil(pagination.total / pagination.limit)}
                    className="btn btn-secondary px-3 py-1 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    下一页
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Modals */}
      {addModalOpen && (
        <AddUserModal
          onClose={() => setAddModalOpen(false)}
          onSuccess={() => {
            setAddModalOpen(false)
            fetchUsers(1)
          }}
        />
      )}

      {editModalOpen && selectedUser && (
        <EditUserModal
          user={selectedUser}
          onClose={() => {
            setEditModalOpen(false)
            setSelectedUser(null)
          }}
          onSuccess={() => {
            setEditModalOpen(false)
            setSelectedUser(null)
            fetchUsers(1)
          }}
        />
      )}

      {alertModal && (
        <AlertModal
          title={alertModal.title}
          message={alertModal.message}
          onClose={() => setAlertModal(null)}
        />
      )}

      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          onConfirm={confirmModal.onConfirm}
          onCancel={confirmModal.onCancel}
        />
      )}
    </div>
  )
}
