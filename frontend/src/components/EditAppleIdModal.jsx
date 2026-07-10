import { useState } from 'react'
import { X } from 'lucide-react'
import { STATUS_OPTIONS } from '../constants/status'

export default function EditAppleIdModal({ appleId, onClose, onSave }) {
  const [formData, setFormData] = useState({
    appleId: appleId.appleId || '',
    password: appleId.password === '-' ? '' : appleId.password || '',
    nickname: appleId.nickname === '-' ? '' : appleId.nickname || '',
    country: appleId.country === '-' ? '' : appleId.country || '',
    isModified: appleId.isModified === '是',
    status: appleId.status || '使用中',
    question1: appleId.securityQa?.question1 || '',
    answer1: appleId.securityQa?.answer1 || '',
    question2: appleId.securityQa?.question2 || '',
    answer2: appleId.securityQa?.answer2 || '',
    question3: appleId.securityQa?.question3 || '',
    answer3: appleId.securityQa?.answer3 || ''
  })

  const [saving, setSaving] = useState(false)

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const handleSubmit = async () => {
    setSaving(true)
    try {
      await onSave(appleId.id, formData)
      onClose()
    } catch (error) {
      alert(error.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        {/* 标题栏 */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-xl font-semibold text-gray-900">编辑 Apple ID</h2>
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
                  Apple ID <span className="text-red-500">*</span>
                </label>
                <input
                  type="email"
                  value={formData.appleId}
                  disabled
                  className="input bg-gray-50 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  密码 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.password}
                  onChange={(e) => handleChange('password', e.target.value)}
                  className="input"
                  placeholder="请输入密码"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">备注名称</label>
                <input
                  type="text"
                  value={formData.nickname}
                  onChange={(e) => handleChange('nickname', e.target.value)}
                  className="input"
                  placeholder="请输入备注名称"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">国家地区</label>
                <select
                  value={formData.country}
                  onChange={(e) => handleChange('country', e.target.value)}
                  className="input"
                >
                  <option value="">请选择</option>
                  <option value="中国">中国</option>
                  <option value="美国">美国</option>
                  <option value="日本">日本</option>
                  <option value="英国">英国</option>
                </select>
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
              <div>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.isModified}
                    onChange={(e) => handleChange('isModified', e.target.checked)}
                    className="w-4 h-4 text-primary border-gray-300 rounded focus:ring-primary"
                  />
                  <span className="text-sm text-gray-700">已修改密码</span>
                </label>
              </div>
            </div>
          </div>

          {/* 密保问题 */}
          <div>
            <h3 className="text-lg font-medium text-gray-900 mb-4">密保问题</h3>
            <div className="space-y-4">
              {[1, 2, 3].map(num => (
                <div key={num} className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      问题 {num}
                    </label>
                    <input
                      type="text"
                      value={formData[`question${num}`]}
                      onChange={(e) => handleChange(`question${num}`, e.target.value)}
                      className="input"
                      placeholder={`请输入密保问题 ${num}`}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      答案 {num}
                    </label>
                    <input
                      type="text"
                      value={formData[`answer${num}`]}
                      onChange={(e) => handleChange(`answer${num}`, e.target.value)}
                      className="input"
                      placeholder={`请输入答案 ${num}`}
                    />
                  </div>
                </div>
              ))}
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
