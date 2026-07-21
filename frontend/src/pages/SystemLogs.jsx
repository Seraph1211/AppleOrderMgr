import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle,
  ExternalLink,
  Filter,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from 'lucide-react'
import { getSystemLogs, getAutoRefreshStatus, resumeAutoRefresh } from '../api'
import AlertModal from '../components/AlertModal'
import Pagination from '../components/Pagination'
import { useAuth } from '../contexts/AuthContext'

const LOG_TYPES = ['crawler', 'proxy', 'wind_control', 'product_validation', 'amount_parse', 'scheduler']
const SEVERITIES = ['error', 'warn', 'info', 'debug']

export default function SystemLogs() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedLog, setSelectedLog] = useState(null)
  const [autoRefreshStatus, setAutoRefreshStatus] = useState(null)
  const [alertInfo, setAlertInfo] = useState(null)
  const { isAdmin } = useAuth()
  const [pagination, setPagination] = useState({
    currentPage: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0,
  })
  const [filters, setFilters] = useState({
    dateFrom: '',
    dateTo: '',
    type: '',
    severity: '',
    orderNumber: '',
    keyword: '',
    isWindControl: '',
    success: '',
  })

  useEffect(() => {
    loadLogs()
    loadAutoRefreshStatus()
  }, [pagination.currentPage, pagination.pageSize])

  const buildParams = () => ({
    page: pagination.currentPage,
    limit: pagination.pageSize,
    date_from: filters.dateFrom || undefined,
    date_to: filters.dateTo || undefined,
    type: filters.type || undefined,
    severity: filters.severity || undefined,
    order_number: filters.orderNumber || undefined,
    keyword: filters.keyword || undefined,
    is_wind_control: filters.isWindControl || undefined,
    success: filters.success || undefined,
  })

  const loadLogs = async () => {
    setLoading(true)
    try {
      const res = await getSystemLogs(buildParams())
      if (res.success) {
        setLogs(res.data.logs || [])
        setPagination(prev => ({
          ...prev,
          totalItems: res.data.total,
          totalPages: Math.ceil(res.data.total / prev.pageSize),
        }))
      }
    } catch (error) {
      setAlertInfo({ title: '加载失败', message: error.message || '系统日志加载失败' })
    } finally {
      setLoading(false)
    }
  }

  const loadAutoRefreshStatus = async () => {
    try {
      const res = await getAutoRefreshStatus()
      if (res.success) {
        setAutoRefreshStatus(res.data)
      }
    } catch (error) {
      setAlertInfo({ title: '加载失败', message: error.message || '自动刷新状态加载失败' })
    }
  }

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }))
    setPagination(prev => ({ ...prev, currentPage: 1 }))
  }

  const resetFilters = () => {
    setFilters({
      dateFrom: '',
      dateTo: '',
      type: '',
      severity: '',
      orderNumber: '',
      keyword: '',
      isWindControl: '',
      success: '',
    })
    setPagination(prev => ({ ...prev, currentPage: 1 }))
  }

  const applyFilters = () => {
    if (pagination.currentPage === 1) {
      loadLogs()
    } else {
      setPagination(prev => ({ ...prev, currentPage: 1 }))
    }
  }

  const handleResume = async () => {
    try {
      const res = await resumeAutoRefresh()
      if (res.success) {
        setAutoRefreshStatus(res.data)
        setAlertInfo({ title: '已恢复', message: '自动刷新已恢复运行' })
        loadLogs()
      }
    } catch (error) {
      setAlertInfo({ title: '恢复失败', message: error.message || '自动刷新恢复失败' })
    }
  }

  const getSeverityBadge = (severity) => {
    const classes = {
      error: 'badge-error',
      warn: 'badge-warning',
      info: 'badge-info',
      debug: 'badge-info',
    }
    return <span className={`badge ${classes[severity] || 'badge-info'}`}>{severity}</span>
  }

  const activeFiltersCount = Object.values(filters).filter(value => value !== '').length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">系统日志</h1>
          <p className="text-gray-500 mt-1">查看爬虫、代理、风控和调度器运行记录</p>
        </div>
        <button onClick={loadLogs} className="btn btn-primary flex items-center space-x-2">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          <span>刷新</span>
        </button>
      </div>

      {autoRefreshStatus?.isPaused && (
        <div className="border border-red-200 bg-red-50 rounded-lg px-4 py-3 flex items-center justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-700">自动刷新已暂停</p>
              <p className="text-sm text-red-600 mt-1">
                {autoRefreshStatus.pauseReason || '系统检测到关键异常'}
              </p>
            </div>
          </div>
          {isAdmin() && (
            <button onClick={handleResume} className="btn btn-secondary flex items-center space-x-2">
              <RotateCcw className="w-4 h-4" />
              <span>恢复</span>
            </button>
          )}
        </div>
      )}

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-gray-600" />
            <h3 className="text-sm font-medium text-gray-700">筛选条件</h3>
            {activeFiltersCount > 0 && <span className="badge badge-info">{activeFiltersCount}</span>}
          </div>
          {activeFiltersCount > 0 && (
            <button
              onClick={resetFilters}
              className="text-sm text-gray-600 hover:text-gray-900 flex items-center gap-1"
            >
              <X className="w-4 h-4" />
              清空筛选
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <input
            type="datetime-local"
            value={filters.dateFrom}
            onChange={(event) => handleFilterChange('dateFrom', event.target.value)}
            className="input"
          />
          <input
            type="datetime-local"
            value={filters.dateTo}
            onChange={(event) => handleFilterChange('dateTo', event.target.value)}
            className="input"
          />
          <select
            value={filters.type}
            onChange={(event) => handleFilterChange('type', event.target.value)}
            className="input"
          >
            <option value="">全部类型</option>
            {LOG_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
          </select>
          <select
            value={filters.severity}
            onChange={(event) => handleFilterChange('severity', event.target.value)}
            className="input"
          >
            <option value="">全部严重程度</option>
            {SEVERITIES.map(severity => <option key={severity} value={severity}>{severity}</option>)}
          </select>
          <input
            type="text"
            placeholder="订单号"
            value={filters.orderNumber}
            onChange={(event) => handleFilterChange('orderNumber', event.target.value)}
            className="input"
          />
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="关键词"
              value={filters.keyword}
              onChange={(event) => handleFilterChange('keyword', event.target.value)}
              className="input pl-10"
            />
          </div>
          <select
            value={filters.isWindControl}
            onChange={(event) => handleFilterChange('isWindControl', event.target.value)}
            className="input"
          >
            <option value="">全部风控</option>
            <option value="true">风控</option>
            <option value="false">非风控</option>
          </select>
          <select
            value={filters.success}
            onChange={(event) => handleFilterChange('success', event.target.value)}
            className="input"
          >
            <option value="">全部结果</option>
            <option value="true">成功</option>
            <option value="false">失败</option>
          </select>
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={applyFilters} className="btn btn-primary">应用筛选</button>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-gray-600">加载日志...</p>
            </div>
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-600">暂无系统日志</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  {['时间', '严重程度', '类型', '订单号', '事件', '代理 IP', 'HTTP 状态', '耗时', '结果', '错误摘要', '操作'].map(label => (
                    <th key={label} className="text-left py-3 px-4 text-sm font-medium text-gray-500 whitespace-nowrap">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-white">
                {logs.map(log => (
                  <tr key={log.id} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
                    <td className="py-4 px-4 text-sm text-gray-600">{new Date(log.time).toLocaleString('zh-CN')}</td>
                    <td className="py-4 px-4">{getSeverityBadge(log.severity)}</td>
                    <td className="py-4 px-4 text-sm text-gray-600">{log.type}</td>
                    <td className="py-4 px-4 text-sm font-mono text-primary">{log.order_number || '-'}</td>
                    <td className="py-4 px-4 text-sm text-gray-900">{log.event || '-'}</td>
                    <td className="py-4 px-4 text-sm text-gray-600">{log.proxy_ip || '-'}</td>
                    <td className="py-4 px-4 text-sm text-gray-600">{log.http_status || '-'}</td>
                    <td className="py-4 px-4 text-sm text-gray-600">{log.response_time ? `${log.response_time}ms` : '-'}</td>
                    <td className="py-4 px-4">
                      <span className={`badge ${log.success ? 'badge-success' : 'badge-error'} inline-flex items-center gap-1`}>
                        {log.success ? <CheckCircle className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                        {log.result || (log.success ? 'success' : 'failed')}
                      </span>
                    </td>
                    <td className="py-4 px-4 text-sm text-gray-600 max-w-xs truncate">{log.error_summary || '-'}</td>
                    <td className="py-4 px-4">
                      <button onClick={() => setSelectedLog(log)} className="text-primary hover:text-blue-700 text-sm">
                        详情
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!loading && pagination.totalItems > 0 && (
        <Pagination
          currentPage={pagination.currentPage}
          totalPages={pagination.totalPages}
          totalItems={pagination.totalItems}
          pageSize={pagination.pageSize}
          onPageChange={(page) => setPagination(prev => ({ ...prev, currentPage: page }))}
          onPageSizeChange={(size) => setPagination(prev => ({
            ...prev,
            pageSize: size,
            currentPage: 1,
            totalPages: Math.ceil(prev.totalItems / size),
          }))}
          pageSizeOptions={[10, 20, 50, 100]}
        />
      )}

      {selectedLog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">日志详情</h2>
                <p className="text-gray-500 mt-1">{selectedLog.event || selectedLog.type}</p>
              </div>
              <button onClick={() => setSelectedLog(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {selectedLog.order_id && (
                <a
                  href={`/orders/${selectedLog.order_id}`}
                  className="text-primary hover:underline text-sm inline-flex items-center gap-1"
                >
                  关联订单 {selectedLog.order_number}
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-2">上下文 JSON</h3>
                <pre className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-xs text-gray-700 overflow-x-auto">
                  {JSON.stringify(selectedLog.context || selectedLog.crawled_data || {}, null, 2)}
                </pre>
              </div>
              {selectedLog.error_stack && (
                <div>
                  <h3 className="text-sm font-medium text-gray-700 mb-2">错误堆栈</h3>
                  <pre className="bg-red-50 border border-red-200 rounded-lg p-4 text-xs text-red-700 overflow-x-auto whitespace-pre-wrap">
                    {selectedLog.error_stack}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {alertInfo && (
        <AlertModal
          title={alertInfo.title}
          message={alertInfo.message}
          onClose={() => setAlertInfo(null)}
        />
      )}
    </div>
  )
}
