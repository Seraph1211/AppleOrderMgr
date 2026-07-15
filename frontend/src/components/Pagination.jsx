import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'

/**
 * 分页组件
 * @param {Object} props
 * @param {number} props.currentPage - 当前页码（从1开始）
 * @param {number} props.totalPages - 总页数
 * @param {number} props.totalItems - 总条目数
 * @param {number} props.pageSize - 每页条目数
 * @param {Function} props.onPageChange - 页码变化回调
 * @param {Function} props.onPageSizeChange - 每页条目数变化回调
 * @param {number[]} props.pageSizeOptions - 每页条目数选项
 */
export default function Pagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50, 100]
}) {
  const startItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const endItem = Math.min(currentPage * pageSize, totalItems)

  // 生成页码按钮数组
  const getPageNumbers = () => {
    const pages = []
    const maxVisible = 7 // 最多显示7个页码按钮

    if (totalPages <= maxVisible) {
      // 如果总页数少于最大可见数，显示所有页码
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i)
      }
    } else {
      // 否则智能显示
      if (currentPage <= 4) {
        // 当前页在前面
        for (let i = 1; i <= 5; i++) pages.push(i)
        pages.push('...')
        pages.push(totalPages)
      } else if (currentPage >= totalPages - 3) {
        // 当前页在后面
        pages.push(1)
        pages.push('...')
        for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i)
      } else {
        // 当前页在中间
        pages.push(1)
        pages.push('...')
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i)
        pages.push('...')
        pages.push(totalPages)
      }
    }

    return pages
  }

  const pageNumbers = getPageNumbers()

  return (
    <div className="flex items-center justify-between py-4 px-6 border-t border-gray-200 bg-gray-50">
      {/* 左侧：统计信息和每页条目数选择 */}
      <div className="flex items-center gap-6">
        <div className="text-sm text-gray-700">
          显示 <span className="font-medium">{startItem}</span> 到{' '}
          <span className="font-medium">{endItem}</span>，共{' '}
          <span className="font-medium">{totalItems}</span> 条
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-700 whitespace-nowrap">每页显示</label>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="input py-1 pr-8"
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size} 条
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 右侧：分页控制 */}
      <div className="flex items-center gap-2">
        {/* 首页 */}
        <button
          onClick={() => onPageChange(1)}
          disabled={currentPage === 1}
          className="btn btn-secondary p-2 disabled:opacity-50 disabled:cursor-not-allowed"
          title="首页"
        >
          <ChevronsLeft className="w-4 h-4" />
        </button>

        {/* 上一页 */}
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className="btn btn-secondary p-2 disabled:opacity-50 disabled:cursor-not-allowed"
          title="上一页"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        {/* 页码按钮 */}
        <div className="flex items-center gap-1">
          {pageNumbers.map((page, index) => {
            if (page === '...') {
              return (
                <span key={`ellipsis-${index}`} className="px-3 py-1 text-gray-500">
                  ...
                </span>
              )
            }

            return (
              <button
                key={page}
                onClick={() => onPageChange(page)}
                className={`min-w-[36px] px-3 py-1 text-sm rounded-md transition-colors ${
                  currentPage === page
                    ? 'bg-primary text-white font-medium'
                    : 'text-gray-700 hover:bg-gray-200'
                }`}
              >
                {page}
              </button>
            )
          })}
        </div>

        {/* 下一页 */}
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className="btn btn-secondary p-2 disabled:opacity-50 disabled:cursor-not-allowed"
          title="下一页"
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        {/* 末页 */}
        <button
          onClick={() => onPageChange(totalPages)}
          disabled={currentPage === totalPages}
          className="btn btn-secondary p-2 disabled:opacity-50 disabled:cursor-not-allowed"
          title="末页"
        >
          <ChevronsRight className="w-4 h-4" />
        </button>

        {/* 跳转到指定页 */}
        <div className="flex items-center gap-2 ml-4">
          <span className="text-sm text-gray-700">跳转到</span>
          <input
            type="number"
            min="1"
            max={totalPages}
            className="input w-16 py-1 text-center"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const page = Number(e.target.value)
                if (page >= 1 && page <= totalPages) {
                  onPageChange(page)
                  e.target.value = ''
                }
              }
            }}
            placeholder={currentPage}
          />
          <span className="text-sm text-gray-700">页</span>
        </div>
      </div>
    </div>
  )
}
