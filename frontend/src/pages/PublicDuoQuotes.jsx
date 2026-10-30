import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPublicDuoQuotes } from '../api/quotePricingApi';
import './publicDuoQuotes.css';

const CAPACITIES = [256, 512, 1024, 2048];
const COLORS = ['夜空色', '星光白色'];
const isFilterSelected = (selected, value) =>
  value === null ? selected.length === 0 : selected.includes(value);
const toggleFilter = (selected, value) =>
  value === null
    ? []
    : selected.includes(value)
      ? selected.filter(item => item !== value)
      : [...selected, value];
const formatCapacity = value =>
  value >= 1024 ? `${value / 1024}TB` : `${value}G`;
const formatPrice = value =>
  value === null || value === undefined
    ? '—'
    : `¥${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)}`;
const formatPremium = value =>
  value === null || value === undefined
    ? '—'
    : `${value > 0 ? '+' : ''}${value}`;
const formatTime = value => {
  if (!value) return '—';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`;
};

/** 全国渠道八款 iPhone Duo 零售报价表。 */
export default function PublicDuoQuotes() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedCapacities, setSelectedCapacities] = useState([]);
  const [selectedColors, setSelectedColors] = useState([]);
  const pending = useRef(null);
  const queued = useRef(false);
  const active = useRef(false);
  const lifecycle = useRef(0);
  const targetVersion = useRef(null);
  const acceptedVersion = useRef(null);
  const retryTimer = useRef(null);
  const retryDelay = useRef(1000);

  const load = useCallback(async () => {
    const generation = lifecycle.current;
    if (!active.current) return;
    if (pending.current || retryTimer.current !== null) {
      queued.current = true;
      return;
    }
    setLoading(true);
    let attempts = 0;
    do {
      attempts += 1;
      queued.current = false;
      const controller = new AbortController();
      pending.current = controller;
      try {
        const result = await getPublicDuoQuotes(controller.signal);
        if (
          active.current &&
          generation === lifecycle.current &&
          !controller.signal.aborted
        ) {
          const version =
            Number.isSafeInteger(result.version) && result.version >= 0
              ? result.version
              : null;
          if (
            queued.current ||
            (version !== null &&
              targetVersion.current !== null &&
              version < targetVersion.current)
          ) {
            // 在途请求被更新通知取代时，丢弃旧结果并串行补读一次。
            queued.current = true;
          } else {
            retryDelay.current = 1000;
            acceptedVersion.current = version;
            if (version !== null)
              targetVersion.current = Math.max(
                targetVersion.current ?? -1,
                version
              );
            setData(result);
            setError('');
          }
        }
      } catch (failure) {
        if (
          active.current &&
          generation === lifecycle.current &&
          !controller.signal.aborted &&
          !queued.current
        ) {
          setData(null);
          setError(failure.message || '报价暂时不可用，请稍后再试');
        }
      } finally {
        if (pending.current === controller) pending.current = null;
      }
      if (
        active.current &&
        generation === lifecycle.current &&
        queued.current &&
        attempts >= 2
      ) {
        const delay = retryDelay.current;
        retryDelay.current = Math.min(delay * 2, 30_000);
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          if (active.current && generation === lifecycle.current) load();
        }, delay);
        break;
      }
    } while (
      active.current &&
      generation === lifecycle.current &&
      queued.current
    );
    if (
      active.current &&
      generation === lifecycle.current &&
      retryTimer.current === null
    )
      setLoading(false);
  }, []);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'iPhone Duo 报价表';
    active.current = true;
    lifecycle.current += 1;
    const generation = lifecycle.current;
    targetVersion.current = null;
    acceptedVersion.current = null;
    retryDelay.current = 1000;
    queued.current = false;
    load();
    const timer = setInterval(load, 60_000);
    let stream = null;
    let hasOpened = false;
    let hadConnectionError = false;
    let streamRetryTimer = null;
    let streamRetryDelay = 1000;
    let streamCleanup = null;
    const isCurrent = () => active.current && generation === lifecycle.current;
    const onVersion = event => {
      if (!isCurrent()) return;
      let version;
      try {
        version = JSON.parse(event.data)?.version;
      } catch (_error) {
        return;
      }
      if (
        !Number.isSafeInteger(version) ||
        version < 0 ||
        version <=
          Math.max(targetVersion.current ?? -1, acceptedVersion.current ?? -1)
      )
        return;
      const previouslyNotified =
        targetVersion.current !== null || acceptedVersion.current !== null;
      targetVersion.current = version;
      // 首次握手与首个 GET 共用版本核对；后续新通知必须保留补读意图。
      if (pending.current && !previouslyNotified) return;
      load();
    };
    function closeStream() {
      streamCleanup?.();
      streamCleanup = null;
      stream?.close();
      stream = null;
    }
    function scheduleStreamRetry() {
      if (
        !isCurrent() ||
        typeof window.EventSource !== 'function' ||
        streamRetryTimer !== null
      )
        return;
      const delay = Math.min(
        30_000,
        streamRetryDelay * (0.9 + Math.random() * 0.2)
      );
      streamRetryDelay = Math.min(streamRetryDelay * 2, 30_000);
      streamRetryTimer = setTimeout(() => {
        streamRetryTimer = null;
        if (isCurrent()) connectStream();
      }, delay);
    }
    function connectStream() {
      if (
        !isCurrent() ||
        typeof window.EventSource !== 'function' ||
        (stream && stream.readyState !== 2)
      )
        return;
      closeStream();
      try {
        const connection = new window.EventSource(
          '/api/public/duo-quotes/events'
        );
        stream = connection;
        const isLive = () => isCurrent() && stream === connection;
        const onVersionForStream = event => {
          if (isLive()) onVersion(event);
        };
        const onOpen = () => {
          if (!isLive()) return;
          clearTimeout(streamRetryTimer);
          streamRetryTimer = null;
          streamRetryDelay = 1000;
          if (hasOpened || hadConnectionError) load();
          hasOpened = true;
          hadConnectionError = false;
        };
        const onStreamError = () => {
          if (!isLive()) return;
          hadConnectionError = true;
          // CONNECTING 交给浏览器原生重连；CLOSED 必须受控重建实例。
          if (connection.readyState === 2) {
            closeStream();
            scheduleStreamRetry();
          }
        };
        connection.addEventListener('quote-version', onVersionForStream);
        connection.addEventListener('open', onOpen);
        connection.addEventListener('error', onStreamError);
        streamCleanup = () => {
          connection.removeEventListener('quote-version', onVersionForStream);
          connection.removeEventListener('open', onOpen);
          connection.removeEventListener('error', onStreamError);
        };
      } catch (_error) {
        hadConnectionError = true;
        closeStream();
        scheduleStreamRetry();
      }
    }
    const recoverStream = () => {
      if (!stream || stream.readyState === 2) scheduleStreamRetry();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && isCurrent()) {
        load();
        recoverStream();
      }
    };
    const onFocus = () => {
      if (isCurrent()) {
        load();
        recoverStream();
      }
    };
    const onPageShow = event => {
      if (event.persisted && isCurrent()) {
        load();
        recoverStream();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageShow);
    connectStream();
    return () => {
      active.current = false;
      lifecycle.current += 1;
      clearInterval(timer);
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
      clearTimeout(streamRetryTimer);
      streamRetryTimer = null;
      closeStream();
      pending.current?.abort();
      pending.current = null;
      queued.current = false;
      document.title = previousTitle;
    };
  }, [load]);

  const items = useMemo(
    () =>
      (data?.items || [])
        .filter(
          item =>
            (selectedCapacities.length === 0 ||
              selectedCapacities.includes(item.storageGb)) &&
            (selectedColors.length === 0 || selectedColors.includes(item.color))
        )
        .sort(
          (left, right) =>
            left.storageGb - right.storageGb ||
            COLORS.indexOf(left.color) - COLORS.indexOf(right.color)
        ),
    [data, selectedCapacities, selectedColors]
  );

  return (
    <div className="duo-quote-page">
      <main className="duo-quote-main">
        <header className="duo-quote-heading">
          <h1>iPhone Duo 报价表</h1>
          <p className="duo-quote-updated">
            <span>报价更新时间： 苹果全国手机</span>
            <time dateTime={data?.updatedAt || undefined}>
              {formatTime(data?.updatedAt)}
            </time>
          </p>
        </header>
        <section aria-label="报价筛选" className="duo-quote-filters">
          <div className="duo-filter-row" role="group" aria-label="容量">
            <span className="duo-filter-label">容量</span>
            <div className="duo-filter-options">
              {[null, ...CAPACITIES].map(value => (
                <button
                  key={value ?? 'all'}
                  type="button"
                  aria-pressed={isFilterSelected(selectedCapacities, value)}
                  className={`btn ${isFilterSelected(selectedCapacities, value) ? 'btn-primary' : 'btn-secondary'} duo-filter-option`}
                  onClick={() =>
                    setSelectedCapacities(selected =>
                      toggleFilter(selected, value)
                    )
                  }
                >
                  {value === null ? '全部' : formatCapacity(value)}
                </button>
              ))}
            </div>
          </div>
          <div className="duo-filter-row" role="group" aria-label="颜色">
            <span className="duo-filter-label">颜色</span>
            <div className="duo-filter-options">
              {[null, ...COLORS].map(value => (
                <button
                  key={value ?? 'all'}
                  type="button"
                  aria-pressed={isFilterSelected(selectedColors, value)}
                  className={`btn ${isFilterSelected(selectedColors, value) ? 'btn-primary' : 'btn-secondary'} duo-filter-option`}
                  onClick={() =>
                    setSelectedColors(selected => toggleFilter(selected, value))
                  }
                >
                  {value ?? '全部'}
                </button>
              ))}
            </div>
          </div>
        </section>
        {data?.stale && (
          <p role="alert" className="duo-quote-status">
            报价更新延迟
          </p>
        )}
        {error && (
          <p role="alert" className="duo-quote-status duo-quote-error">
            {error}
          </p>
        )}
        <section
          aria-label="Duo报价列表"
          aria-busy={loading}
          className="duo-quote-table-wrap"
        >
          <table className="duo-quote-table">
            <colgroup>
              <col />
              <col />
              <col />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">容量</th>
                <th scope="col">颜色</th>
                <th scope="col">零售价</th>
                <th scope="col">官网价</th>
                <th scope="col">溢价额</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.productKey}>
                  <td className="duo-capacity">
                    {formatCapacity(item.storageGb)}
                  </td>
                  <td>
                    <span className="duo-color">
                      <span
                        aria-hidden="true"
                        className={`duo-color-swatch ${item.color === '星光白色' ? 'duo-color-starlight' : 'duo-color-midnight'}`}
                      />
                      <span>{item.color}</span>
                    </span>
                  </td>
                  <td className="duo-retail">
                    {formatPrice(item.retailPrice)}
                  </td>
                  <td className="duo-official">
                    {formatPrice(item.officialPrice)}
                  </td>
                  <td
                    className={`duo-premium ${item.premiumAmount < 0 ? 'duo-premium-negative' : ''}`}
                  >
                    {formatPremium(item.premiumAmount)}
                  </td>
                </tr>
              ))}
              {!items.length && (
                <tr>
                  <td colSpan={5} className="duo-empty" role="status">
                    {loading
                      ? '正在加载报价…'
                      : error
                        ? '报价暂不可用'
                        : data?.items?.length
                          ? '暂无符合条件的报价'
                          : '暂无报价'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}
