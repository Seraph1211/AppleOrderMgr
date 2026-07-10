import { CheckCircle } from 'lucide-react'

/**
 * 成功提示弹窗
 * @param {Object} props
 * @param {string} props.title - 标题
 * @param {string} props.message - 消息内容
 * @param {Function} props.onClose - 关闭回调
 */
export default function SuccessModal({ title = '操作成功', message, onClose }) {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        {/* 图标 */}
        <div className="flex justify-center pt-8 pb-4">
          <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center">
            <CheckCircle className="w-10 h-10 text-green-500" />
          </div>
        </div>

        {/* 内容 */}
        <div className="px-6 pb-6 text-center">
          <h3 className="text-xl font-semibold text-gray-900 mb-2">{title}</h3>
          <p className="text-gray-600">{message}</p>
        </div>

        {/* 按钮 */}
        <div className="px-6 pb-6">
          <button
            onClick={onClose}
            className="btn btn-primary w-full"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
