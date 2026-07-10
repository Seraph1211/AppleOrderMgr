import { useState } from 'react'
import { X } from 'lucide-react'
import { STATUS_OPTIONS } from '../constants/status'

export default function AddRecipientModal({ onClose, onSave }) {
  const [formData, setFormData] = useState({
    lastName: '',
    firstName: '',
    idCardNumber: '',
    phone: '',
    email: '',
    province: '',
    city: '',
    district: '',
    streetAddress: '',
    appleId: '',
    tag: '',
    status: '使用中',
    notes: ''
  })

  const [errors, setErrors] = useState({})

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    // 清除该字段的错误
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }))
    }
  }

  const validate = () => {
    const newErrors = {}

    if (!formData.lastName.trim()) {
      newErrors.lastName = '姓不能为空'
    }

    if (!formData.firstName.trim()) {
      newErrors.firstName = '名不能为空'
    }

    if (!formData.idCardNumber.trim()) {
      newErrors.idCardNumber = '身份证号不能为空'
    } else if (!/^\d{17}[\dXx]$/.test(formData.idCardNumber)) {
      newErrors.idCardNumber = '请输入有效的18位身份证号'
    }

    if (formData.phone && !/^1[3-9]\d{9}$/.test(formData.phone)) {
      newErrors.phone = '请输入有效的手机号'
    }

    if (formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = '请输入有效的邮箱地址'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e) => {
    e.preventDefault()

    if (!validate()) {
      return
    }

    try {
      await onSave(formData)
      onClose()
    } catch (error) {
      console.error('保存失败:', error)
      setErrors({ submit: error.message || '保存失败，请重试' })
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
      <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* 标题栏 */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">添加取机人</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* 表单内容 */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* 基本信息 */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-gray-900">基本信息</h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* 姓 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  姓 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.lastName}
                  onChange={(e) => handleChange('lastName', e.target.value)}
                  className={`input ${errors.lastName ? 'border-red-500' : ''}`}
                  placeholder="如：张"
                />
                {errors.lastName && (
                  <p className="mt-1 text-sm text-red-500">{errors.lastName}</p>
                )}
              </div>

              {/* 名 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  名 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.firstName}
                  onChange={(e) => handleChange('firstName', e.target.value)}
                  className={`input ${errors.firstName ? 'border-red-500' : ''}`}
                  placeholder="如：三"
                />
                {errors.firstName && (
                  <p className="mt-1 text-sm text-red-500">{errors.firstName}</p>
                )}
              </div>

              {/* 身份证号 */}
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  身份证号 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.idCardNumber}
                  onChange={(e) => handleChange('idCardNumber', e.target.value)}
                  className={`input ${errors.idCardNumber ? 'border-red-500' : ''}`}
                  placeholder="18位身份证号"
                  maxLength={18}
                />
                {errors.idCardNumber && (
                  <p className="mt-1 text-sm text-red-500">{errors.idCardNumber}</p>
                )}
              </div>

              {/* 手机号 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  手机号
                </label>
                <input
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => handleChange('phone', e.target.value)}
                  className={`input ${errors.phone ? 'border-red-500' : ''}`}
                  placeholder="11位手机号"
                  maxLength={11}
                />
                {errors.phone && (
                  <p className="mt-1 text-sm text-red-500">{errors.phone}</p>
                )}
              </div>

              {/* 邮箱 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  邮箱
                </label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => handleChange('email', e.target.value)}
                  className={`input ${errors.email ? 'border-red-500' : ''}`}
                  placeholder="example@example.com"
                />
                {errors.email && (
                  <p className="mt-1 text-sm text-red-500">{errors.email}</p>
                )}
              </div>
            </div>
          </div>

          {/* 地址信息 */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-gray-900">地址信息</h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* 省 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  省
                </label>
                <input
                  type="text"
                  value={formData.province}
                  onChange={(e) => handleChange('province', e.target.value)}
                  className="input"
                  placeholder="如：重庆"
                />
              </div>

              {/* 市 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  市
                </label>
                <input
                  type="text"
                  value={formData.city}
                  onChange={(e) => handleChange('city', e.target.value)}
                  className="input"
                  placeholder="如：重庆"
                />
              </div>

              {/* 区 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  区
                </label>
                <input
                  type="text"
                  value={formData.district}
                  onChange={(e) => handleChange('district', e.target.value)}
                  className="input"
                  placeholder="如：江北区"
                />
              </div>

              {/* 街道地址 */}
              <div className="md:col-span-3">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  街道地址
                </label>
                <input
                  type="text"
                  value={formData.streetAddress}
                  onChange={(e) => handleChange('streetAddress', e.target.value)}
                  className="input"
                  placeholder="如：观音桥拓维304"
                />
              </div>
            </div>
          </div>

          {/* 其他信息 */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-gray-900">其他信息</h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* 绑定 Apple ID */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  绑定 Apple ID
                </label>
                <input
                  type="text"
                  value={formData.appleId}
                  onChange={(e) => handleChange('appleId', e.target.value)}
                  className="input"
                  placeholder="example@icloud.com"
                />
              </div>

              {/* 标签 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  标签
                </label>
                <input
                  type="text"
                  value={formData.tag}
                  onChange={(e) => handleChange('tag', e.target.value)}
                  className="input"
                  placeholder="如：刘天佟 微信"
                />
              </div>

              {/* 状态 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  状态
                </label>
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

              {/* 备注 */}
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  备注
                </label>
                <textarea
                  value={formData.notes}
                  onChange={(e) => handleChange('notes', e.target.value)}
                  className="input"
                  rows={3}
                  placeholder="备注信息"
                />
              </div>
            </div>
          </div>

          {/* 错误提示 */}
          {errors.submit && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <p className="text-sm text-red-600">{errors.submit}</p>
            </div>
          )}

          {/* 按钮 */}
          <div className="flex items-center justify-end space-x-3 pt-4 border-t border-gray-200">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary"
            >
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
            >
              保存
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
