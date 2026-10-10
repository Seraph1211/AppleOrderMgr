import { useState } from 'react';
import TagMultiSelect from '../TagMultiSelect';
import { StockBadge, StockFeedback, StockModal, StockTable } from './StockCommon';
import { useStockCommand, useStockData } from './stockHooks';
import { ledgerCan } from './ledgerHelpers';
import { dateText } from './stockHelpers';

export const LIFECYCLE_STATES = [
  { value: 'registered', label: '未入库' },
  { value: 'in_stock', label: '在库' },
  { value: 'sold', label: '已售' },
  { value: 'returned', label: '已退货' },
];

/** 单台异常为附加提示；不会形成第二个库存状态。 */
export function StockLifecycleInfo({ unit, disabled, onReview, onReceive }) {
  return (
    <div className="mt-1 space-y-1 text-xs [overflow-wrap:anywhere]">
      {unit.lifecycleMessage && <p className="text-amber-700">{unit.lifecycleMessage}</p>}
      {unit.check && (
        <details className="text-gray-500">
          <summary className="cursor-pointer">
            系统状态核对{unit.check.errorCode ? '待补充' : ''}
          </summary>
          <p>来源状态时间：{dateText(unit.check.observedAt)}</p>
          <p>最近核对：{dateText(unit.check.checkedAt)}</p>
          <p>读取系统内“官网订单状态”，不主动查询官网。</p>
          {unit.check.errorCode && <p>系统状态暂不可用，保留原库存状态。</p>}
        </details>
      )}
      {(ledgerCan(unit, 'confirm_return') || ledgerCan(unit, 'resolve_return')) && (
        <button className="btn btn-secondary" disabled={disabled} onClick={() => onReview(unit)}>
          核实退货
        </button>
      )}
      {ledgerCan(unit, 'receive') && (
        <button className="btn btn-primary" disabled={disabled} onClick={() => onReceive(unit)}>
          登记入库
        </button>
      )}
    </div>
  );
}

/** 对同订单完整 SN 集合进行人工确认；已售冲突另行核实保留。 */
export function StockReturnForm({ unit, onClose, onSaved }) {
  const review = useStockData(`/ledger/returns/${unit.orderId}`);
  const command = useStockCommand();
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState('');
  const sns = selected ?? review.data?.serialNumbers ?? [];
  const mapping = unit.lifecycleIssue === 'return_pending';
  const submit = async event => {
    event.preventDefault();
    try {
      const path = mapping
        ? `/ledger/returns/${unit.orderId}`
        : `/ledger/${unit.id}/resolve-return`;
      const result = await command.execute(
        'POST',
        path,
        mapping
          ? {
              fingerprint: review.data.fingerprint,
              serialNumbers: sns,
              reason: reason.trim(),
            }
          : {
              expectedVersion: unit.version,
              reason: reason.trim(),
              resolution: unit.state === 'sold' ? 'keep_sold' : 'restore_previous',
            }
      );
      if (result) onSaved(result);
    } catch (error) {
      command.setError(error.message);
    }
  };
  return (
    <StockModal title="核实退货设备" onClose={onClose} busy={command.busy}>
      <StockFeedback loading={review.loading} error={review.error} onRetry={review.reload} />
      {review.data && (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-gray-600">
            订单 {review.data.orderNumber} · 官网退货数量：{review.data.returnQuantity || '待核实'}
          </p>
          {mapping ? (
            <>
              <p className="text-sm text-gray-600">
                请选择本订单全部退货 SN。未勾选设备保留原状态；已售设备将提示冲突。
              </p>
              <StockTable
                items={review.data.units}
                columns={[
                  {
                    key: 'select',
                    title: '退货',
                    render: row => (
                      <input
                        type="checkbox"
                        aria-label={`退货 ${row.serialNumber}`}
                        checked={sns.includes(row.serialNumber)}
                        onChange={event =>
                          setSelected(
                            event.target.checked
                              ? [...sns, row.serialNumber]
                              : sns.filter(sn => sn !== row.serialNumber)
                          )
                        }
                      />
                    ),
                  },
                  { key: 'serialNumber', title: 'SN' },
                  {
                    key: 'state',
                    title: '当前状态',
                    render: row => <StockBadge value={row.state} />,
                  },
                ]}
              />
            </>
          ) : (
            <p className="text-sm text-amber-700">
              {unit.state === 'sold'
                ? '本次确认保留已售，销售和货款不变。如果销售登记有误，请先核实并通过原销售更正操作处理。'
                : '本次确认设备已撤销退货，恢复退货前的未入库或在库状态；在库恢复至原仓库。'}
            </p>
          )}
          <label className="block text-sm">
            核实依据（必填）
            <textarea
              className="input mt-1 w-full"
              required
              maxLength={500}
              value={reason}
              onChange={event => setReason(event.target.value)}
            />
          </label>
          <StockFeedback error={command.error} />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={command.busy}
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="btn btn-primary"
              disabled={command.busy || !reason.trim() || (mapping && !sns.length)}
            >
              确认保存
            </button>
          </div>
        </form>
      )}
    </StockModal>
  );
}

/** 全筛选集合的数量统计，独立于台账分页，未知规格仍纳入总数。 */
export function StockStatistics({ catalog, onClose }) {
  const [states, setStates] = useState([]);
  const [warehouseIds, setWarehouseIds] = useState([]);
  const resource = useStockData('/ledger/statistics', { states, warehouseIds });
  return (
    <StockModal title="设备数量统计" onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <TagMultiSelect
            ariaLabel="统计设备状态"
            placeholder="全部状态"
            itemLabel="状态"
            enableSelectAll
            options={LIFECYCLE_STATES.map(s => s.value)}
            optionLabels={Object.fromEntries(LIFECYCLE_STATES.map(s => [s.value, s.label]))}
            value={states}
            onChange={setStates}
          />
          <TagMultiSelect
            ariaLabel="统计仓库"
            placeholder="全部仓库"
            itemLabel="仓库"
            enableSelectAll
            options={[
              'unassigned',
              ...(catalog.statisticWarehouses || catalog.warehouses).map(w => w.id),
            ]}
            optionLabels={{
              unassigned: '未分配仓库',
              ...Object.fromEntries(
                (catalog.statisticWarehouses || catalog.warehouses).map(w => [w.id, w.name])
              ),
            }}
            value={warehouseIds}
            onChange={setWarehouseIds}
          />
        </div>
        <p className="text-sm text-gray-500">
          统计全部筛选结果；已售按出货仓库、已退货按最后仓库。未入库归未分配仓库。
        </p>
        <StockFeedback
          loading={resource.loading}
          error={resource.error}
          onRetry={resource.reload}
        />
        {resource.data && (
          <>
            <p className="font-semibold text-primary">总计 {resource.data.total} 台</p>
            <StockTable
              items={resource.data.models.map(row => ({ ...row, id: row.modelName }))}
              columns={[
                { key: 'modelName', title: '型号小计' },
                { key: 'count', title: '数量（台）' },
              ]}
            />
            <StockTable
              items={resource.data.items.map((row, index) => ({ ...row, id: index }))}
              columns={[
                { key: 'modelName', title: '型号' },
                {
                  key: 'storageGb',
                  title: '容量',
                  render: row => (row.storageGb ? `${row.storageGb} GB` : '待补'),
                },
                { key: 'colorName', title: '颜色', render: row => row.colorName || '待补' },
                { key: 'count', title: '数量（台）' },
              ]}
            />
          </>
        )}
      </div>
    </StockModal>
  );
}
