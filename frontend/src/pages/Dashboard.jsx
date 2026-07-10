import { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown, Package, Clock, DollarSign, Users } from 'lucide-react';
import { LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import {
  getDashboardStats,
  getDailyOrderTrend,
  getProductModelDistribution,
  getStoreDistribution,
  getFilterOptions
} from '../api/dashboard';

// 图表配色方案
const CHART_COLORS = {
  primary: '#1E3A8A',
  secondary: '#8B5CF6',
  success: '#10B981',
  warning: '#F59E0B',
  error: '#EF4444',
  gradient: ['#8B5CF6', '#6366F1', '#3B82F6', '#06B6D4', '#10B981']
};

const Dashboard = () => {
  // 状态管理
  const [loading, setLoading] = useState(true);
  const [useMockData, setUseMockData] = useState(true); // 控制是否使用 Mock 数据
  const [stats, setStats] = useState({
    totalOrders: 0,
    totalAmount: 0,
    pendingOrders: 0,
    activeRecipients: 0,
    orderGrowth: 0,
    amountGrowth: 0
  });
  const [dailyTrend, setDailyTrend] = useState([]);
  const [productDistribution, setProductDistribution] = useState([]);
  const [storeDistribution, setStoreDistribution] = useState([]);
  const [filterOptions, setFilterOptions] = useState({
    productModels: [],
    stores: []
  });

  // 筛选参数
  const [filters, setFilters] = useState({
    startDate: getDefaultStartDate(),
    endDate: getDefaultEndDate(),
    status: '',
    productModel: '',
    store: ''
  });

  // 获取默认日期（近7天）
  function getDefaultStartDate() {
    const date = new Date();
    date.setDate(date.getDate() - 6);
    return date.toISOString().split('T')[0];
  }

  function getDefaultEndDate() {
    return new Date().toISOString().split('T')[0];
  }

  // Mock 数据（用于开发和演示）
  const mockStats = {
    totalOrders: 12480,
    totalAmount: 8425000,
    pendingOrders: 452,
    activeRecipients: 1204,
    orderGrowth: 12.5,
    amountGrowth: 8.2
  };

  const mockDailyTrend = [
    { date: '7月2日', count: 1580 },
    { date: '7月3日', count: 1820 },
    { date: '7月4日', count: 1650 },
    { date: '7月5日', count: 2100 },
    { date: '7月6日', count: 1950 },
    { date: '7月7日', count: 2380 },
    { date: '7月8日', count: 2480 }
  ];

  const mockProductDistribution = [
    { name: 'iPhone 15 Pro', value: 6240 },
    { name: 'iPhone 15', value: 3850 },
    { name: 'iPhone 15 Pro Max', value: 1680 },
    { name: 'MacBook Pro', value: 510 },
    { name: 'AirPods Pro', value: 200 }
  ];

  const mockStoreDistribution = [
    { name: '上海国金中心', value: 5241 },
    { name: '北京三里屯', value: 3280 },
    { name: '深圳万象城', value: 2150 },
    { name: '广州天环', value: 1180 },
    { name: '杭州湖滨银泰', value: 629 }
  ];

  const mockFilterOptions = {
    productModels: [
      'iPhone 15 Pro',
      'iPhone 15',
      'iPhone 15 Pro Max',
      'MacBook Pro 14',
      'MacBook Pro 16',
      'AirPods Pro'
    ],
    stores: [
      '上海国金中心',
      '北京三里屯',
      '深圳万象城',
      '广州天环',
      '杭州湖滨银泰',
      '成都万象城'
    ]
  };

  // 加载数据
  useEffect(() => {
    loadDashboardData();
  }, [filters, useMockData]);

  // 加载筛选器选项
  useEffect(() => {
    loadFilterOptions();
  }, [useMockData]);

  const loadDashboardData = async () => {
    try {
      setLoading(true);

      if (useMockData) {
        // 使用 Mock 数据
        await new Promise(resolve => setTimeout(resolve, 500)); // 模拟网络延迟
        setStats(mockStats);
        setDailyTrend(mockDailyTrend);
        setProductDistribution(mockProductDistribution);
        setStoreDistribution(mockStoreDistribution);
      } else {
        // 真实 API 调用
        const [statsData, trendData, productData, storeData] = await Promise.all([
          getDashboardStats(filters),
          getDailyOrderTrend(filters),
          getProductModelDistribution(filters),
          getStoreDistribution(filters)
        ]);

        setStats(statsData.data);
        setDailyTrend(trendData.data);
        setProductDistribution(productData.data);
        setStoreDistribution(storeData.data);
      }
    } catch (error) {
      console.error('加载仪表板数据失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadFilterOptions = async () => {
    try {
      if (useMockData) {
        setFilterOptions(mockFilterOptions);
      } else {
        const response = await getFilterOptions();
        setFilterOptions(response.data);
      }
    } catch (error) {
      console.error('加载筛选器选项失败:', error);
    }
  };

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  };

  const resetFilters = () => {
    setFilters({
      startDate: getDefaultStartDate(),
      endDate: getDefaultEndDate(),
      status: '',
      productModel: '',
      store: ''
    });
  };

  // 格式化金额
  const formatAmount = (amount) => {
    return new Intl.NumberFormat('zh-CN').format(amount);
  };

  // 格式化百分比
  const formatPercent = (value) => {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(1)}%`;
  };

  // 自定义 Tooltip
  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white px-4 py-3 rounded-lg shadow-lg border border-gray-200">
          <p className="text-sm font-medium text-gray-600 mb-1">{label}</p>
          <p className="text-lg font-bold text-purple-600">
            订单数: {payload[0].value}
          </p>
        </div>
      );
    }
    return null;
  };

  // 自定义饼图标签
  const renderCustomLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }) => {
    const RADIAN = Math.PI / 180;
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    if (percent < 0.05) return null; // 小于5%不显示标签

    return (
      <text
        x={x}
        y={y}
        fill="white"
        textAnchor={x > cx ? 'start' : 'end'}
        dominantBaseline="central"
        className="text-sm font-bold"
        style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}
      >
        {`${(percent * 100).toFixed(0)}%`}
      </text>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Mock 数据切换开关 */}
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-3 bg-white px-4 py-2 rounded-lg shadow-sm border border-gray-200">
          <span className="text-sm font-medium text-gray-700">
            {useMockData ? '📊 Mock 数据' : '🔗 真实 API'}
          </span>
          <button
            onClick={() => setUseMockData(!useMockData)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              useMockData ? 'bg-purple-600' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                useMockData ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* 筛选区域 - 优化后的 UI */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex flex-wrap items-end gap-4">
          {/* 日期范围（合并开始日期和结束日期） */}
          <div className="flex-1 min-w-[280px]">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              日期范围
            </label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={filters.startDate}
                onChange={(e) => handleFilterChange('startDate', e.target.value)}
                className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              />
              <span className="text-gray-400">-</span>
              <input
                type="date"
                value={filters.endDate}
                onChange={(e) => handleFilterChange('endDate', e.target.value)}
                className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              />
            </div>
          </div>

          {/* 订单状态 */}
          <div className="flex-1 min-w-[180px]">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              订单状态
            </label>
            <select
              value={filters.status}
              onChange={(e) => handleFilterChange('status', e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent transition-all bg-white"
            >
              <option value="">全部状态</option>
              <option value="待处理">待处理</option>
              <option value="处理中">处理中</option>
              <option value="已发货">已发货</option>
              <option value="可取货">可取货</option>
              <option value="已完成">已完成</option>
              <option value="已取消">已取消</option>
            </select>
          </div>

          {/* 产品型号 */}
          <div className="flex-1 min-w-[180px]">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              产品型号
            </label>
            <select
              value={filters.productModel}
              onChange={(e) => handleFilterChange('productModel', e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent transition-all bg-white"
            >
              <option value="">全部型号</option>
              {filterOptions.productModels.map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          </div>

          {/* 取机门店 */}
          <div className="flex-1 min-w-[180px]">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              取机门店
            </label>
            <select
              value={filters.store}
              onChange={(e) => handleFilterChange('store', e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent transition-all bg-white"
            >
              <option value="">全部门店</option>
              {filterOptions.stores.map((store) => (
                <option key={store} value={store}>{store}</option>
              ))}
            </select>
          </div>

          {/* 重置按钮 - 与筛选项在同一行 */}
          <div>
            <button
              onClick={resetFilters}
              className="px-6 py-2.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors whitespace-nowrap"
            >
              重置筛选
            </button>
          </div>
        </div>
      </div>

      {/* 统计卡片 - 优化后的 UI */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* 总订单量 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-500 mb-2">总订单量</p>
              <div className="flex items-baseline gap-3 mb-2">
                <h3 className="text-3xl font-bold text-gray-900">
                  {formatAmount(stats.totalOrders)}
                </h3>
                {stats.orderGrowth !== 0 && (
                  <span className={`text-sm font-semibold flex items-center ${
                    stats.orderGrowth > 0 ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {stats.orderGrowth > 0 ? (
                      <TrendingUp className="w-4 h-4 mr-1" />
                    ) : (
                      <TrendingDown className="w-4 h-4 mr-1" />
                    )}
                    {formatPercent(stats.orderGrowth)}
                  </span>
                )}
              </div>
            </div>
            <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center flex-shrink-0">
              <Package className="w-6 h-6 text-blue-600" />
            </div>
          </div>
        </div>

        {/* 待取订单 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-500 mb-2">待取订单</p>
              <div className="flex items-baseline gap-3 mb-2">
                <h3 className="text-3xl font-bold text-gray-900">
                  {formatAmount(stats.pendingOrders)}
                </h3>
                <span className="px-2 py-1 text-xs font-semibold text-orange-700 bg-orange-100 rounded-md">
                  需处理
                </span>
              </div>
            </div>
            <div className="w-12 h-12 bg-orange-50 rounded-xl flex items-center justify-center flex-shrink-0">
              <Clock className="w-6 h-6 text-orange-600" />
            </div>
          </div>
        </div>

        {/* 订单总额 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-500 mb-2">订单总额</p>
              <div className="flex items-baseline gap-3 mb-2">
                <h3 className="text-3xl font-bold text-gray-900">
                  {formatAmount(stats.totalAmount)}
                </h3>
                {stats.amountGrowth !== 0 && (
                  <span className={`text-sm font-semibold flex items-center ${
                    stats.amountGrowth > 0 ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {stats.amountGrowth > 0 ? (
                      <TrendingUp className="w-4 h-4 mr-1" />
                    ) : (
                      <TrendingDown className="w-4 h-4 mr-1" />
                    )}
                    {formatPercent(stats.amountGrowth)}
                  </span>
                )}
              </div>
            </div>
            <div className="w-12 h-12 bg-green-50 rounded-xl flex items-center justify-center flex-shrink-0">
              <DollarSign className="w-6 h-6 text-green-600" />
            </div>
          </div>
        </div>

        {/* 活跃收件人 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-500 mb-2">活跃收件人</p>
              <div className="flex items-baseline gap-3 mb-2">
                <h3 className="text-3xl font-bold text-gray-900">
                  {formatAmount(stats.activeRecipients)}
                </h3>
                <span className="px-2 py-1 text-xs font-semibold text-green-700 bg-green-100 rounded-md">
                  在线
                </span>
              </div>
            </div>
            <div className="w-12 h-12 bg-purple-50 rounded-xl flex items-center justify-center flex-shrink-0">
              <Users className="w-6 h-6 text-purple-600" />
            </div>
          </div>
        </div>
      </div>

      {/* 近7日订单趋势 - 优化后的 UI */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-gray-900">近7日订单趋势</h2>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-purple-600"></div>
            <span className="text-sm font-medium text-gray-600">订单总数</span>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={dailyTrend}>
            <defs>
              <linearGradient id="colorOrders" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#8B5CF6" stopOpacity={0.3}/>
                <stop offset="95%" stopColor="#8B5CF6" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
            <XAxis
              dataKey="date"
              stroke="#6B7280"
              style={{ fontSize: '12px', fontWeight: '500' }}
              tickLine={false}
            />
            <YAxis
              stroke="#6B7280"
              style={{ fontSize: '12px', fontWeight: '500' }}
              tickLine={false}
            />
            <Tooltip content={<CustomTooltip />} />
            <Line
              type="monotone"
              dataKey="count"
              stroke="#8B5CF6"
              strokeWidth={3}
              dot={{ fill: '#8B5CF6', strokeWidth: 2, r: 5 }}
              activeDot={{ r: 7, strokeWidth: 0 }}
              fill="url(#colorOrders)"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* 分布图 - 优化后的 UI */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 产品型号分布 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-bold text-gray-900 mb-6">订单产品型号分布</h2>
          {productDistribution.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <PieChart>
                <Pie
                  data={productDistribution}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={renderCustomLabel}
                  outerRadius={110}
                  innerRadius={70}
                  fill="#8884d8"
                  dataKey="value"
                  paddingAngle={2}
                >
                  {productDistribution.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={CHART_COLORS.gradient[index % CHART_COLORS.gradient.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value, name, props) => [
                    `${value} (${((props.percent || 0) * 100).toFixed(1)}%)`,
                    props.payload.name
                  ]}
                  contentStyle={{
                    backgroundColor: 'white',
                    border: '1px solid #E5E7EB',
                    borderRadius: '8px',
                    padding: '12px'
                  }}
                />
                <Legend
                  verticalAlign="bottom"
                  height={50}
                  formatter={(value, entry) => (
                    <span className="text-sm font-medium text-gray-700">
                      {entry.payload.name} <span className="text-gray-500">({entry.payload.value})</span>
                    </span>
                  )}
                  iconType="circle"
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-80 text-gray-400">
              <div className="text-center">
                <Package className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p className="text-sm">暂无数据</p>
              </div>
            </div>
          )}
        </div>

        {/* 取货门店分布 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-bold text-gray-900 mb-6">取货门店分布</h2>
          {storeDistribution.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <PieChart>
                <Pie
                  data={storeDistribution}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={renderCustomLabel}
                  outerRadius={110}
                  innerRadius={70}
                  fill="#8884d8"
                  dataKey="value"
                  paddingAngle={2}
                >
                  {storeDistribution.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={CHART_COLORS.gradient[index % CHART_COLORS.gradient.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value, name, props) => [
                    `${value} (${((props.percent || 0) * 100).toFixed(1)}%)`,
                    props.payload.name
                  ]}
                  contentStyle={{
                    backgroundColor: 'white',
                    border: '1px solid #E5E7EB',
                    borderRadius: '8px',
                    padding: '12px'
                  }}
                />
                <Legend
                  verticalAlign="bottom"
                  height={50}
                  formatter={(value, entry) => (
                    <span className="text-sm font-medium text-gray-700">
                      {entry.payload.name} <span className="text-gray-500">({entry.payload.value})</span>
                    </span>
                  )}
                  iconType="circle"
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-80 text-gray-400">
              <div className="text-center">
                <Package className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p className="text-sm">暂无数据</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
