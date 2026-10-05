import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Filter, History, Package, Plus, RefreshCw, Settings } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { StockBadge, StockFeedback, StockPager, StockTable } from '../components/stock/StockCommon';
import { useStockData } from '../components/stock/stockHooks';
import { moneyText, productLabel } from '../components/stock/stockHelpers';
import { ledgerCan, LEDGER_PAYMENT_LABELS } from '../components/stock/ledgerHelpers';
import LedgerEntryForm from '../components/stock/ledgerEntryForm';
import LedgerSaleForm from '../components/stock/ledgerSaleForm';
import LedgerPaymentForm from '../components/stock/ledgerPaymentForm';
import LedgerDetail from '../components/stock/ledgerDetail';
import LedgerWarehouses from '../components/stock/ledgerWarehouses';

const EMPTY_CATALOG = { products: [], warehouses: [], people: [] };
const INITIAL_FILTERS = {
  q: '',
  productId: '',
  warehouseId: '',
  salespersonName: '',
  paymentStatus: '',
  soldFrom: '',
  soldTo: '',
};

/** 一个台账完成自有设备入库、售出、货款及历史补录。 */
export default function Stock() {
  const { can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = ['in_stock', 'sold', 'all'].includes(searchParams.get('view'))
    ? searchParams.get('view')
    : 'in_stock';
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selected, setSelected] = useState([]);
  const [action, setAction] = useState(null);
  const [detail, setDetail] = useState(null);
  const [notice, setNotice] = useState('');
  const [initialSerials, setInitialSerials] = useState([]);
  const catalogResource = useStockData('/ledger/catalog');
  const catalog = catalogResource.data || EMPTY_CATALOG;
  const writesDisabled = catalogResource.loading || catalog.enabled === false;
  const resource = useStockData('/ledger', { ...filters, view: tab, page, pageSize });
  const items = resource.data?.items || [];
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
    setSelected([]);
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
          <div className="font-medium text-gray-900">{moneyText(unit.saleAmount)}</div>
        )}
        {unit.paymentStatus && (
          <div className="mt-1 text-xs text-gray-500">
            {LEDGER_PAYMENT_LABELS[unit.paymentStatus]}
          </div>
        )}
      </>
    ) : (
      <>
        <div>{unit.warehouse?.name || '仓库待补'}</div>
        <div className="mt-1 text-xs text-gray-500">{unit.receivedOn || '日期待补'}</div>
      </>
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
          </div>
          <div className="hidden text-xs text-gray-500 sm:block">
            订单：{unit.orderNumber || (unit.orderLinked ? '已关联' : '待补')}
          </div>
          {tab === 'all' && (
            <div className="mt-1">
              <StockBadge value={unit.state} />
            </div>
          )}
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
      key: 'place',
      title: tab === 'in_stock' ? '仓库 / 入库日期' : tab === 'sold' ? '销售 / 货款' : '当前情况',
      className: 'ledger-summary-cell',
      render: mobileSummary,
    },
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
    <div className="stock-page ledger-page space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
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
          {can('stock.import') && salePermission && (
            <button
              className="btn btn-secondary"
              disabled={writesDisabled}
              onClick={() => setAction({ type: 'history' })}
            >
              <History className="h-4 w-4" />
              补录历史销售
            </button>
          )}
          {(can('stock.catalog.manage') || can('stock.settings.manage')) && (
            <button
              className="btn btn-secondary"
              aria-label="仓库设置"
              title="仓库设置"
              onClick={() => setAction({ type: 'warehouses' })}
            >
              <Settings className="h-4 w-4" />
              <span className="hidden sm:inline">仓库设置</span>
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
          自有库存尚未启用，现有记录仍可查询。请由管理员在仓库设置中启用后录入。
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
      <form
        className="stock-toolbar"
        onSubmit={event => {
          event.preventDefault();
          changeFilter('q', query.trim());
        }}
      >
        <input
          aria-label="搜索 SN 或订单号"
          className="input min-w-0 flex-1"
          placeholder="搜索 SN 或订单号"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <button type="submit" className="btn btn-primary">
          查询
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          <Filter className="h-4 w-4" />
          筛选
        </button>
      </form>
      <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm sm:min-w-[180px]">
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
        {filters.warehouseId && (
          <button className="btn btn-secondary" onClick={() => changeFilter('warehouseId', '')}>
            清除仓库筛选
          </button>
        )}
      </div>
      {filtersOpen && (
        <div className="grid grid-cols-1 gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-sm">
            手机规格
            <select
              className="input mt-1 w-full"
              value={filters.productId}
              onChange={event => changeFilter('productId', event.target.value)}
            >
              <option value="">全部规格</option>
              {catalog.products.map(product => (
                <option key={product.id} value={product.id}>
                  {productLabel(product)}
                </option>
              ))}
            </select>
          </label>
          {tab !== 'in_stock' && (
            <>
              <label className="text-sm">
                销售人
                <input
                  className="input mt-1 w-full"
                  value={filters.salespersonName}
                  onChange={event => changeFilter('salespersonName', event.target.value)}
                  placeholder="销售人姓名"
                />
              </label>
              {can('stock.collections.read') && (
                <label className="text-sm">
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
              <label className="text-sm">
                销售日期起
                <input
                  className="input mt-1 w-full"
                  type="date"
                  value={filters.soldFrom}
                  onChange={event => changeFilter('soldFrom', event.target.value)}
                />
              </label>
              <label className="text-sm">
                销售日期止
                <input
                  className="input mt-1 w-full"
                  type="date"
                  value={filters.soldTo}
                  onChange={event => changeFilter('soldTo', event.target.value)}
                />
              </label>
            </>
          )}
          <button
            className="btn btn-secondary self-end justify-self-start"
            type="button"
            onClick={() => {
              setFilters(INITIAL_FILTERS);
              setQuery('');
              setPage(1);
              setSelected([]);
            }}
          >
            清空筛选
          </button>
        </div>
      )}
      {selected.length > 0 && (
        <div className="stock-toolbar rounded-lg border border-blue-100 bg-primary-50 p-3">
          <span className="text-sm text-primary">已选 {selected.length} 台</span>
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
          columns={columns}
          items={items}
          onRow={unit => setDetail({ id: unit.id })}
          empty={
            Object.values(filters).some(Boolean)
              ? '没有符合条件的设备，请调整搜索或筛选'
              : tab === 'in_stock'
                ? '还没有在库设备，可点击“入库登记”开始'
                : '还没有销售记录，可从在库登记售出或补录历史销售'
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
      {action?.type === 'receive' && (
        <LedgerEntryForm
          catalog={catalog}
          initialSerials={initialSerials}
          onExisting={id => setDetail({ id })}
          onClose={() => setAction(null)}
          onSaved={done}
        />
      )}
      {action?.type === 'history' && (
        <LedgerEntryForm
          catalog={catalog}
          historical
          onExisting={id => setDetail({ id })}
          onClose={() => setAction(null)}
          onSaved={done}
        />
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
