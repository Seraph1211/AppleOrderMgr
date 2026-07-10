import { X } from 'lucide-react'

export default function AlertModal({ title, message, onClose }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4">
        <div className="p-6">
          <div className="flex items-start justify-between mb-4">
            <h3 className="text-xl font-bold text-gray-900">{title}</h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <p className="text-gray-600 mb-6 whitespace-pre-line">{message}</p>
          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="btn btn-primary"
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
