import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  buildAvailabilityTrend,
  formatDate,
  formatFamily,
  formatTime,
} from './applePurchaseAvailabilityFilters';

const INTERVALS = [
  ['hour', '按小时'],
  ['day', '按天'],
];
const STROKES = [
  { stroke: '#1e3a8a' },
  { stroke: '#356d9b', strokeDasharray: '7 4' },
  { stroke: '#607b97', strokeDasharray: '2 4' },
];

function formatBucket(time, interval, compact = false) {
  const date = formatDate(time);
  if (interval === 'day') return compact ? date.slice(5) : date;
  const hour = formatTime(time).slice(0, 5);
  return compact ? hour : `${date} ${hour}`;
}

/** 按机型展示当前筛选下的有货检测次数趋势。 */
export default function ApplePurchaseAvailabilityTrend({
  bounds,
  rows,
  error,
  loading,
  families,
  interval,
  onIntervalChange,
}) {
  const { points, models } = useMemo(
    () => buildAvailabilityTrend(rows ? bounds : null, rows ?? [], interval),
    [bounds, rows, interval]
  );
  const series = models.map(model => ({
    model,
    ...STROKES[Math.max(families.indexOf(model), 0) % STROKES.length],
  }));
  const showDateOnTicks =
    interval === 'hour' &&
    points.length > 0 &&
    formatDate(points[0].time) !== formatDate(points.at(-1).time);
  const formatTick = time =>
    showDateOnTicks ? formatBucket(time, interval).slice(5) : formatBucket(time, interval, true);
  const total = rows?.reduce((sum, row) => sum + row.count, 0) ?? 0;
  const peak = points.reduce(
    (maximum, point) => Math.max(maximum, ...Object.values(point.counts)),
    0
  );
  const tickStep = Math.max(1, Math.ceil((peak + 1) / 4));
  const yTicks = peak < 2 ? [0, 1, 2] : [0, tickStep, 2 * tickStep, 3 * tickStep, 4 * tickStep];

  return (
    <div className="apav-trend">
      <div className="apav-trend-head">
        <div>
          <h2>检测到有货次数</h2>
          <p aria-live="polite">
            {loading || error
              ? '北京时间'
              : `匹配记录 ${total.toLocaleString('zh-CN')} 次 · 北京时间`}
          </p>
        </div>
        <div className="apav-intervals" role="group" aria-label="统计粒度">
          {INTERVALS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="btn btn-secondary"
              aria-pressed={interval === key}
              onClick={() => onIntervalChange(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {series.length > 0 && (
        <ul className="apav-trend-legend" aria-label="统计机型">
          {series.map(({ model, stroke, strokeDasharray }) => (
            <li key={model}>
              <svg width="20" height="8" aria-hidden="true">
                <line
                  x1="0"
                  x2="20"
                  y1="4"
                  y2="4"
                  stroke={stroke}
                  strokeWidth="2"
                  strokeDasharray={strokeDasharray}
                />
              </svg>
              {formatFamily(model)}
            </li>
          ))}
        </ul>
      )}
      {loading && (
        <p className="apav-empty" role="status">
          正在统计有货记录…
        </p>
      )}
      {error && (
        <p className="apav-empty" role="alert">
          {error.message}
          {error.code === 'TREND_RANGE_TOO_WIDE'
            ? '，可缩短筛选时间或切换按天。'
            : '，可刷新后重试。'}
        </p>
      )}
      {!loading &&
        !error &&
        (points.length ? (
          <>
            <div className="apav-chart" aria-label="有货检测次数折线图">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <LineChart
                  data={points}
                  margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
                  accessibilityLayer
                >
                  <CartesianGrid vertical={false} stroke="#e3e7ed" />
                  <XAxis
                    dataKey="time"
                    tickFormatter={formatTick}
                    interval="preserveStartEnd"
                    minTickGap={24}
                    padding={{ left: 10, right: showDateOnTicks ? 30 : 10 }}
                    tick={{ fontSize: 12, fill: '#566274' }}
                    tickLine={false}
                    axisLine={{ stroke: '#d2d9e3' }}
                  />
                  <YAxis
                    width={34}
                    allowDecimals={false}
                    ticks={yTicks}
                    domain={[0, yTicks.at(-1)]}
                    tick={{ fontSize: 12, fill: '#566274' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    labelFormatter={time => formatBucket(time, interval)}
                    formatter={(value, name) => [`${value} 次`, name]}
                    cursor={{ stroke: '#d2d9e3' }}
                    isAnimationActive={false}
                  />
                  {(series.length ? series : [{ model: '匹配记录', ...STROKES[0] }]).map(
                    ({ model, stroke, strokeDasharray }) => (
                      <Line
                        key={model}
                        name={formatFamily(model)}
                        dataKey={point => point.counts[model] ?? 0}
                        type="linear"
                        stroke={stroke}
                        strokeDasharray={strokeDasharray}
                        strokeWidth={2}
                        dot={points.length === 1 ? { r: 3 } : false}
                        activeDot={{ r: 4 }}
                        isAnimationActive={false}
                      />
                    )
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="apav-trend-note">
              {total
                ? '每条匹配记录计 1 次。图表以 PP 已收录的检测时间范围为限。'
                : '所选时段暂无匹配记录。'}
            </p>
          </>
        ) : (
          <p className="apav-empty">所选时段内没有已同步的检测时间范围。</p>
        ))}
    </div>
  );
}
