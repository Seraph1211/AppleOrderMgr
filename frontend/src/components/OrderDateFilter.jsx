/** 四个订单及付款列表统一使用北京时间的下单日期范围。 */
export default function OrderDateFilter({ dateFrom = '', dateTo = '', onChange }) {
  return (
    <div className="col-span-full grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap">
      <span className="col-span-full text-sm text-gray-500 self-center">下单日期（北京时间）</span>
      <label className="min-w-0">
        <span className="block text-xs text-gray-500 mb-1">开始日期</span>
        <input
          type="date"
          className="input w-full sm:w-44"
          aria-label="下单开始日期"
          value={dateFrom}
          max={dateTo || undefined}
          onChange={event => onChange({ dateFrom: event.target.value, dateTo })}
        />
      </label>
      <label className="min-w-0">
        <span className="block text-xs text-gray-500 mb-1">结束日期（含当天）</span>
        <input
          type="date"
          className="input w-full sm:w-44"
          aria-label="下单结束日期"
          value={dateTo}
          min={dateFrom || undefined}
          onChange={event => onChange({ dateFrom, dateTo: event.target.value })}
        />
      </label>
      {(dateFrom || dateTo) && (
        <button
          type="button"
          className="btn btn-secondary col-span-full justify-self-start"
          onClick={() => onChange({ dateFrom: '', dateTo: '' })}
        >
          清空日期
        </button>
      )}
      {dateFrom && dateTo && dateFrom > dateTo && (
        <p role="alert" className="col-span-full w-full text-sm text-red-600">
          开始日期不能晚于结束日期
        </p>
      )}
    </div>
  );
}
