import { useState } from 'react'
import { X, MapPin } from 'lucide-react'
import { regions } from '../constants/regions'

export default function GenerateAddressModal({ isOpen, onClose, onConfirm, selectedCount }) {
  const [selectedProvince, setSelectedProvince] = useState('')
  const [selectedCity, setSelectedCity] = useState('')
  const [selectedDistrict, setSelectedDistrict] = useState('')
  const [error, setError] = useState('')

  if (!isOpen) return null

  const handleProvinceChange = (e) => {
    setSelectedProvince(e.target.value)
    setSelectedCity('')
    setSelectedDistrict('')
    setError('')
  }

  const handleCityChange = (e) => {
    setSelectedCity(e.target.value)
    setSelectedDistrict('')
    setError('')
  }

  const handleDistrictChange = (e) => {
    setSelectedDistrict(e.target.value)
    setError('')
  }

  const handleConfirm = () => {
    if (!selectedProvince) {
      setError('请选择省份')
      return
    }
    if (!selectedCity) {
      setError('请选择城市')
      return
    }
    if (!selectedDistrict) {
      setError('请选择区县')
      return
    }

    onConfirm({
      province: selectedProvince,
      city: selectedCity,
      district: selectedDistrict
    })
    handleClose()
  }

  const handleClose = () => {
    setSelectedProvince('')
    setSelectedCity('')
    setSelectedDistrict('')
    setError('')
    onClose()
  }

  const currentRegion = regions.find(r => r.province === selectedProvince)
  const cities = currentRegion ? currentRegion.cities : []

  const currentCity = cities.find(c => c.name === selectedCity)
  const districts = currentCity ? currentCity.districts : []

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* 遮罩层 */}
      <div
        className="absolute inset-0 bg-black bg-opacity-50 transition-opacity"
        onClick={handleClose}
      />

      {/* 弹窗内容 */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* 关闭按钮 */}
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 p-2 hover:bg-gray-100 rounded-lg transition-colors z-10"
        >
          <X className="w-5 h-5 text-gray-400" />
        </button>

        {/* 图标 */}
        <div className="flex justify-center pt-8 pb-4">
          <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center">
            <MapPin className="w-8 h-8 text-blue-600" />
          </div>
        </div>

        {/* 标题 */}
        <div className="text-center px-6 pb-4">
          <h3 className="text-2xl font-bold text-gray-900 mb-2">生成地址</h3>
          <p className="text-gray-500">
            将为 <span className="font-semibold text-blue-600">{selectedCount}</span> 个取机人生成随机地址
          </p>
        </div>

        {/* 表单 */}
        <div className="px-6 pb-6 space-y-4">
          {/* 省份选择 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              选择省份 <span className="text-red-500">*</span>
            </label>
            <select
              value={selectedProvince}
              onChange={handleProvinceChange}
              className={`input w-full ${error && !selectedProvince ? 'border-red-500' : ''}`}
            >
              <option value="">请选择省份</option>
              {regions.map((region) => (
                <option key={region.province} value={region.province}>
                  {region.province}
                </option>
              ))}
            </select>
          </div>

          {/* 城市选择 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              选择城市 <span className="text-red-500">*</span>
            </label>
            <select
              value={selectedCity}
              onChange={handleCityChange}
              disabled={!selectedProvince}
              className={`input w-full ${!selectedProvince ? 'bg-gray-100 cursor-not-allowed' : ''} ${error && !selectedCity ? 'border-red-500' : ''}`}
            >
              <option value="">请选择城市</option>
              {cities.map((city) => (
                <option key={city.name} value={city.name}>
                  {city.name}
                </option>
              ))}
            </select>
          </div>

          {/* 区县选择 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              选择区县 <span className="text-red-500">*</span>
            </label>
            <select
              value={selectedDistrict}
              onChange={handleDistrictChange}
              disabled={!selectedCity}
              className={`input w-full ${!selectedCity ? 'bg-gray-100 cursor-not-allowed' : ''} ${error && !selectedDistrict ? 'border-red-500' : ''}`}
            >
              <option value="">请选择区县</option>
              {districts.map((district) => (
                <option key={district} value={district}>
                  {district}
                </option>
              ))}
            </select>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="text-sm text-red-600 text-center">
              {error}
            </div>
          )}

          {/* 说明 */}
          <div className="bg-blue-50 rounded-lg p-3 text-sm text-gray-600">
            <p className="text-xs leading-relaxed">
              系统将自动生成完整地址，包括：省份、城市、区县、详细街道地址（街道名 + 门牌号 + 楼栋单元室号）
            </p>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="bg-gray-50 px-6 py-4 flex items-center justify-end space-x-3">
          <button
            onClick={handleClose}
            className="btn btn-secondary px-6"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            className="btn btn-primary px-6"
          >
            确认生成
          </button>
        </div>
      </div>
    </div>
  )
}
