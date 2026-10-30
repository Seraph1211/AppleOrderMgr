import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getPublicDuoQuoteHistory } from '../api/quotePricingApi';
import './duoQuoteHistory.css';

const CAPACITIES = [256, 512, 1024, 2048];
const RANGES = [
  ['24h', '24小时'],
  ['7d', '近7天'],
  ['30d', '近30天'],
  ['all', '全部'],
];
const LINE_STYLES = {
  'retail-midnight': { stroke: '#1d5fbf' },
  'retail-starlight': { stroke: '#20252b' },
  official: { stroke: '#78828e', strokeDasharray: '7 5' },
  'official-midnight': { stroke: '#66717e', strokeDasharray: '7 5' },
  'official-starlight': { stroke: '#9aa2ab', strokeDasharray: '3 5' },
};

const formatCapacity = value => (value >= 1024 ? `${value / 1024}TB` : `${value}G`);
const formatPrice = value =>
  value === null || value === undefined
    ? '—'
    : `¥${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)}`;
const formatDateTime = value =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(value))
    .replaceAll('/', '-');
const formatCompactDateTime = value =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(value))
    .replaceAll('/', '-');
const formatTime = value =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
const formatDelta = value => {
  if (value === null || value === undefined) return '本范围内未变';
  if (value === 0) return '较上次持平';
  return `较上次 ${value > 0 ? '+' : '-'}¥${Math.abs(value).toLocaleString('zh-CN')}`;
};
const formatSignedPrice = value => {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '¥0';
  return `${value > 0 ? '+' : '-'}¥${Math.abs(value).toLocaleString('zh-CN')}`;
};

function useCompactChart() {
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 639px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)');
    const update = event => setCompact(event.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}

function buildChartData(series, rangeEnd) {
  const times = [
    ...new Set(series.flatMap(item => item.points.map(point => Date.parse(point.changedAt)))),
  ];
  const endTime = Date.parse(rangeEnd);
  if (Number.isFinite(endTime) && times.length && !times.includes(endTime)) times.push(endTime);
  times.sort((left, right) => left - right);
  const pointMaps = new Map(
    series.map(item => [
      item.key,
      new Map(item.points.map(point => [Date.parse(point.changedAt), point])),
    ])
  );
  const current = new Map();
  return times.map(time => {
    const row = { time };
    series.forEach(item => {
      const points = pointMaps.get(item.key);
      const point = points.get(time);
      if (point) current.set(item.key, point.price);
      row[item.key] = current.has(item.key) ? current.get(item.key) : undefined;
      row[`${item.key}Changed`] = Boolean(point && !point.baseline);
    });
    return row;
  });
}

function ChangeDot({ cx, cy, payload, seriesKey, stroke }) {
  if (!payload?.[`${seriesKey}Changed`] || !Number.isFinite(cx) || !Number.isFinite(cy))
    return null;
  return <circle cx={cx} cy={cy} r="2.8" fill="#ffffff" stroke={stroke} strokeWidth="1.8" />;
}

function latestPrice(series) {
  return series.points.length ? series.points.at(-1).price : null;
}

function latestDelta(series) {
  if (series.points.length < 2) return null;
  const current = series.points.at(-1).price;
  const previous = series.points.at(-2).price;
  if (current === null || previous === null) return null;
  return current - previous;
}

function officialSeriesForRetail(retailSeries, officialSeries) {
  const colorKey = retailSeries.key.replace('retail-', '');
  return (
    officialSeries.find(item => item.key === `official-${colorKey}`) ||
    officialSeries.find(item => item.key === 'official') ||
    null
  );
}

function premiumForTooltip(entry, payload) {
  if (!entry.dataKey.startsWith('retail-') || entry.value === null || entry.value === undefined) {
    return null;
  }
  const colorKey = entry.dataKey.replace('retail-', '');
  const official =
    payload.find(item => item.dataKey === `official-${colorKey}`) ||
    payload.find(item => item.dataKey === 'official');
  if (!official || official.value === null || official.value === undefined) return null;
  return entry.value - official.value;
}

function PriceTooltip({ active, label, payload }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="duo-history-tooltip">
      <p>{formatDateTime(label)}</p>
      {payload.map(entry => (
        <div key={entry.dataKey}>
          <span className="duo-history-tooltip__mark" style={{ backgroundColor: entry.stroke }} />
          <span className="duo-history-tooltip__label">
            {entry.name}
            {entry.dataKey.startsWith('retail-') && (
              <small>（溢价 {formatSignedPrice(premiumForTooltip(entry, payload))}）</small>
            )}
          </span>
          <strong>{formatPrice(entry.value)}</strong>
        </div>
      ))}
    </div>
  );
}

/** 无需登录的iPhone Duo零售价与官网价走势页。 */
export default function DuoQuoteHistory() {
  const [capacity, setCapacity] = useState(256);
  const [range, setRange] = useState('7d');
  const [rangeOpen, setRangeOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const activeRequest = useRef(null);
  const requestId = useRef(0);
  const rangeTriggerRef = useRef(null);
  const rangeOptionRefs = useRef([]);
  const compact = useCompactChart();

  const load = useCallback(async selectedRange => {
    const id = ++requestId.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    try {
      const result = await getPublicDuoQuoteHistory(selectedRange, controller.signal);
      if (id === requestId.current && !controller.signal.aborted) {
        setData(result);
        setError('');
      }
    } catch (failure) {
      if (id === requestId.current && !controller.signal.aborted) {
        setError(failure.message || '价格走势暂时不可用，请稍后再试');
      }
    } finally {
      if (id === requestId.current && !controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'iPhone Duo 价格走势';
    load(range);
    const timer = window.setInterval(() => load(range), 60_000);
    let stream;
    if (typeof window.EventSource === 'function') {
      stream = new window.EventSource('/api/public/duo-quotes/events');
      stream.addEventListener('quote-version', () => load(range));
    }
    return () => {
      window.clearInterval(timer);
      stream?.close();
      activeRequest.current?.abort();
      document.title = previousTitle;
    };
  }, [load, range]);

  const focusRangeOption = index => {
    window.requestAnimationFrame(() => rangeOptionRefs.current[index]?.focus());
  };
  const openRangeMenu = focusIndex => {
    setRangeOpen(true);
    if (Number.isInteger(focusIndex)) focusRangeOption(focusIndex);
  };
  const closeRangeMenu = (returnFocus = false) => {
    setRangeOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => rangeTriggerRef.current?.focus());
  };
  const selectRange = selectedRange => {
    setRange(selectedRange);
    closeRangeMenu(true);
  };
  const handleRangeTriggerKeyDown = event => {
    const selectedIndex = RANGES.findIndex(item => item[0] === range);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openRangeMenu(selectedIndex);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openRangeMenu(selectedIndex);
    } else if (event.key === 'Escape') {
      closeRangeMenu();
    }
  };
  const handleRangeOptionKeyDown = (event, index) => {
    let nextIndex = null;
    if (event.key === 'ArrowDown') nextIndex = (index + 1) % RANGES.length;
    if (event.key === 'ArrowUp') nextIndex = (index - 1 + RANGES.length) % RANGES.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = RANGES.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      focusRangeOption(nextIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeRangeMenu(true);
    }
  };
  const selected = data?.capacities?.find(item => item.storageGb === capacity) || null;
  const series = useMemo(
    () => (selected ? [...selected.retailSeries, ...selected.officialSeries] : []),
    [selected]
  );
  const chartData = useMemo(() => buildChartData(series, data?.rangeEnd), [data?.rangeEnd, series]);
  const hasHistory = series.some(item => item.points.length);
  const currentSummary = series.map(item => {
    const isRetail = item.key.startsWith('retail-');
    const official = isRetail
      ? officialSeriesForRetail(item, selected?.officialSeries || [])
      : null;
    const price = latestPrice(item);
    const officialPrice = official ? latestPrice(official) : null;
    return {
      ...item,
      price,
      delta: latestDelta(item),
      isRetail,
      premium: isRetail && price !== null && officialPrice !== null ? price - officialPrice : null,
    };
  });
  const retailChangeMoments = [
    ...new Set(
      selected?.retailSeries.flatMap(item =>
        item.points.filter(point => !point.baseline).map(point => point.changedAt)
      ) || []
    ),
  ].sort((left, right) => Date.parse(left) - Date.parse(right));
  const latestChangeAt = retailChangeMoments.at(-1) || null;
  const changeDays = new Set(
    retailChangeMoments.map(value =>
      new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
      })
        .format(new Date(value))
        .replaceAll('/', '-')
    )
  );
  const changeActivityLabel =
    retailChangeMoments.length && changeDays.size === 1
      ? `${[...changeDays][0]} · ${retailChangeMoments.length} 次变价`
      : `${retailChangeMoments.length} 次变价`;
  const rangeLabel = RANGES.find(item => item[0] === range)?.[1] || range;
  const summaryText = currentSummary
    .map(item => `${item.label}${formatPrice(item.price)}`)
    .join('，');
  const chartRange = data
    ? [Date.parse(data.rangeStart), Date.parse(data.rangeEnd)]
    : [Date.now() - 7 * 86400000, Date.now()];
  const tickTotal = compact ? 3 : 7;
  const xTicks = Array.from(
    { length: tickTotal },
    (_value, index) => chartRange[0] + ((chartRange[1] - chartRange[0]) * index) / (tickTotal - 1)
  );
  const tickFormatter = value =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: range === '24h' ? undefined : '2-digit',
      day: range === '24h' ? undefined : '2-digit',
      hour: range === '24h' ? '2-digit' : undefined,
      minute: range === '24h' ? '2-digit' : undefined,
      hourCycle: 'h23',
    }).format(new Date(value));

  return (
    <main className="duo-history-page">
      <div className="duo-history-shell">
        <section className="duo-history-panel" aria-labelledby="duo-history-chart-title">
          <header className="duo-history-header">
            <div>
              <h1>iPhone Duo 价格走势</h1>
              <p className="duo-history-subtitle">零售价、官网价与溢价，按真实变更时点记录</p>
            </div>
            <p className="duo-history-available">
              <span>数据自 {data ? formatDateTime(data.availableFrom) : '读取中'} 起</span>
              <span className="duo-history-available__update">
                更新于 {data ? formatDateTime(data.updatedAt) : '读取中'}
              </span>
            </p>
          </header>

          <div className="duo-history-controls">
            <fieldset className="duo-history-capacity-buttons">
              <legend>容量</legend>
              {CAPACITIES.map(value => (
                <button
                  key={value}
                  type="button"
                  className={capacity === value ? 'is-active' : ''}
                  aria-pressed={capacity === value}
                  onClick={() => setCapacity(value)}
                >
                  {formatCapacity(value)}
                </button>
              ))}
            </fieldset>
            <label className="duo-history-mobile-select">
              <span>容量</span>
              <select value={capacity} onChange={event => setCapacity(Number(event.target.value))}>
                {CAPACITIES.map(value => (
                  <option key={value} value={value}>
                    {formatCapacity(value)}
                  </option>
                ))}
              </select>
            </label>
            <div
              className="duo-history-range-select"
              onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) closeRangeMenu();
              }}
            >
              <span id="duo-history-range-label">时间范围</span>
              <div className="duo-history-range-select__control">
                <button
                  ref={rangeTriggerRef}
                  type="button"
                  className="duo-history-range-trigger"
                  aria-labelledby="duo-history-range-label duo-history-range-value"
                  aria-haspopup="listbox"
                  aria-expanded={rangeOpen}
                  aria-controls="duo-history-range-options"
                  onClick={() => (rangeOpen ? closeRangeMenu() : openRangeMenu())}
                  onKeyDown={handleRangeTriggerKeyDown}
                >
                  <span id="duo-history-range-value">{rangeLabel}</span>
                  <ChevronDown aria-hidden="true" />
                </button>
                {rangeOpen && (
                  <div
                    id="duo-history-range-options"
                    className="duo-history-range-options"
                    role="listbox"
                    aria-labelledby="duo-history-range-label"
                  >
                    {RANGES.map(([value, label], index) => {
                      const selectedRange = range === value;
                      return (
                        <button
                          ref={element => {
                            rangeOptionRefs.current[index] = element;
                          }}
                          key={value}
                          type="button"
                          role="option"
                          aria-selected={selectedRange}
                          className={selectedRange ? 'is-selected' : ''}
                          onClick={() => selectRange(value)}
                          onKeyDown={event => handleRangeOptionKeyDown(event, index)}
                        >
                          <span className="duo-history-range-options__indicator" aria-hidden="true">
                            {selectedRange && <Check />}
                          </span>
                          <span>{label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {data?.stale && (
            <p className="duo-history-notice" role="status">
              来源数据更新存在延迟，当前仍显示最近一次可用价格。
            </p>
          )}
          {error && (
            <div className="duo-history-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => load(range)}>
                重试
              </button>
            </div>
          )}

          {!data && loading ? (
            <div className="duo-history-skeleton" role="status" aria-label="正在加载价格走势">
              <span />
              <span />
              <span />
            </div>
          ) : (
            <div className="duo-history-workspace">
              <aside className="duo-history-summary" aria-label={`当前价格：${summaryText}`}>
                <div className="duo-history-summary__header">
                  <div>
                    <h2>当前报价</h2>
                    <p>
                      {formatCapacity(capacity)} · {rangeLabel}
                    </p>
                  </div>
                  <span>人民币</span>
                </div>
                <div className="duo-history-summary__list">
                  {currentSummary.map((item, index) => (
                    <div
                      className={`duo-history-quote${index === 0 ? ' is-lead' : ''}`}
                      key={item.key}
                    >
                      <div className="duo-history-quote__topline">
                        <span>
                          {item.label}
                          {item.isRetail && (
                            <small>（溢价 {formatSignedPrice(item.premium)}）</small>
                          )}
                        </span>
                        <i
                          className={item.key.startsWith('official') ? 'is-dashed' : ''}
                          style={{ '--line-color': LINE_STYLES[item.key]?.stroke }}
                        />
                      </div>
                      <strong>{formatPrice(item.price)}</strong>
                      <div className="duo-history-quote__meta">
                        <span>{formatDelta(item.delta)}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="duo-history-summary__formula">溢价 = 零售价 − 对应官网价</p>
              </aside>

              <div className="duo-history-main">
                <div className="duo-history-chart-heading">
                  <div>
                    <h2 id="duo-history-chart-title">{formatCapacity(capacity)} 价格轨迹</h2>
                    <p>{rangeLabel} · 北京时间</p>
                  </div>
                  <div className="duo-history-activity" aria-live="polite">
                    {loading ? (
                      <span className="duo-history-refreshing">正在刷新…</span>
                    ) : (
                      <>
                        <strong>{changeActivityLabel}</strong>
                        <span>
                          {latestChangeAt
                            ? `最近 ${
                                changeDays.size === 1
                                  ? formatTime(latestChangeAt)
                                  : formatCompactDateTime(latestChangeAt)
                              }`
                            : '本范围价格稳定'}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="duo-history-legend" aria-label="图例">
                  {series.map(item => (
                    <span key={item.key}>
                      <i
                        className={item.key.startsWith('official') ? 'is-dashed' : ''}
                        style={{ '--line-color': LINE_STYLES[item.key]?.stroke }}
                      />
                      {item.label}
                    </span>
                  ))}
                </div>

                <div
                  className="duo-history-chart"
                  data-ui
                  role="img"
                  aria-label={`${formatCapacity(capacity)}${rangeLabel}价格折线图。${summaryText}`}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={chartData}
                      margin={{
                        top: 18,
                        right: compact ? 18 : 22,
                        bottom: 4,
                        left: compact ? 0 : 4,
                      }}
                      accessibilityLayer
                    >
                      <CartesianGrid stroke="#e3e7ec" strokeDasharray="4 6" vertical={false} />
                      <XAxis
                        dataKey="time"
                        type="number"
                        scale="time"
                        domain={chartRange}
                        ticks={xTicks}
                        interval={0}
                        tickFormatter={tickFormatter}
                        stroke="#6b7280"
                        tickLine={false}
                        axisLine={false}
                        minTickGap={compact ? 24 : 48}
                        tick={{ fontSize: compact ? 11 : 13 }}
                      />
                      <YAxis
                        tickFormatter={value => `¥${Math.round(value).toLocaleString('zh-CN')}`}
                        stroke="#6b7280"
                        tickLine={false}
                        axisLine={false}
                        width={compact ? 70 : 82}
                        domain={['auto', 'auto']}
                        tick={{ fontSize: compact ? 11 : 13 }}
                      />
                      <Tooltip
                        content={<PriceTooltip />}
                        cursor={{ stroke: '#8d96a1', strokeDasharray: '4 5', strokeWidth: 1 }}
                        isAnimationActive={false}
                      />
                      {series.map(item => (
                        <Line
                          key={item.key}
                          type="linear"
                          dataKey={item.key}
                          name={item.label}
                          strokeWidth={item.key.startsWith('official') ? 1.8 : 2.4}
                          dot={
                            item.key.startsWith('official')
                              ? false
                              : props => (
                                  <ChangeDot
                                    {...props}
                                    seriesKey={item.key}
                                    stroke={LINE_STYLES[item.key]?.stroke}
                                  />
                                )
                          }
                          activeDot={{ r: 4, strokeWidth: 2, fill: '#ffffff' }}
                          connectNulls={false}
                          isAnimationActive={false}
                          {...LINE_STYLES[item.key]}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                  {!hasHistory && (
                    <p className="duo-history-empty">所选时间范围内暂无可展示的价格变更。</p>
                  )}
                </div>
                <p className="duo-history-caption">
                  折线连接相邻变价节点；只有节点代表实际变价时点，悬停或轻触可查看精确价格与溢价。
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
