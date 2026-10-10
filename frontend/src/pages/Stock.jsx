import TagMultiSelect from '../components/TagMultiSelect';
import TableHeaderHint from '../components/TableHeaderHint';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, PackageCheck, Package, Plus, RefreshCw, Settings } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import {
  StockBadge,
  StockFeedback,
  StockModal,
  StockPager,
  StockTable,
} from '../components/stock/StockCommon';
import { useStockData } from '../components/stock/stockHooks';
import { moneyText, productLabel } from '../components/stock/stockHelpers';
import { ledgerCan, LEDGER_PAYMENT_LABELS } from '../components/stock/ledgerHelpers';
import LedgerEntryForm from '../components/stock/ledgerEntryForm';
import LedgerSaleForm from '../components/stock/ledgerSaleForm';
import LedgerDispatchForm from '../components/stock/ledgerDispatchForm';
import LedgerPaymentForm from '../components/stock/ledgerPaymentForm';
import LedgerDetail from '../components/stock/ledgerDetail';
import LedgerWarehouses from '../components/stock/ledgerWarehouses';

const EMPTY_CATALOG = { products: [], warehouses: [], people: [] };
const INITIAL_FILTERS = {
  q: '',
  modelNames: [],
  storageGbs: [],
  colorNames: [],
  warehouseId: '',
  salespersonName: '',
  paymentStatus: '',
  soldFrom: '',
  soldTo: '',
};

/** 台账备注单行省略，悬停、聚焦或点击可读取完整内容。 */
function StockNote({ notes }) {
  if (!notes) return '—';
  return (
    <TableHeaderHint
      label={`备注：${notes}`}
      trigger={<span className="block truncate">{notes}</span>}
      triggerClassName="max-w-full w-[240px] text-left align-top !text-inherit"
    >
      <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{notes}</span>
    </TableHeaderHint>
  );
}

/** 一个台账完成自有设备入库、售出、货款及历史补录。 */
export default function Stock() {
  const { can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = ['in_stock', 'sold', 'all'].includes(searchParams.get('view'))
    ? searchParams.get('view')
    : 'in_stock';
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [isComposing, setIsComposing] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selected, setSelected] = useState([]);
  const [showSelected, setShowSelected] = useState(false);
  const [action, setAction] = useState(null);
  const [detail, setDetail] = useState(null);
  const [notice, setNotice] = useState('');
  const [initialSerials, setInitialSerials] = useState([]);
  const catalogResource = useStockData('/ledger/catalog');
  const catalog = catalogResource.data || EMPTY_CATALOG;
  const writesDisabled = catalogResource.loading || catalog.enabled === false;
  const resource = useStockData('/ledger', { ...filters, view: tab, page, pageSize });
  const items = resource.data?.items || [];
  useEffect(() => {
    if (isComposing || query.trim() === filters.q) return undefined;
    const timer = window.setTimeout(() => {
      setFilters(previous => ({ ...previous, q: query.trim() }));
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, isComposing, filters.q]);
  const salePermission = can('stock.sales.edit') && can('stock.sales.ship');
  useEffect(() => {
    const sn = searchParams.get('receiveSn');
    if (sn && can('stock.receive')) {
      setInitialSerials(sn.split(',').filter(Boolean));
      setAction({ type: 'receive' });
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams, can]);
  const reload = () => {
    resource.reload();
    catalogResource.reload();
  };
  const done = result => {
    setNotice(`已保存 ${result?.items?.length || 1} 台，列表已刷新。`);
    setAction(null);
    setSelected([]);
    reload();
  };
  const changeFilter = (key, value) => {
    setFilters(previous => ({ ...previous, [key]: value }));
    setPage(1);
  };
  const changeTab = view => {
    setSearchParams(view === 'in_stock' ? {} : { view });
    setPage(1);
    setSelected([]);
    setNotice('');
    setFilters(previous => ({
      ...previous,
      paymentStatus: '',
      salespersonName: '',
      soldFrom: '',
      soldTo: '',
    }));
  };
  const toggle = unit =>
    setSelected(previous =>
      previous.some(item => item.id === unit.id)
        ? previous.filter(item => item.id !== unit.id)
        : [...previous, unit].slice(0, 100)
    );
  const selectable = unit =>
    !writesDisabled && (ledgerCan(unit, 'sell') || ledgerCan(unit, 'payment'));
  const selectableItems = items.filter(selectable);
  const allSelected =
    selectableItems.length > 0 &&
    selectableItems.every(unit => selected.some(item => item.id === unit.id));
  const selectPage = () =>
    setSelected(previous =>
      allSelected
        ? previous.filter(unit => !selectableItems.some(item => item.id === unit.id))
        : [
            ...previous,
            ...selectableItems.filter(unit => !previous.some(item => item.id === unit.id)),
          ].slice(0, 100)
    );
  const allSell = selected.length > 0 && selected.every(unit => ledgerCan(unit, 'sell'));
  const allPayment = selected.length > 0 && selected.every(unit => ledgerCan(unit, 'payment'));
  const mobileSummary = unit =>
    unit.state === 'sold' ? (
      <>
        <div>{unit.soldOn || '日期待补'}</div>
        {can('stock.sales.read') && (
          <div className="font-medium text-gray-900">售价 {moneyText(unit.saleAmount)}</div>
        )}
        {can('stock.sales.read') && (
          <div className="mt-1 text-xs text-gray-500">
            结算 {unit.settlementAmount == null ? '待补' : moneyText(unit.settlementAmount)}
          </div>
        )}
        {can('stock.profit.read') && (
          <div className="mt-1 text-xs text-gray-500">
            毛利{' '}
            {unit.grossProfit == null
              ? unit.settlementAmount == null
                ? '待补结算'
                : '待补官网售价'
              : moneyText(unit.grossProfit)}
          </div>
        )}
        {unit.paymentStatus && (
          <div className="mt-1 text-xs text-gray-500">
            {LEDGER_PAYMENT_LABELS[unit.paymentStatus]}
          </div>
        )}
      </>
    ) : (
      <StockBadge value={unit.state} />
    );
  const columns = [
    {
      key: 'check',
      title: (
        <input
          aria-label="选择本页可操作设备"
          type="checkbox"
          className="h-5 w-5"
          checked={allSelected}
          onChange={selectPage}
          disabled={!selectableItems.length}
        />
      ),
      className: 'w-9',
      render: unit => (
        <input
          aria-label={`选择 ${unit.serialNumber}`}
          type="checkbox"
          className="h-5 w-5"
          checked={selected.some(item => item.id === unit.id)}
          onChange={() => toggle(unit)}
          disabled={!selectable(unit)}
        />
      ),
    },
    {
      key: 'deviceNumber',
      title: 'ID',
      mobileHidden: true,
      render: unit => <span className="font-mono">{unit.deviceNumber}</span>,
    },
    {
      key: 'device',
      title: '设备',
      className: 'ledger-device-cell',
      render: unit => (
        <>
          <button
            className="min-h-[44px] break-all text-left font-mono font-medium text-primary underline"
            onClick={() => setDetail({ id: unit.id })}
          >
            {unit.serialNumber}
          </button>
          <div className="text-xs leading-5 text-gray-500 sm:hidden">
            {productLabel(unit.product)}
            <div className="font-mono">ID：{unit.deviceNumber}</div>
          </div>
          <div className="hidden text-xs text-gray-500 sm:block">
            订单：{unit.orderNumber || (unit.orderLinked ? '已关联' : '待补')}
          </div>
          {tab === 'all' && (
            <div className="mt-1">
              <StockBadge value={unit.state} />
            </div>
          )}
          {unit.notes && (
            <div className="mt-1 min-w-0 text-xs text-gray-500 sm:hidden">
              <StockNote notes={unit.notes} />
            </div>
          )}
          <div className="mt-2 space-y-2 sm:hidden">
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
              <span>仓库：{unit.warehouse?.name || unit.sourceWarehouse?.name || '待补'}</span>
              <span>入库：{unit.receivedOn || '待补'}</span>
            </div>
            {unit.state === 'sold' && <div className="text-sm">{mobileSummary(unit)}</div>}
            <div className="flex flex-wrap gap-2">
              {ledgerCan(unit, 'sell') && (
                <button
                  className="btn btn-primary"
                  disabled={writesDisabled}
                  onClick={() => setAction({ type: 'sell', units: [unit] })}
                >
                  售出
                </button>
              )}
              {ledgerCan(unit, 'payment') && (
                <button
                  className="btn btn-primary"
                  disabled={writesDisabled}
                  onClick={() => setAction({ type: 'payment', units: [unit] })}
                >
                  更新货款
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => setDetail({ id: unit.id })}>
                {ledgerCan(unit, 'edit') ? '查看 / 编辑' : '查看详情'}
              </button>
            </div>
          </div>
          {unit.isHistorical && (
            <span className="mt-1 inline-block text-xs text-gray-500">历史补录</span>
          )}
        </>
      ),
    },
    {
      key: 'product',
      title: '型号 / 容量 / 颜色',
      mobileHidden: true,
      render: unit => productLabel(unit.product),
    },
    {
      key: 'warehouse',
      title: '仓库',
      mobileHidden: true,
      className: 'ledger-summary-cell',
      render: unit => unit.warehouse?.name || unit.sourceWarehouse?.name || '仓库待补',
    },
    {
      key: 'receivedOn',
      title: '入库日期',
      mobileHidden: true,
      className: 'whitespace-nowrap',
      render: unit => unit.receivedOn || '日期待补',
    },
    ...(tab !== 'in_stock'
      ? [
          {
            key: 'place',
            title: '销售 / 货款',
            mobileHidden: true,
            className: 'ledger-summary-cell',
            render: mobileSummary,
          },
        ]
      : []),
    ...(tab !== 'in_stock' && can('stock.sales.read')
      ? [
          {
            key: 'people',
            title: '销售人 / 出货人',
            mobileHidden: true,
            render: unit =>
              unit.state === 'sold' ? (
                <>
                  <div>{unit.salespersonName || '销售人待补'}</div>
                  <div className="mt-1 text-xs text-gray-500">
                    出货：{unit.handlerName || '待补'}
                  </div>
                </>
              ) : (
                '—'
              ),
          },
        ]
      : []),
    {
      key: 'notes',
      title: '备注',
      mobileHidden: true,
      render: unit => (
        <StockNote notes={unit.notes} />
      ),
    },
    {
      key: 'actions',
      title: '操作',
      mobileHidden: true,
      render: unit => (
        <div className="flex flex-wrap gap-2">
          {ledgerCan(unit, 'sell') && (
            <button
              className="btn btn-primary"
              disabled={writesDisabled}
              onClick={() => setAction({ type: 'sell', units: [unit] })}
            >
              售出
            </button>
          )}
          {ledgerCan(unit, 'payment') && (
            <button
              className="btn btn-primary"
              disabled={writesDisabled}
              onClick={() => setAction({ type: 'payment', units: [unit] })}
            >
              更新货款
            </button>
          )}
          {ledgerCan(unit, 'edit') && (
            <button
              className="btn btn-secondary"
              disabled={writesDisabled}
              onClick={() => setDetail({ id: unit.id })}
            >
              编辑
            </button>
          )}
          {!unit.allowedActions?.length && <span className="text-xs text-gray-500">查看详情</span>}
        </div>
      ),
    },
  ];
  return (
    <div
      className={`stock-page ledger-page space-y-4 ${selected.length ? 'ledger-has-selection' : ''}`}
    >
      <header className="ledger-header flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <Package className="h-6 w-6" />
            自有库存
          </h1>
          <p className="mt-1 text-sm text-gray-500">一台一条记录，管理在库、销售与货款。</p>
        </div>
        <div className="stock-toolbar">
          {can('stock.receive') && (
            <button
              className="btn btn-primary"
              disabled={writesDisabled}
              onClick={() => {
                setInitialSerials([]);
                setAction({ type: 'receive' });
              }}
            >
              <Plus className="h-4 w-4" />
              入库登记
            </button>
          )}
          {salePermission && (
            <button
              className="btn btn-secondary"
              disabled={writesDisabled}
              onClick={() => setAction({ type: 'dispatch' })}
            >
              <PackageCheck className="h-4 w-4" />
              出库登记
            </button>
          )}
          {(can('stock.catalog.manage') || can('stock.settings.manage')) && (
            <button
              className="btn btn-secondary"
              aria-label="基础设置"
              title="基础设置"
              onClick={() => setAction({ type: 'warehouses' })}
            >
              <Settings className="h-4 w-4" />
              <span className="hidden sm:inline">基础设置</span>
            </button>
          )}
        </div>
      </header>
      {notice && (
        <p
          role="status"
          className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800"
        >
          {notice}
        </p>
      )}
      {catalog.enabled === false && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          自有库存尚未启用，现有记录仍可查询。请由管理员在基础设置中启用后录入。
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="库存视图" className="stock-view-tabs">
          {[
            ['in_stock', '在库', resource.data?.counts?.inStock],
            ['sold', '已售', resource.data?.counts?.sold],
            ['all', '全部'],
          ].map(([view, label, count]) => (
            <button
              key={view}
              role="tab"
              aria-selected={tab === view}
              className="btn stock-view-tab"
              onClick={() => changeTab(view)}
            >
              <span>{label}</span>
              {count !== undefined && <span className="stock-view-count">{count}</span>}
            </button>
          ))}
        </div>
        <button className="btn btn-secondary" onClick={reload} aria-label="刷新台账">
          <RefreshCw className="h-4 w-4" />
          <span className="hidden sm:inline">刷新</span>
        </button>
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
        <input
          aria-label="搜索 SN、订单号或备注"
          className="input w-full pl-10"
          placeholder="搜索 SN、订单号或备注"
          maxLength={100}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={event => {
            setIsComposing(false);
            setQuery(event.currentTarget.value);
          }}
        />
      </div>
      <div className="ledger-filters grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap">
        <label className="min-w-0 text-sm sm:min-w-[180px]">
          仓库
          <select
            aria-label="按仓库筛选"
            className="input mt-1 w-full"
            value={filters.warehouseId}
            onChange={event => changeFilter('warehouseId', event.target.value)}
          >
            <option value="">全部仓库</option>
            {catalog.warehouses.map(warehouse => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name}
              </option>
            ))}
          </select>
        </label>
        {[
          ['modelNames', '机型', '全部机型'],
          ['storageGbs', '容量', '全部容量'],
          ['colorNames', '颜色', '全部颜色'],
        ].map(([key, label, placeholder]) => (
          <div key={key} className="min-w-0 w-full text-sm sm:w-48">
            <div className="mb-1">{label}</div>
            <TagMultiSelect
              options={(catalog.filterOptions?.[key] || []).map(String)}
              value={filters[key].map(String)}
              onChange={values =>
                changeFilter(key, key === 'storageGbs' ? values.map(Number) : values)
              }
              ariaLabel={`按${label}筛选`}
              placeholder={placeholder}
              itemLabel={label}
              compareOptions={key === 'storageGbs' ? (a, b) => Number(a) - Number(b) : undefined}
              optionLabels={
                key === 'storageGbs'
                  ? Object.fromEntries(
                      [...(catalog.filterOptions?.storageGbs || []), ...filters.storageGbs].map(
                        value => [
                          String(value),
                          value >= 1024 && value % 1024 === 0 ? `${value / 1024}TB` : `${value}GB`,
                        ]
                      )
                    )
                  : undefined
              }
            />
          </div>
        ))}
        <button
          className="btn btn-secondary"
          onClick={() => {
            setFilters(INITIAL_FILTERS);
            setQuery('');
            setPage(1);
          }}
        >
          重置筛选
        </button>
      </div>
      {tab !== 'in_stock' && (
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-gray-200 bg-white p-3 lg:grid-cols-3">
          <label className="min-w-0 text-sm">
            销售人
            <input
              className="input mt-1 w-full"
              value={filters.salespersonName}
              onChange={event => changeFilter('salespersonName', event.target.value)}
              placeholder="销售人姓名"
            />
          </label>
          {can('stock.collections.read') && (
            <label className="min-w-0 text-sm">
              货款状况
              <select
                className="input mt-1 w-full"
                value={filters.paymentStatus}
                onChange={event => changeFilter('paymentStatus', event.target.value)}
              >
                <option value="">全部货款状态</option>
                {Object.entries(LEDGER_PAYMENT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="min-w-0 text-sm">
            销售日期起
            <input
              className="input mt-1 w-full"
              type="date"
              value={filters.soldFrom}
              onChange={event => changeFilter('soldFrom', event.target.value)}
            />
          </label>
          <label className="min-w-0 text-sm">
            销售日期止
            <input
              className="input mt-1 w-full"
              type="date"
              value={filters.soldTo}
              onChange={event => changeFilter('soldTo', event.target.value)}
            />
          </label>
        </div>
      )}
      {selected.length > 0 && (
        <div className="ledger-selection stock-toolbar rounded-lg border border-blue-100 bg-primary-50 p-3">
          <span className="text-sm text-primary">已选 {selected.length} 台（最多 100 台）</span>
          <button className="btn btn-secondary" onClick={() => setShowSelected(true)}>
            查看已选
          </button>
          <span className="hidden text-xs text-gray-500 sm:inline">
            搜索、筛选和翻页保留已选记录
          </span>
          {allSell && (
            <button
              className="btn btn-primary"
              disabled={writesDisabled}
              onClick={() => setAction({ type: 'sell', units: selected })}
            >
              登记售出
            </button>
          )}
          {allPayment && (
            <button
              className="btn btn-primary"
              disabled={writesDisabled}
              onClick={() => setAction({ type: 'payment', units: selected })}
            >
              更新货款
            </button>
          )}
          {!allSell && !allPayment && (
            <span className="text-sm text-gray-500">请分别选择在库或已售机器操作</span>
          )}
          <button className="btn btn-secondary" onClick={() => setSelected([])}>
            取消选择
          </button>
        </div>
      )}
      <StockFeedback
        loading={resource.loading}
        error={resource.error || catalogResource.error}
        onRetry={reload}
      />
      {!resource.loading && !resource.error && (
        <StockTable
          tableClassName="ledger-main-table"
          columns={columns}
          items={items}
          onRow={unit => setDetail({ id: unit.id })}
          empty={
            Object.values(filters).some(Boolean)
              ? '没有符合条件的设备，请调整搜索或筛选'
              : tab === 'in_stock'
                ? '还没有在库设备，可点击“入库登记”开始'
                : '还没有销售记录，可从在库登记售出或使用出库登记'
          }
        />
      )}
      <StockPager
        page={page}
        pageSize={pageSize}
        total={resource.data?.total}
        onPage={setPage}
        onSize={size => {
          setPageSize(size);
          setPage(1);
        }}
      />
      {showSelected && (
        <StockModal
          title={`已选设备 · ${selected.length} 台`}
          onClose={() => setShowSelected(false)}
        >
          <StockTable
            items={selected}
            columns={[
              { key: 'serialNumber', title: 'SN' },
              {
                key: 'warehouse',
                title: '仓库',
                render: unit => unit.warehouse?.name || unit.sourceWarehouse?.name || '—',
              },
              {
                key: 'remove',
                title: '操作',
                render: unit => (
                  <button
                    className="btn btn-secondary"
                    aria-label={`移除 ${unit.serialNumber}`}
                    onClick={() => toggle(unit)}
                  >
                    移除
                  </button>
                ),
              },
            ]}
          />
        </StockModal>
      )}
      {action?.type === 'receive' && (
        <LedgerEntryForm
          catalog={catalog}
          initialSerials={initialSerials}
          onExisting={id => setDetail({ id })}
          onClose={() => setAction(null)}
          onSaved={done}
        />
      )}
      {action?.type === 'dispatch' && (
        <LedgerDispatchForm catalog={catalog} onClose={() => setAction(null)} onSaved={done} />
      )}
      {action?.type === 'sell' && (
        <LedgerSaleForm
          units={action.units}
          catalog={catalog}
          onClose={() => setAction(null)}
          onSaved={done}
        />
      )}
      {action?.type === 'payment' && (
        <LedgerPaymentForm
          units={action.units}
          catalog={catalog}
          onClose={() => setAction(null)}
          onSaved={done}
        />
      )}
      {action?.type === 'warehouses' && (
        <LedgerWarehouses catalog={catalog} onClose={() => setAction(null)} onSaved={reload} />
      )}
      {detail && (
        <LedgerDetail
          key={detail.id}
          id={detail.id}
          catalog={catalog}
          onClose={() => setDetail(null)}
          onSaved={() => {
            setNotice('设备资料已保存，列表已刷新。');
            setSelected([]);
            reload();
          }}
        />
      )}
    </div>
  );
}
