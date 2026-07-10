import { useState } from 'react'
import { X } from 'lucide-react'
import { STATUS_OPTIONS } from '../constants/status'

export default function AddAppleIdModal({ onClose, onSave }) {
  const [formData, setFormData] = useState({
    appleId: '',
    password: '',
    nickname: '',
    country: '',
    isModified: false,
    status: '使用中',
    securityQa: {
      question1: '',
      answer1: '',
      question2: '',
      answer2: '',
      question3: '',
      answer3: ''
    }
  })

  const [errors, setErrors] = useState({})

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    // 清除该字段的错误
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }))
    }
  }

  const handleSecurityQaChange = (field, value) => {
    setFormData(prev => ({
      ...prev,
      securityQa: { ...prev.securityQa, [field]: value }
    }))
  }

  const validate = () => {
    const newErrors = {}

    if (!formData.appleId.trim()) {
      newErrors.appleId = 'Apple ID 不能为空'
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.appleId)) {
      newErrors.appleId = '请输入有效的邮箱地址'
    }

    if (!formData.password.trim()) {
      newErrors.password = '密码不能为空'
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
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* 标题栏 */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">添加 Apple ID</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* 表单内容 */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* 基础信息 */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-gray-900">基础信息</h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Apple ID */}
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Apple ID <span className="text-red-500">*</span>
                </label>
                <input
                  type="email"
                  value={formData.appleId}
                  onChange={(e) => handleChange('appleId', e.target.value)}
                  className={`input ${errors.appleId ? 'border-red-500' : ''}`}
                  placeholder="example@icloud.com"
                />
                {errors.appleId && (
                  <p className="mt-1 text-sm text-red-500">{errors.appleId}</p>
                )}
              </div>

              {/* 密码 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  密码 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.password}
                  onChange={(e) => handleChange('password', e.target.value)}
                  className={`input ${errors.password ? 'border-red-500' : ''}`}
                  placeholder="输入密码"
                />
                {errors.password && (
                  <p className="mt-1 text-sm text-red-500">{errors.password}</p>
                )}
              </div>

              {/* 备注名称 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  备注名称
                </label>
                <input
                  type="text"
                  value={formData.nickname}
                  onChange={(e) => handleChange('nickname', e.target.value)}
                  className="input"
                  placeholder="如：主账号、测试账号"
                />
              </div>

              {/* 国家地区 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  国家地区
                </label>
                <input
                  type="text"
                  value={formData.country}
                  onChange={(e) => handleChange('country', e.target.value)}
                  className="input"
                  placeholder="如：美国、中国"
                />
              </div>

              {/* 是否已修改 */}
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="isModified"
                  checked={formData.isModified}
                  onChange={(e) => handleChange('isModified', e.target.checked)}
                  className="w-4 h-4 text-primary border-gray-300 rounded focus:ring-primary"
                />
                <label htmlFor="isModified" className="ml-2 text-sm text-gray-700">
                  已修改国家及手机
                </label>
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
            </div>
          </div>

          {/* 密保问答 */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-gray-900">密保问答（可选）</h3>

            {/* 密保1 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  密保问题1
                </label>
                <input
                  type="text"
                  value={formData.securityQa.question1}
                  onChange={(e) => handleSecurityQaChange('question1', e.target.value)}
                  className="input"
                  placeholder="如：朋友"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  密保答案1
                </label>
                <input
                  type="text"
                  value={formData.securityQa.answer1}
                  onChange={(e) => handleSecurityQaChange('answer1', e.target.value)}
                  className="input"
                  placeholder="输入答案"
                />
              </div>
            </div>

            {/* 密保2 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  密保问题2
                </label>
                <input
                  type="text"
                  value={formData.securityQa.question2}
                  onChange={(e) => handleSecurityQaChange('question2', e.target.value)}
                  className="input"
                  placeholder="如：工作"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  密保答案2
                </label>
                <input
                  type="text"
                  value={formData.securityQa.answer2}
                  onChange={(e) => handleSecurityQaChange('answer2', e.target.value)}
                  className="input"
                  placeholder="输入答案"
                />
              </div>
            </div>

            {/* 密保3 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  密保问题3
                </label>
                <input
                  type="text"
                  value={formData.securityQa.question3}
                  onChange={(e) => handleSecurityQaChange('question3', e.target.value)}
                  className="input"
                  placeholder="如：父母"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  密保答案3
                </label>
                <input
                  type="text"
                  value={formData.securityQa.answer3}
                  onChange={(e) => handleSecurityQaChange('answer3', e.target.value)}
                  className="input"
                  placeholder="输入答案"
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
