import { useState } from 'react'
import { X } from 'lucide-react'
import { STATUS_OPTIONS } from '../constants/status'

export default function EditRecipientModal({ recipient, onClose, onSave }) {
  const [formData, setFormData] = useState({
    name: recipient.name || '',
    idCard: recipient.idCard || '',
    phone: recipient.phone === '-' ? '' : recipient.phone || '',
    email: recipient.email === '-' ? '' : recipient.email || '',
    address: recipient.address === '-' ? '' : recipient.address || '',
    boundAppleId: recipient.boundAppleId === '-' ? '' : recipient.boundAppleId || '',
    tag: recipient.tag === '-' ? '' : recipient.tag || '',
    status: recipient.status || '使用中'
  })

  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState({})

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    // 清除该字段的错误
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }))
    }
  }

  const validateForm = () => {
    const newErrors = {}

    // 验证姓名
    if (!formData.name || formData.name.trim() === '') {
      newErrors.name = '请输入姓名'
    }

    // 验证身份证号（18位）
    if (!formData.idCard || formData.idCard.trim() === '') {
      newErrors.idCard = '请输入身份证号'
    } else if (!/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/.test(formData.idCard)) {
      newErrors.idCard = '身份证号格式不正确（需18位）'
    }

    // 验证手机号（如果填写了）
    if (formData.phone && formData.phone.trim() !== '' && !/^1[3-9]\d{9}$/.test(formData.phone)) {
      newErrors.phone = '手机号格式不正确'
    }

    // 验证邮箱（如果填写了）
    if (formData.email && formData.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = '邮箱格式不正确'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async () => {
    if (!validateForm()) {
      return
    }

    setSaving(true)
    try {
      await onSave(recipient.id, formData)
      onClose()
    } catch (error) {
      alert(error.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        {/* 标题栏 */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-xl font-semibold text-gray-900">编辑取机人</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* 表单内容 - 可滚动 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* 基本信息 */}
          <div>
            <h3 className="text-lg font-medium text-gray-900 mb-4">基本信息</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  姓名 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => handleChange('name', e.target.value)}
                  className={`input ${errors.name ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''}`}
                  placeholder="请输入姓名"
                />
                {errors.name && (
                  <p className="mt-1 text-sm text-red-500">{errors.name}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  身份证号码 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.idCard}
                  onChange={(e) => handleChange('idCard', e.target.value)}
                  className={`input ${errors.idCard ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''}`}
                  placeholder="请输入18位身份证号码"
                  maxLength="18"
                />
                {errors.idCard && (
                  <p className="mt-1 text-sm text-red-500">{errors.idCard}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">手机号</label>
                <input
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => handleChange('phone', e.target.value)}
                  className={`input ${errors.phone ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''}`}
                  placeholder="请输入手机号"
                  maxLength="11"
                />
                {errors.phone && (
                  <p className="mt-1 text-sm text-red-500">{errors.phone}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">邮箱</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => handleChange('email', e.target.value)}
                  className={`input ${errors.email ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''}`}
                  placeholder="请输入邮箱"
                />
                {errors.email && (
                  <p className="mt-1 text-sm text-red-500">{errors.email}</p>
                )}
              </div>
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-2">地址</label>
                <input
                  type="text"
                  value={formData.address}
                  onChange={(e) => handleChange('address', e.target.value)}
                  className="input"
                  placeholder="请输入地址"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">绑定 Apple ID</label>
                <input
                  type="text"
                  value={formData.boundAppleId}
                  onChange={(e) => handleChange('boundAppleId', e.target.value)}
                  className="input"
                  placeholder="请输入绑定的 Apple ID"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">标签</label>
                <input
                  type="text"
                  value={formData.tag}
                  onChange={(e) => handleChange('tag', e.target.value)}
                  className="input"
                  placeholder="请输入标签"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">状态</label>
                <select
                  value={formData.status}
                  onChange={(e) => handleChange('status', e.target.value)}
                  className="input"
                >
                  {STATUS_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* 按钮 */}
        <div className="flex items-center justify-end space-x-3 px-6 py-4 border-t border-gray-200 bg-gray-50 flex-shrink-0">
          <button
            onClick={onClose}
            className="btn btn-secondary"
            disabled={saving}
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="btn btn-primary"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
