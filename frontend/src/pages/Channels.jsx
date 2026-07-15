import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Search, Edit, TrendingUp } from 'lucide-react'
import { getChannels, updateChannelName } from '../api'
import EditChannelModal from '../components/EditChannelModal'
import Pagination from '../components/Pagination'

export default function Channels() {
  const [channels, setChannels] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [editingChannel, setEditingChannel] = useState(null)

  // 分页状态
  const [pagination, setPagination] = useState({
    currentPage: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0
  })

  useEffect(() => {
    loadChannels()
  }, [])

  const loadChannels = async () => {
    setLoading(true)
    try {
      const res = await getChannels()
      console.log('API响应:', res)
      if (res.success) {
        console.log('渠道数据:', res.data.channels)
        setChannels(res.data.channels)
      } else {
        console.error('API返回success=false')
      }
    } catch (error) {
      console.error('加载渠道列表失败:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleEditChannel = (channel) => {
    setEditingChannel(channel)
  }

  const handleSaveChannel = async (oldTag, newTag) => {
    try {
      const res = await updateChannelName(oldTag, newTag)
      if (res.success) {
        // 刷新列表
        await loadChannels()
        setEditingChannel(null)
      }
    } catch (error) {
      console.error('修改渠道名称失败:', error)
      throw error
    }
  }

  // 搜索过滤
  const filteredChannels = channels.filter(channel =>
    channel.channelName.toLowerCase().includes(searchTerm.toLowerCase())
  )

  // 前端分页（因为后端返回全部数据）
  const paginatedChannels = filteredChannels.slice(
    (pagination.currentPage - 1) * pagination.pageSize,
    pagination.currentPage * pagination.pageSize
  )

  // 更新总数
  useEffect(() => {
    setPagination(prev => ({
      ...prev,
      totalItems: filteredChannels.length,
      totalPages: Math.ceil(filteredChannels.length / prev.pageSize)
    }))
  }, [filteredChannels.length, pagination.pageSize])

  // 分页处理函数
  const handlePageChange = (page) => {
    setPagination(prev => ({ ...prev, currentPage: page }))
  }

  const handlePageSizeChange = (size) => {
    setPagination(prev => ({
      ...prev,
      pageSize: size,
      currentPage: 1,
      totalPages: Math.ceil(filteredChannels.length / size)
    }))
  }

  console.log('当前channels:', channels)
  console.log('过滤后channels:', filteredChannels)
  console.log('分页后channels:', paginatedChannels)

  // 计算总计（基于过滤后的全部数据）
  const totals = filteredChannels.reduce((acc, channel) => ({
    totalOrders: acc.totalOrders + channel.totalOrders,
    paidOrders: acc.paidOrders + channel.paidOrders,
    deliveredOrders: acc.deliveredOrders + channel.deliveredOrders,
    totalAmount: acc.totalAmount + (channel.totalAmount || 0),
    paidAmount: acc.paidAmount + (channel.paidAmount || 0),
    deliveredAmount: acc.deliveredAmount + (channel.deliveredAmount || 0),
  }), {
    totalOrders: 0,
    paidOrders: 0,
    deliveredOrders: 0,
    totalAmount: 0,
    paidAmount: 0,
    deliveredAmount: 0
  })

  console.log('统计totals:', totals)

  // 格式化金额
  const formatAmount = (amount) => {
    return `¥${amount.toLocaleString('zh-CN')}`
  }

  return (
    <div className="space-y-6">
      {/* 页头 */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">渠道管理</h1>
          <p className="text-sm text-gray-500 mt-1">
            基于订单标签的渠道统计和管理
          </p>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">渠道总数</p>
              <p className="text-3xl font-bold text-gray-900 mt-2">{channels.length}</p>
            </div>
            <div className="w-12 h-12 bg-blue-50 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-blue-600" />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">总订单数</p>
              <p className="text-3xl font-bold text-gray-900 mt-2">{totals.totalOrders}</p>
            </div>
            <div className="w-12 h-12 bg-green-50 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-green-600" />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">已取货订单</p>
              <p className="text-3xl font-bold text-gray-900 mt-2">{totals.deliveredOrders}</p>
            </div>
            <div className="w-12 h-12 bg-purple-50 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-purple-600" />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">总订单金额</p>
              <p className="text-2xl font-bold text-gray-900 mt-2">{formatAmount(totals.totalAmount)}</p>
            </div>
            <div className="w-12 h-12 bg-orange-50 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-orange-600" />
            </div>
          </div>
        </div>
      </div>

      {/* 搜索栏 */}
      <div className="card">
        <div className="flex items-center gap-4">
          <div className="flex-1 relative">
            <Search className="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="搜索渠道名称..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="input pl-10 w-full"
            />
          </div>
        </div>
      </div>

      {/* 渠道列表 */}
      <div className="card">
        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : filteredChannels.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500">暂无渠道数据</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">渠道名称</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">总订单数</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">总订单金额</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">已支付订单</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">已支付金额</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">已取货订单</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">已取货金额</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">渠道订单明细</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody className="bg-white">
                {paginatedChannels.map((channel) => {
                  return (
                    <tr
                      key={channel.tag}
                      className="border-b border-gray-200 hover:bg-gray-50 transition-colors"
                    >
                      <td className="py-4 px-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900">{channel.channelName}</span>
                        </div>
                      </td>
                      <td className="py-4 px-4">
                        <span className="text-gray-900">{channel.totalOrders}</span>
                      </td>
                      <td className="py-4 px-4">
                        <span className="text-gray-900 font-medium">{formatAmount(channel.totalAmount || 0)}</span>
                      </td>
                      <td className="py-4 px-4">
                        <span className="text-gray-900">{channel.paidOrders}</span>
                      </td>
                      <td className="py-4 px-4">
                        <span className="text-gray-900 font-medium">{formatAmount(channel.paidAmount || 0)}</span>
                      </td>
                      <td className="py-4 px-4">
                        <span className="text-gray-900">{channel.deliveredOrders}</span>
                      </td>
                      <td className="py-4 px-4">
                        <span className="text-gray-900 font-medium">{formatAmount(channel.deliveredAmount || 0)}</span>
                      </td>
                      <td className="py-4 px-4">
                        <Link
                          to={`/channels/${encodeURIComponent(channel.tag)}/orders`}
                          className="text-primary hover:text-primary-dark hover:underline transition-colors"
                        >
                          查看明细
                        </Link>
                      </td>
                      <td className="py-4 px-4">
                        <button
                          onClick={() => handleEditChannel(channel)}
                          className="text-primary hover:text-primary-dark transition-colors"
                          title="修改渠道名称"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 编辑渠道弹窗 */}
      {editingChannel && (
        <EditChannelModal
          channel={editingChannel}
          onClose={() => setEditingChannel(null)}
          onSave={handleSaveChannel}
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
