import { useState } from 'react'
import { X, Upload, Download, FileSpreadsheet, AlertCircle, CheckCircle } from 'lucide-react'

export default function BatchImportModal({ type, onClose, onImport }) {
  const [file, setFile] = useState(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState(null)

  const config = {
    appleIds: {
      title: '批量导入 Apple ID',
      templateUrl: '/templates/apple_ids_import_template.xlsx',
      templateName: 'apple_ids_import_template.xlsx',
      acceptFormats: '.xlsx, .xls',
      instructions: [
        '1. 下载导入模板，按照格式填写数据',
        '2. Apple ID 和密码为必填项',
        '3. 国家地区、密保问答为可选项',
        '4. 密保问答需成对填写（问题+答案）',
        '5. 系统将自动设置状态为"活跃"'
      ]
    },
    recipients: {
      title: '批量导入取机人',
      templateUrl: '/templates/recipients_import_template.xlsx',
      templateName: 'recipients_import_template.xlsx',
      acceptFormats: '.xlsx, .xls',
      instructions: [
        '1. 下载导入模板，按照格式填写数据',
        '2. 姓、名、身份证号为必填项',
        '3. 标签为可选项',
        '4. 身份证号必须为18位有效号码',
        '5. 邮箱和手机号将由系统自动生成'
      ]
    }
  }

  const currentConfig = config[type]

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0]
    if (selectedFile) {
      // 验证文件类型
      const fileExtension = selectedFile.name.split('.').pop().toLowerCase()
      if (!['xlsx', 'xls'].includes(fileExtension)) {
        alert('请上传 Excel 文件（.xlsx 或 .xls）')
        return
      }
      setFile(selectedFile)
      setResult(null)
    }
  }

  const handleDownloadTemplate = () => {
    // 创建下载链接
    const link = document.createElement('a')
    link.href = currentConfig.templateUrl
    link.download = currentConfig.templateName
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleImport = async () => {
    if (!file) {
      alert('请先选择要导入的文件')
      return
    }

    setImporting(true)
    setResult(null)

    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await onImport(formData)

      setResult({
        success: true,
        message: `成功导入 ${res.imported || 0} 条数据${res.skipped > 0 ? `，跳过 ${res.skipped} 条` : ''}`,
        details: res.errors?.length > 0 ? res.errors.map(e => `行 ${e.rowNumber || '?'}: ${e.error}`) : []
      })

      // 3秒后自动关闭
      setTimeout(() => {
        onClose()
      }, 3000)
    } catch (error) {
      setResult({
        success: false,
        message: error.message || '导入失败，请检查文件格式',
        details: error.details || []
      })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full mx-4">
        {/* 标题栏 */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">{currentConfig.title}</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* 内容 */}
        <div className="p-6 space-y-6">
          {/* 下载模板 */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-start space-x-3">
              <FileSpreadsheet className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="text-sm font-medium text-blue-900 mb-2">第一步：下载导入模板</h3>
                <button
                  onClick={handleDownloadTemplate}
                  className="btn btn-secondary flex items-center space-x-2"
                >
                  <Download className="w-4 h-4" />
                  <span>下载模板</span>
                </button>
              </div>
            </div>
          </div>

          {/* 填写说明 */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-900 mb-2">填写说明</h3>
            <ul className="space-y-1">
              {currentConfig.instructions.map((instruction, index) => (
                <li key={index} className="text-sm text-gray-600">
                  {instruction}
                </li>
              ))}
            </ul>
          </div>

          {/* 上传文件 */}
          <div>
            <h3 className="text-sm font-medium text-gray-900 mb-3">第二步：上传填写好的文件</h3>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-primary transition-colors">
              <Upload className="w-12 h-12 text-gray-400 mx-auto mb-3" />
              <input
                type="file"
                accept={currentConfig.acceptFormats}
                onChange={handleFileChange}
                className="hidden"
                id="file-upload"
              />
              <label
                htmlFor="file-upload"
                className="btn btn-secondary cursor-pointer inline-block"
              >
                选择文件
              </label>
              {file && (
                <p className="mt-3 text-sm text-gray-600">
                  已选择：<span className="font-medium">{file.name}</span>
                </p>
              )}
              <p className="mt-2 text-xs text-gray-500">
                支持格式：{currentConfig.acceptFormats}
              </p>
            </div>
          </div>

          {/* 导入结果 */}
          {result && (
            <div className={`border rounded-lg p-4 ${
              result.success
                ? 'bg-green-50 border-green-200'
                : 'bg-red-50 border-red-200'
            }`}>
              <div className="flex items-start space-x-3">
                {result.success ? (
                  <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1">
                  <p className={`text-sm font-medium ${
                    result.success ? 'text-green-900' : 'text-red-900'
                  }`}>
                    {result.message}
                  </p>
                  {result.details && result.details.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {result.details.map((detail, index) => (
                        <li key={index} className="text-xs text-gray-600">
                          {detail}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 按钮 */}
        <div className="flex items-center justify-end space-x-3 px-6 py-4 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary"
            disabled={importing}
          >
            取消
          </button>
          <button
            onClick={handleImport}
            disabled={!file || importing}
            className="btn btn-primary flex items-center space-x-2"
          >
            {importing ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <span>导入中...</span>
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                <span>开始导入</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
