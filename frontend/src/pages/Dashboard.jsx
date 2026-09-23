import { useEffect, useState } from 'react';
import { Package, CheckCircle, DollarSign, Users, RefreshCw } from 'lucide-react';
import {
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  getDashboardStats,
  getDailyOrderTrend,
  getProductModelDistribution,
  getCityDistribution,
  getFilterOptions,
} from '../api/dashboard';
import OrderDateFilter from '../components/OrderDateFilter';
import ProductFilter from '../components/ProductFilter';
import TagMultiSelect from '../components/TagMultiSelect';
import { EMAIL_ORDER_STATUS_BADGES } from '../constants/orderStatus';

const STATUS_LABELS = Object.fromEntries(
  Object.entries(EMAIL_ORDER_STATUS_BADGES).map(([key, badge]) => [key, badge.text])
);
const COLORS = ['#8B5CF6', '#6366F1', '#3B82F6', '#06B6D4', '#10B981'];
const METRIC_COLORS = {
  blue: 'bg-blue-50 text-blue-600',
  orange: 'bg-orange-50 text-orange-600',
  green: 'bg-green-50 text-green-600',
  purple: 'bg-purple-50 text-purple-600',
};
const DAY_MS = 86400000;
const formatNumber = value =>
  new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value || 0);

function defaultFilters() {
  const today = new Date(Date.now() + 8 * 3600000);
  return {
    startDate: new Date(today.getTime() - 6 * DAY_MS).toISOString().slice(0, 10),
    endDate: today.toISOString().slice(0, 10),
    emailOrderStatuses: [],
    productKeys: [],
    recipientTags: [],
  };
}

function Metric({ title, value, hint, icon: Icon, growth, tone }) {
  return (
    <section className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm min-w-0">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-600">{title}</h2>
        <div
          className={`w-10 h-10 shrink-0 rounded-lg flex items-center justify-center ${METRIC_COLORS[tone]}`}
        >
          <Icon className="w-5 h-5" />
        </div>
      </div>
      <p className="text-3xl font-bold text-gray-900 mt-2 break-all tabular-nums">{value}</p>
      <p className="text-xs text-gray-500 mt-2">{hint}</p>
      {growth !== null && growth !== undefined && (
        <p className="text-xs text-gray-500 mt-1">
          较上一周期{' '}
          <span className={growth >= 0 ? 'text-green-700' : 'text-red-600'}>
            {growth >= 0 ? '+' : ''}
            {growth.toFixed(1)}%
          </span>
        </p>
      )}
    </section>
  );
}

function Distribution({ title, rows, description }) {
  const total = rows.reduce((sum, item) => sum + item.value, 0);
  return (
    <section className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6 shadow-sm min-w-0">
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      <p className="text-xs text-gray-500 mt-1">{description}</p>
      {total === 0 ? (
        <p className="h-64 flex items-center justify-center text-gray-500">暂无符合条件的订单</p>
      ) : (
        <>
          <div className="h-64 w-full" aria-label={`${title}饼图`}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={rows}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={65}
                  outerRadius={100}
                  paddingAngle={1}
                  isAnimationActive={false}
                >
                  {rows.map((row, index) => (
                    <Cell key={row.key || row.name} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={value => [`${formatNumber(value)} 单`, '订单数']}
                  contentStyle={{ maxWidth: 280, whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-sm table-fixed">
              <thead className="text-gray-500">
                <tr>
                  <th className="text-left font-normal pb-2">
                    {title === '商品分布' ? '商品' : '城市'}
                  </th>
                  <th className="w-16 text-right font-normal">订单数</th>
                  <th className="w-16 text-right font-normal">占比</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.key || row.name} className="border-t border-gray-100">
                    <td className="py-2 pr-2">
                      <div className="flex items-start gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0 mt-1.5"
                          style={{ backgroundColor: COLORS[index % COLORS.length] }}
                        />
                        <span className="break-words">{row.name}</span>
                      </div>
                    </td>
                    <td className="text-right tabular-nums">{formatNumber(row.value)}</td>
                    <td className="text-right tabular-nums">
                      {((row.value / total) * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** 仪表板：筛选后订单指标和分布，取机人独立按 TAG 统计。 */
export default function Dashboard() {
  const [filters, setFilters] = useState(defaultFilters);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [options, setOptions] = useState({ productOptions: [], recipientTags: [] });
  const invalidDate = filters.startDate && filters.endDate && filters.startDate > filters.endDate;

  useEffect(() => {
    let active = true;
    if (invalidDate) {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    const load = async () => {
      try {
        setLoading(true);
        setError('');
        const [stats, trend, products, cities, candidates] = await Promise.all([
          getDashboardStats(filters),
          getDailyOrderTrend(filters),
          getProductModelDistribution(filters),
          getCityDistribution(filters),
          getFilterOptions(filters),
        ]);
        if (active) {
          setData({
            stats: stats.data,
            trend: trend.data,
            products: products.data,
            cities: cities.data,
          });
          setOptions(candidates.data);
        }
      } catch (failure) {
        if (active) setError(failure.message || '加载仪表板失败，请重试');
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [filters, retry, invalidDate]);

  const change = (key, value) => setFilters(previous => ({ ...previous, [key]: value }));
  const stats = data?.stats;
  const rangeLabel =
    filters.startDate || filters.endDate
      ? `${filters.startDate || '最早'} 至 ${filters.endDate || '至今'}`
      : '全部日期';
  return (
    <div className="space-y-6 min-w-0">
      <section className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6 shadow-sm space-y-4">
        <div className="[&>div]:grid-cols-1 [&_input]:min-w-0">
          <OrderDateFilter
            dateFrom={filters.startDate}
            dateTo={filters.endDate}
            onChange={({ dateFrom, dateTo }) =>
              setFilters(previous => ({ ...previous, startDate: dateFrom, endDate: dateTo }))
            }
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-[1fr_2fr_1fr_auto] gap-4 items-end">
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 mb-2">订单状态（邮件）</label>
            <TagMultiSelect
              options={Object.keys(STATUS_LABELS)}
              optionLabels={STATUS_LABELS}
              value={filters.emailOrderStatuses}
              onChange={value => change('emailOrderStatuses', value)}
              ariaLabel="邮件订单状态筛选"
              placeholder="全部状态"
              itemLabel="状态"
            />
          </div>
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 mb-2">商品</label>
            <ProductFilter
              options={options.productOptions}
              value={filters.productKeys}
              onChange={value => change('productKeys', value)}
            />
          </div>
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 mb-2">取机人 TAG</label>
            <TagMultiSelect
              options={options.recipientTags}
              value={filters.recipientTags}
              onChange={value => change('recipientTags', value)}
              ariaLabel="取机人 TAG 筛选"
              placeholder="全部 TAG"
              itemLabel="TAG"
            />
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setFilters(defaultFilters())}
          >
            重置筛选
          </button>
        </div>
      </section>
      {invalidDate ? (
        <p role="alert" className="text-red-600">
          开始日期不能晚于结束日期
        </p>
      ) : loading ? (
        <div role="status" className="h-64 flex items-center justify-center gap-2 text-gray-500">
          <RefreshCw className="w-4 h-4 animate-spin" />
          正在加载仪表板…
        </div>
      ) : error ? (
        <div role="alert" className="bg-white border border-red-200 rounded-xl p-6">
          <p className="text-red-600">{error}</p>
          <button className="btn btn-secondary mt-3" onClick={() => setRetry(value => value + 1)}>
            重试
          </button>
        </div>
      ) : (
        data && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <Metric
                title="订单总数"
                value={formatNumber(stats.totalOrders)}
                hint="当前筛选范围内的订单"
                icon={Package}
                tone="blue"
                growth={stats.orderGrowth}
              />
              <Metric
                title="已付款订单数"
                value={formatNumber(stats.paidOrders)}
                hint="邮件状态：处理中、可取货"
                icon={CheckCircle}
                tone="orange"
              />
              <Metric
                title="订单总金额"
                value={`¥${formatNumber(stats.totalAmount)}`}
                hint={`按官方售价计算${stats.missingAmountOrders ? ` · ${stats.missingAmountOrders} 笔待售价确认` : ''}`}
                icon={DollarSign}
                tone="green"
                growth={stats.amountGrowth}
              />
              <Metric
                title="可用取机人"
                value={formatNumber(stats.availableRecipients)}
                hint={`${filters.recipientTags.length ? '所选 TAG' : '全部 TAG'} · 使用中、未使用`}
                icon={Users}
                tone="purple"
              />
            </div>
            <section className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6 shadow-sm min-w-0">
              <h2 className="text-lg font-semibold text-gray-900">订单趋势</h2>
              <p className="text-xs text-gray-500 mt-1">{rangeLabel} · 北京时间 · 订单数</p>
              {stats.totalOrders === 0 ? (
                <p className="h-64 flex items-center justify-center text-gray-500">
                  暂无符合条件的订单
                </p>
              ) : (
                <div className="h-72 sm:h-80 mt-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={data.trend}
                      margin={{ top: 10, right: 12, left: -20, bottom: 10 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                      <XAxis
                        dataKey="date"
                        tickFormatter={date => date.slice(5).replace('-', '/')}
                        tick={{ fontSize: 12 }}
                        minTickGap={24}
                      />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                      <Tooltip formatter={value => [`${formatNumber(value)} 单`, '订单数']} />
                      <Line
                        type="linear"
                        dataKey="count"
                        stroke="#8B5CF6"
                        strokeWidth={2}
                        dot={data.trend.length <= 31}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <Distribution
                title="商品分布"
                rows={data.products}
                description="按订单数统计；同单同款去重，多商品订单可分别计入各组"
              />
              <Distribution
                title="城市分布"
                rows={data.cities}
                description="按取货门店所在城市统计订单数"
              />
            </div>
          </>
        )
      )}
    </div>
  );
}
