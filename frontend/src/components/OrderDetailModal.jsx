import { useState, useEffect } from 'react'
import { X, Upload, Save, ExternalLink } from 'lucide-react'
import { updateOrder } from '../api/ordersApi'

/**
 * 订单详情弹窗组件
 * 功能：展示订单完整信息，支持编辑付款人和上传付款截图（最多9张）
 */
export default function OrderDetailModal({ order, isOpen, onClose, onUpdate }) {
  const [formData, setFormData] = useState({
    payerName: '',
    paymentScreenshots: [] // 改为数组，支持多张图片
  })
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (order) {
      // 解析 paymentScreenshot 字段（现在是 JSONB 数组）
      let screenshots = []

      // 优先使用 paymentScreenshots 数组（前端保存的）
      if (order.paymentScreenshots && Array.isArray(order.paymentScreenshots)) {
        screenshots = order.paymentScreenshots
      }
      // 否则从 paymentScreenshot 字段解析（后端返回的）
      else if (order.paymentScreenshot) {
        // 如果是数组，直接使用
        if (Array.isArray(order.paymentScreenshot)) {
          screenshots = order.paymentScreenshot.filter(url =>
            url && url !== '-' && (
              url.startsWith('http://') ||
              url.startsWith('https://') ||
              url.startsWith('data:image/')
            )
          )
        }
        // 如果是字符串（旧数据），转为数组
        else if (typeof order.paymentScreenshot === 'string' && order.paymentScreenshot !== '-') {
          try {
            if (order.paymentScreenshot.startsWith('http://') ||
                order.paymentScreenshot.startsWith('https://') ||
                order.paymentScreenshot.startsWith('data:image/')) {
              screenshots = [order.paymentScreenshot]
            }
          } catch (e) {
            console.log('无效的图片 URL:', order.paymentScreenshot)
          }
        }
      }

      console.log('初始化弹窗，订单:', order.orderNumber, '截图数量:', screenshots.length)

      setFormData({
        payerName: order.payerName || '',
        paymentScreenshots: screenshots
      })
    }
  }, [order])

  if (!isOpen || !order) return null

  const handleInputChange = (e) => {
    const { name, value } = e.target
    setFormData(prev => ({ ...prev, [name]: value }))
  }

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files)
    console.log('选择的文件:', files)
    if (files.length === 0) return

    // 检查是否超过最大数量（9张）
    const currentCount = formData.paymentScreenshots.length
    const remainingSlots = 9 - currentCount

    if (files.length > remainingSlots) {
      alert(`最多只能上传 9 张截图，当前已有 ${currentCount} 张，还可上传 ${remainingSlots} 张`)
      return
    }

    // 验证所有文件
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        alert('请上传图片文件')
        return
      }
      if (file.size > 5 * 1024 * 1024) {
        alert('图片大小不能超过 5MB')
        return
      }
    }

    setUploading(true)
    try {
      // TODO: 实现文件上传到服务器
      // const uploadPromises = files.map(file => {
      //   const formData = new FormData()
      //   formData.append('file', file)
      //   return uploadFile(formData)
      // })
      // const responses = await Promise.all(uploadPromises)
      // const imageUrls = responses.map(r => r.url)

      // 临时使用本地预览
      const readFilePromises = files.map(file => {
        return new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = (e) => {
            console.log('文件读取成功:', file.name, e.target.result.substring(0, 50))
            resolve(e.target.result)
          }
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
      })

      const imageDataUrls = await Promise.all(readFilePromises)
      console.log('所有图片读取完成，共', imageDataUrls.length, '张')
      console.log('当前 paymentScreenshots:', formData.paymentScreenshots)

      setFormData(prev => {
        const newScreenshots = [...prev.paymentScreenshots, ...imageDataUrls]
        console.log('更新后的 screenshots:', newScreenshots)
        return {
          ...prev,
          paymentScreenshots: newScreenshots
        }
      })
      setUploading(false)
    } catch (error) {
      console.error('上传失败:', error)
      alert('上传失败，请重试')
      setUploading(false)
    }

    // 重置 input，允许重复上传相同文件
    e.target.value = ''
  }

  const handleRemoveScreenshot = (index) => {
    setFormData(prev => ({
      ...prev,
      paymentScreenshots: prev.paymentScreenshots.filter((_, i) => i !== index)
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // 调用后端 API 更新订单
      // 现在后端支持 JSONB 数组，可以保存多张截图
      const response = await updateOrder(order.id, {
        payerName: formData.payerName,
        paymentScreenshot: formData.paymentScreenshots // 直接发送数组
      })

      console.log('后端保存成功:', response)

      // 更新订单数据
      const updatedOrder = {
        ...order,
        payerName: formData.payerName,
        paymentScreenshot: formData.paymentScreenshots, // 保存为数组
        paymentScreenshots: formData.paymentScreenshots, // 前端兼容字段
        updatedAt: new Date().toISOString()
      }

      console.log('更新的订单数据:', updatedOrder)
      alert('保存成功')
      onUpdate && onUpdate(updatedOrder)
      setSaving(false)
      onClose()
    } catch (error) {
      console.error('保存失败:', error)
      alert(`保存失败：${error.message || '请重试'}`)
      setSaving(false)
    }
  }

  const getStatusBadge = (status) => {
    const statusMap = {
      'pending': { text: '待处理', class: 'badge-warning' },
      'processing': { text: '处理中', class: 'badge-info' },
      'completed': { text: '已完成', class: 'badge-success' },
      'cancelled': { text: '已取消', class: 'badge-error' }
    }
    return statusMap[status] || { text: status, class: 'badge-info' }
  }

  const badge = getStatusBadge(order.status)

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* 弹窗头部 */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-2xl font-bold">订单详情</h2>
            <p className="text-gray-600 mt-1 font-mono">{order.orderNumber}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* 弹窗内容 */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-6">
            {/* 订单基本信息 */}
            <div className="card">
              <h3 className="text-lg font-semibold mb-4">基本信息</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-gray-600">订单状态</label>
                  <div className="mt-1">
                    <span className={`badge ${badge.class}`}>{badge.text}</span>
                  </div>
                </div>
                <div>
                  <label className="text-sm text-gray-600">下单时间</label>
                  <p className="text-sm text-gray-900 mt-1">
                    {order.orderDate !== '-' ? new Date(order.orderDate).toLocaleString('zh-CN') : '-'}
                  </p>
                </div>
                <div>
                  <label className="text-sm text-gray-600">Apple ID</label>
                  <p className="text-sm text-gray-900 mt-1">{order.appleId}</p>
                </div>
                <div>
                  <label className="text-sm text-gray-600">订单链接</label>
                  {order.orderUrl !== '-' ? (
                    <a
                      href={order.orderUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline text-sm flex items-center gap-1 mt-1"
                    >
                      查看订单 <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : (
                    <p className="text-sm text-gray-400 mt-1">-</p>
                  )}
                </div>
              </div>
            </div>

            {/* 商品信息 */}
            <div className="card">
              <h3 className="text-lg font-semibold mb-4">商品信息</h3>
              <div className="space-y-2">
                {order.products && order.products.length > 0 ? (
                  order.products.map((product, index) => (
                    <div key={index} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{product.name}</p>
                        {product.model && (
                          <p className="text-xs text-gray-500 mt-1">型号: {product.model}</p>
                        )}
                      </div>
                      <div className="text-sm text-gray-600">× {product.quantity}</div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-gray-400">暂无商品信息</p>
                )}
              </div>
            </div>

            {/* 取机人信息 */}
            <div className="card">
              <h3 className="text-lg font-semibold mb-4">取机人信息</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-gray-600">姓名</label>
                  <p className="text-sm text-gray-900 mt-1">{order.recipientName}</p>
                </div>
                <div>
                  <label className="text-sm text-gray-600">联系电话</label>
                  <p className="text-sm text-gray-900 mt-1">{order.recipientPhone}</p>
                </div>
                <div className="col-span-2">
                  <label className="text-sm text-gray-600">收件地址</label>
                  <p className="text-sm text-gray-900 mt-1">{order.recipientAddress || '-'}</p>
                </div>
              </div>
            </div>

            {/* 取货信息 */}
            <div className="card">
              <h3 className="text-lg font-semibold mb-4">取货信息</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-gray-600">取货门店</label>
                  <p className="text-sm text-gray-900 mt-1">{order.pickupStore}</p>
                </div>
                <div>
                  <label className="text-sm text-gray-600">取货码</label>
                  <p className="text-sm text-gray-900 mt-1">{order.pickupCode || '-'}</p>
                </div>
                <div>
                  <label className="text-sm text-gray-600">取货时间段</label>
                  <p className="text-sm text-gray-900 mt-1">{order.pickupTimeSlot || '-'}</p>
                </div>
                <div>
                  <label className="text-sm text-gray-600">实际取货日期</label>
                  <p className="text-sm text-gray-900 mt-1">
                    {order.actualPickupDate !== '-' ? new Date(order.actualPickupDate).toLocaleDateString('zh-CN') : '-'}
                  </p>
                </div>
              </div>
            </div>

            {/* 付款信息（可编辑） */}
            <div className="card border-2 border-blue-200 bg-blue-50">
              <h3 className="text-lg font-semibold mb-4">付款信息</h3>
              <div className="space-y-4">
                <div>
                  <label className="text-sm text-gray-600">付款方式</label>
                  <p className="text-sm text-gray-900 mt-1">{order.paymentMethod}</p>
                </div>
                <div>
                  <label className="text-sm text-gray-700 font-medium">付款人 *</label>
                  <input
                    type="text"
                    name="payerName"
                    value={formData.payerName}
                    onChange={handleInputChange}
                    className="input mt-1"
                    placeholder="请输入付款人姓名"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-700 font-medium">
                    付款截图 ({formData.paymentScreenshots.length}/9)
                  </label>
                  <div className="mt-2 space-y-3">
                    {/* 图片网格展示 */}
                    {formData.paymentScreenshots.length > 0 && (
                      <div className="grid grid-cols-3 gap-3">
                        {formData.paymentScreenshots.map((screenshot, index) => (
                          <div key={index} className="relative group">
                            <img
                              src={screenshot}
                              alt={`付款截图 ${index + 1}`}
                              className="w-full h-32 object-cover rounded-lg border border-gray-300 shadow-sm cursor-pointer hover:opacity-90 transition-opacity"
                              onClick={() => window.open(screenshot, '_blank')}
                            />
                            <button
                              type="button"
                              onClick={() => handleRemoveScreenshot(index)}
                              className="absolute top-1 right-1 bg-red-500 text-white p-1 rounded-full hover:bg-red-600 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 上传按钮 */}
                    {formData.paymentScreenshots.length < 9 && (
                      <div>
                        <label className="btn btn-secondary cursor-pointer inline-flex items-center space-x-2">
                          <Upload className="w-4 h-4" />
                          <span>
                            {uploading ? '上传中...' :
                             formData.paymentScreenshots.length === 0 ? '上传截图' : '继续上传'}
                          </span>
                          <input
                            type="file"
                            accept="image/*"
                            multiple
                            onChange={handleFileUpload}
                            className="hidden"
                            disabled={uploading}
                          />
                        </label>
                        <p className="text-xs text-gray-500 mt-1">
                          支持 JPG、PNG 格式，单张大小不超过 5MB，最多上传 9 张
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* 其他信息 */}
            <div className="card">
              <h3 className="text-lg font-semibold mb-4">其他信息</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-gray-600">标签</label>
                  <p className="text-sm text-gray-900 mt-1">{order.tag || '-'}</p>
                </div>
                <div>
                  <label className="text-sm text-gray-600">创建时间</label>
                  <p className="text-sm text-gray-900 mt-1">
                    {order.createdAt ? new Date(order.createdAt).toLocaleString('zh-CN') : '-'}
                  </p>
                </div>
                <div className="col-span-2">
                  <label className="text-sm text-gray-600">备注</label>
                  <p className="text-sm text-gray-900 mt-1">{order.notes || '-'}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 弹窗底部 */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            className="btn btn-secondary"
            disabled={saving}
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="btn btn-primary flex items-center space-x-2"
            disabled={saving}
          >
            <Save className="w-4 h-4" />
            <span>{saving ? '保存中...' : '保存修改'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
