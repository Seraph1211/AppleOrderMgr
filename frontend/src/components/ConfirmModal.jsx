import { AlertTriangle, X, Info, Zap } from 'lucide-react'

export default function ConfirmModal({ title, message, type = 'warning', onConfirm, onCancel }) {
  const typeConfig = {
    warning: {
      icon: AlertTriangle,
      iconColor: 'text-yellow-600',
      iconBgColor: 'bg-yellow-50',
      confirmClass: 'btn-primary'
    },
    danger: {
      icon: AlertTriangle,
      iconColor: 'text-red-600',
      iconBgColor: 'bg-red-50',
      confirmClass: 'btn-error'
    },
    info: {
      icon: Info,
      iconColor: 'text-blue-600',
      iconBgColor: 'bg-blue-50',
      confirmClass: 'btn-primary'
    },
    generate: {
      icon: Zap,
      iconColor: 'text-purple-600',
      iconBgColor: 'bg-purple-50',
      confirmClass: 'btn-primary'
    }
  }

  const config = typeConfig[type] || typeConfig.warning
  const Icon = config.icon

  // 处理多行消息
  const lines = message.split('\n').filter(line => line.trim())

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 animate-fade-in relative">
        {/* 关闭按钮 */}
        <button
          onClick={onCancel}
          className="absolute top-4 right-4 p-1 hover:bg-gray-100 rounded-lg transition-colors z-10"
        >
          <X className="w-5 h-5 text-gray-400" />
        </button>

        {/* 图标 */}
        <div className="flex justify-center pt-8 pb-4">
          <div className={`w-16 h-16 ${config.iconBgColor} rounded-full flex items-center justify-center`}>
            <Icon className={`w-8 h-8 ${config.iconColor}`} />
          </div>
        </div>

        {/* 标题 */}
        <div className="text-center px-6 pb-2">
          <h2 className="text-2xl font-semibold text-gray-900">{title}</h2>
        </div>

        {/* 内容 */}
        <div className="px-6 pb-6">
          <div className="text-center space-y-2">
            {lines.map((line, index) => (
              <p key={index} className="text-gray-600 text-base">
                {line}
              </p>
            ))}
          </div>
        </div>

        {/* 按钮 */}
        <div className="flex items-center justify-center space-x-3 px-6 py-6 border-t border-gray-100">
          <button
            onClick={onCancel}
            className="btn btn-secondary px-6"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className={`btn ${config.confirmClass} px-6`}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
