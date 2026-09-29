import { useCallback, useEffect, useMemo, useState } from 'react';
import { Apple, Check, Copy, RefreshCw, Search } from 'lucide-react';
import { getPublicAppleQuotes } from '../api/quotePricingApi';

const formatCurrency = (value, emptyLabel = '—') =>
  value === null || value === undefined
    ? emptyLabel
    : new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: 'CNY',
        maximumFractionDigits: 0,
      }).format(value);

const formatTime = value =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : '-';

const storageLabel = value =>
  value >= 1024 && value % 1024 === 0 ? `${value / 1024}TB` : `${value}GB`;

/** 无需登录的 Apple 全系固定公开报价页。 */
export default function PublicIphone18Quotes() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ productModel: '', storageGb: '', color: '' });
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await getPublicAppleQuotes();
      setData(response.data);
      setError('');
    } catch (failure) {
      setData(null);
      setError(failure.message || '报价暂时不可用，请稍后再试');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Apple 报价';
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      clearInterval(timer);
      document.title = previousTitle;
    };
  }, [load]);

  const items = useMemo(
    () =>
      (data?.items || []).filter(
        item =>
          (!filters.productModel || item.productModel === filters.productModel) &&
          (!filters.storageGb || item.storageGb === Number(filters.storageGb)) &&
          (!filters.color || item.color === filters.color)
      ),
    [data?.items, filters]
  );

  async function copyText(key, text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(''), 1800);
    } catch (_error) {
      setError('复制失败，请检查浏览器剪贴板权限');
    }
  }

  function copyCurrentList() {
    const text = items
      .map(item => `${item.productName}｜报价 ${formatCurrency(item.quotePrice, '暂未报价')}`)
      .join('\n');
    return copyText('list', text);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-blue-100 bg-white">
        <div className="mx-auto flex max-w-6xl items-center px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50">
              <Apple className="h-5 w-5 text-primary" />
            </div>
            <p className="text-base font-semibold text-gray-900">Apple 报价</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-6 sm:py-8">
        <section className="rounded-2xl border border-blue-100 bg-gradient-to-r from-blue-50 to-white p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">Apple 实时报价</h1>
              <p className="mt-3 text-xs text-gray-500">报价更新：{formatTime(data?.updatedAt)}</p>
            </div>
            <button
              type="button"
              onClick={load}
              className="btn btn-secondary inline-flex items-center gap-2"
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              刷新报价
            </button>
          </div>
        </section>

        {data?.stale && (
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
            报价源最近检查延迟，当前价格仅供参考，请稍后刷新确认。
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading && !data ? (
          <div className="rounded-xl border border-gray-200 bg-white py-20 text-center text-gray-500">
            正在获取最新报价…
          </div>
        ) : data ? (
          <>
            <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="mb-4 flex items-center gap-2 text-sm font-medium text-gray-700">
                <Search className="h-4 w-4 text-primary" />
                筛选商品
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <select
                  className="input"
                  aria-label="型号"
                  value={filters.productModel}
                  onChange={event =>
                    setFilters(previous => ({ ...previous, productModel: event.target.value }))
                  }
                >
                  <option value="">全部型号</option>
                  {data.filters.productModels.map(value => (
                    <option key={value} value={value}>
                      iPhone {value}
                    </option>
                  ))}
                </select>
                <select
                  className="input"
                  aria-label="容量"
                  value={filters.storageGb}
                  onChange={event =>
                    setFilters(previous => ({ ...previous, storageGb: event.target.value }))
                  }
                >
                  <option value="">全部容量</option>
                  {data.filters.storageGb.map(value => (
                    <option key={value} value={value}>
                      {storageLabel(value)}
                    </option>
                  ))}
                </select>
                <select
                  className="input"
                  aria-label="颜色"
                  value={filters.color}
                  onChange={event =>
                    setFilters(previous => ({ ...previous, color: event.target.value }))
                  }
                >
                  <option value="">全部颜色</option>
                  {data.filters.colors.map(value => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
            </section>

            <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
                <p className="text-sm text-gray-600">
                  共 <span className="font-semibold text-gray-900">{items.length}</span> 款商品
                </p>
                <button
                  type="button"
                  className="btn btn-secondary inline-flex items-center gap-2"
                  onClick={copyCurrentList}
                  disabled={items.length === 0}
                >
                  {copied === 'list' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied === 'list' ? '已复制' : '复制当前报价'}
                </button>
              </div>
              <div>
                <table className="w-full divide-y divide-gray-200">
                  <thead className="hidden bg-gray-50 sm:table-header-group">
                    <tr className="text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                      <th className="px-4 py-3">商品</th>
                      <th className="whitespace-nowrap px-4 py-3">对外报价</th>
                      <th className="whitespace-nowrap px-4 py-3">官网价</th>
                      <th className="px-4 py-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {items.map(item => (
                      <tr
                        key={item.productKey}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center hover:bg-blue-50/40 sm:table-row"
                      >
                        <td className="col-span-2 min-w-0 px-4 pb-2 pt-4 sm:table-cell sm:min-w-[260px] sm:py-4">
                          <p className="font-medium text-gray-900">{item.productName}</p>
                          <p className="mt-1 text-xs text-gray-500">
                            {storageLabel(item.storageGb)} · {item.color}
                            <span className="sm:hidden">
                              {' '}
                              · 官网价 {formatCurrency(item.officialPrice)}
                            </span>
                          </p>
                        </td>
                        <td className="whitespace-nowrap px-4 pb-4 pt-1 text-lg font-bold text-primary sm:table-cell sm:py-4">
                          {formatCurrency(item.quotePrice, '暂未报价')}
                        </td>
                        <td className="hidden whitespace-nowrap px-4 py-4 text-sm text-gray-500 sm:table-cell">
                          {formatCurrency(item.officialPrice)}
                        </td>
                        <td className="px-4 pb-4 pt-1 text-right sm:table-cell sm:py-4">
                          <button
                            type="button"
                            className="btn btn-secondary inline-flex items-center gap-2 whitespace-nowrap"
                            onClick={() =>
                              copyText(
                                item.productKey,
                                `${item.productName}｜报价 ${formatCurrency(item.quotePrice, '暂未报价')}`
                              )
                            }
                          >
                            {copied === item.productKey ? (
                              <Check className="h-4 w-4" />
                            ) : (
                              <Copy className="h-4 w-4" />
                            )}
                            {copied === item.productKey ? '已复制' : '复制'}
                          </button>
                        </td>
                      </tr>
                    ))}
                    {items.length === 0 && (
                      <tr>
                        <td colSpan="4" className="px-4 py-16 text-center text-gray-500">
                          没有符合条件的商品
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : (
          <div className="rounded-xl border border-gray-200 bg-white py-20 text-center">
            <p className="font-medium text-gray-900">报价页面暂时不可用</p>
            <p className="mt-2 text-sm text-gray-500">请稍后刷新或联系报价人员。</p>
          </div>
        )}
      </main>
      <footer className="border-t border-gray-200 py-6 text-center text-xs text-gray-400">
        实际成交价格请以最终确认为准
      </footer>
    </div>
  );
}
