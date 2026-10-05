import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { StockBadge, StockFeedback, StockFields, StockModal, StockTable } from './StockCommon';
import { useStockCommand, useStockData } from './stockHooks';
import { dateText, moneyText, productLabel, stockEventLabel, stockOptions } from './stockHelpers';
import { ledgerAmount, ledgerCan, ledgerProduct, LEDGER_PAYMENT_LABELS } from './ledgerHelpers';
import { LedgerActions, LedgerPeopleFields, LedgerProductFields } from './ledgerFields';
import StockAttachments from './StockAttachments';
import LedgerPaymentForm from './ledgerPaymentForm';

function LedgerEditForm({ unit, catalog, onClose, onSaved }) {
  const { can } = useAuth();
  const command = useStockCommand();
  const initial = {
    serialNumber: unit.serialNumber,
    orderNumber: unit.orderNumber || '',
    productId: unit.product?.id || '',
    warehouseId: (unit.state === 'sold' ? unit.sourceWarehouse : unit.warehouse)?.id || '',
    receivedOn: unit.receivedOn || '',
    officialCostAmount: unit.officialCostAmount ?? '',
    extraExpenseAmount: unit.extraExpenseAmount ?? '',
    notes: unit.notes || '',
    salespersonName: unit.salespersonName || '',
    handlerName: unit.handlerName || '',
    soldOn: unit.soldOn || '',
    saleAmount: unit.saleAmount ?? '',
    settlementAmount: unit.settlementAmount ?? '',
    reason: '',
  };
  const [value, setValue] = useState(initial);
  const saleLocked = unit.state === 'sold' && Boolean(unit.compatibilityReason);
  const canCorrect = unit.state !== 'sold' || can('stock.correct');
  const canEditSale =
    unit.state === 'sold' &&
    !saleLocked &&
    canCorrect &&
    can('stock.sales.edit') &&
    can('stock.sales.ship');
  const canEditProduct =
    !saleLocked &&
    (unit.state !== 'sold' || (canCorrect && can('stock.sales.ship'))) &&
    (unit.costStatus !== 'confirmed' || can('stock.cost.edit'));
  const canEditCost = !saleLocked && canCorrect && can('stock.cost.edit');
  const canEditExpense = !saleLocked && can('stock.expenses.edit');
  const submit = async event => {
    event.preventDefault();
    try {
      const payload = { expectedVersion: unit.version };
      ['serialNumber', 'receivedOn', 'notes'].forEach(key => {
        if (value[key] !== initial[key]) payload[key] = value[key].trim() || null;
      });
      if (can('stock.source.link') && value.orderNumber !== initial.orderNumber)
        payload.orderNumber = value.orderNumber.trim() || null;
      const productChanged =
        canEditProduct && (value.productId !== initial.productId || value.productId === '__new__');
      if (productChanged) Object.assign(payload, ledgerProduct(value));
      if (
        ((unit.state === 'in_stock' && can('stock.transfer')) || canEditSale) &&
        value.warehouseId !== initial.warehouseId
      )
        payload.warehouseId = value.warehouseId;
      if (
        canEditCost &&
        (productChanged || value.officialCostAmount !== initial.officialCostAmount)
      )
        payload.officialCostAmount = ledgerAmount(value.officialCostAmount);
      if (canEditExpense && value.extraExpenseAmount !== initial.extraExpenseAmount)
        payload.extraExpenseAmount = ledgerAmount(value.extraExpenseAmount);
      if (canEditSale) {
        const sale = {};
        ['salespersonName', 'handlerName', 'soldOn', 'saleAmount', 'settlementAmount'].forEach(
          key => {
            if (value[key] !== initial[key])
              sale[key] = ['saleAmount', 'settlementAmount'].includes(key)
                ? ledgerAmount(value[key])
                : value[key].trim() || null;
          }
        );
        if (Object.keys(sale).length) payload.sale = sale;
      }
      if (value.reason.trim()) payload.reason = value.reason.trim();
      if (Object.keys(payload).length <= 1) throw new Error('没有需要保存的修改');
      const result = await command.execute('PATCH', `/ledger/${unit.id}`, payload);
      if (result) onSaved(result);
    } catch (failure) {
      command.setError(failure.message);
    }
  };
  return (
    <StockModal title="编辑设备资料" onClose={onClose} busy={command.busy}>
      <form onSubmit={submit} className="space-y-4">
        {saleLocked && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            {unit.compatibilityReason}。可补充 SN、订单号、入库日期和备注。
          </p>
        )}
        <StockFields
          value={value}
          onChange={setValue}
          disabled={command.busy}
          fields={[
            { key: 'serialNumber', label: 'SN', required: true, maxLength: 12 },
            {
              key: 'orderNumber',
              label: '订单号',
              hidden: !can('stock.source.link'),
              placeholder: '允许之后补关联',
            },
          ]}
        />
        <LedgerProductFields
          value={value}
          onChange={setValue}
          catalog={catalog}
          disabled={command.busy || !canEditProduct}
        />
        <StockFields
          value={value}
          onChange={setValue}
          disabled={command.busy}
          fields={[
            {
              key: 'warehouseId',
              label: unit.state === 'sold' ? '出库仓库' : '所在仓库',
              type: 'select',
              required: unit.state === 'in_stock',
              hidden: unit.state === 'in_stock' ? !can('stock.transfer') : !canEditSale,
              options: stockOptions(catalog.warehouses),
              hint: unit.state === 'sold' ? '按实际出库地点补充' : '实物已经到位后再更改仓库',
            },
            {
              key: 'receivedOn',
              label: '入库日期',
              type: 'date',
              required: unit.state === 'in_stock',
            },
            {
              key: 'officialCostAmount',
              label: '官网售价（元）',
              money: true,
              hidden: !canEditCost,
              placeholder: '留空表示待补成本',
              hint: '更改规格时，请一并核对官网售价。',
            },
            {
              key: 'extraExpenseAmount',
              label: '其他费用（元）',
              money: true,
              hidden: !canEditExpense,
              placeholder: '留空表示未录入',
            },
          ]}
        />
        {canEditSale && (
          <>
            <LedgerPeopleFields
              value={value}
              onChange={setValue}
              catalog={catalog}
              historical={unit.isHistorical}
              disabled={command.busy}
            />
            <StockFields
              value={value}
              onChange={setValue}
              disabled={command.busy}
              fields={[
                { key: 'soldOn', label: '销售日期', type: 'date', required: true },
                { key: 'saleAmount', label: '售价（元）', money: true, required: true },
                {
                  key: 'settlementAmount',
                  label: '结算金额（元）',
                  money: true,
                  placeholder: '留空待补',
                  hint: '人工填写售价扣除渠道抽成及其他费用后的金额；不再重复扣费。',
                },
              ]}
            />
          </>
        )}
        <StockFields
          value={value}
          onChange={setValue}
          disabled={command.busy}
          fields={[
            { key: 'notes', label: '备注', type: 'textarea' },
            {
              key: 'reason',
              label: '更正原因',
              hint: '更正已售金额或日期时请说明原因；仅修改备注可留空。',
            },
          ]}
        />
        {canEditSale && (
          <p className="text-sm text-gray-500">
            保存前请核对售价与人员。更正会同步更新该台销售和货款事实，原记录保留在修改记录中。
          </p>
        )}
        <StockFeedback error={command.error} />
        <LedgerActions
          busy={command.busy}
          onClose={onClose}
          submitLabel={unit.state === 'sold' ? '确认更正并保存' : '保存资料'}
        />
      </form>
    </StockModal>
  );
}

function LedgerRecoverForm({ unit, catalog, onClose, onSaved }) {
  const command = useStockCommand();
  const [value, setValue] = useState({
    warehouseId: unit.sourceWarehouse?.id || '',
    receivedOn: '',
    confirmInWarehouse: false,
    reason: '',
  });
  const submit = async event => {
    event.preventDefault();
    try {
      if (!value.confirmInWarehouse) throw new Error('请先核对实物仍在仓库');
      const result = await command.execute('POST', `/ledger/${unit.id}/recover`, {
        expectedVersion: unit.version,
        warehouseId: value.warehouseId,
        confirmInWarehouse: value.confirmInWarehouse,
        ...(!unit.receivedOn ? { receivedOn: value.receivedOn } : {}),
        reason: value.reason.trim(),
      });
      if (result) onSaved(result);
    } catch (failure) {
      command.setError(failure.message);
    }
  };
  return (
    <StockModal title="更正误售为在库" onClose={onClose} busy={command.busy}>
      <form onSubmit={submit} className="space-y-4">
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          仅用于误登记售出且实物仍在仓的机器。本次误录销售及相关货款、费用会一起更正，不用于真实退货。
        </p>
        <p className="font-mono">{unit.serialNumber}</p>
        <StockFields
          value={value}
          onChange={setValue}
          disabled={command.busy}
          fields={[
            {
              key: 'warehouseId',
              label: '实物所在仓库',
              type: 'select',
              required: true,
              options: stockOptions(catalog.warehouses),
            },
            {
              key: 'receivedOn',
              label: '实际入库日期',
              type: 'date',
              hidden: Boolean(unit.receivedOn),
              required: !unit.receivedOn,
              hint: '原入库日期未知，请按实际日期补充。',
            },
            { key: 'reason', label: '更正原因', type: 'textarea', required: true },
            { key: 'confirmInWarehouse', label: '已核对这台手机仍在上述仓库', type: 'checkbox' },
          ]}
        />
        <StockFeedback error={command.error} />
        <LedgerActions
          busy={command.busy}
          onClose={onClose}
          disabled={!value.confirmInWarehouse}
          submitLabel="确认更正回在库"
        />
      </form>
    </StockModal>
  );
}

/** 单台详情将销售、货款、照片和改动轨迹放在同一处。 */
export default function LedgerDetail({ id, catalog, onClose, onSaved }) {
  const { can } = useAuth();
  const resource = useStockData(`/ledger/${id}`);
  const evidence = useStockData(`/units/${id}`, {}, Boolean(resource.data));
  const [action, setAction] = useState(null);
  const unit = resource.data;
  const saved = result => {
    setAction(null);
    resource.reload();
    evidence.reload();
    onSaved(result);
  };
  const fields = unit
    ? [
        ['手机规格', productLabel(unit.product)],
        ['订单号', unit.orderNumber || (unit.orderLinked ? '已关联（按订单权限查看）' : '待补')],
        [
          unit.state === 'sold' ? '出库仓库' : '所在仓库',
          (unit.state === 'sold' ? unit.sourceWarehouse : unit.warehouse)?.name || '待补',
        ],
        ['入库日期', unit.receivedOn || '待补'],
        ...(unit.state === 'sold' && can('stock.sales.read')
          ? [
              ['销售日期', unit.soldOn || '待补'],
              ['销售人', unit.salespersonName || '待补'],
              ['出货人', unit.handlerName || '待补'],
              ['售价', moneyText(unit.saleAmount)],
              [
                '结算金额',
                unit.settlementAmount == null ? '待补结算' : moneyText(unit.settlementAmount),
              ],
            ]
          : []),
        ...(unit.paymentStatus
          ? [
              ['货款状况', LEDGER_PAYMENT_LABELS[unit.paymentStatus] || '待核实'],
              ['实际代收人', unit.collectorName || '—'],
              ['收款日期', unit.collectedOn || '待补'],
              ['公司到账日期', unit.companyReceivedOn || '—'],
            ]
          : []),
        ...(can('stock.cost.read')
          ? [
              [
                '官网售价',
                unit.officialCostAmount == null ? '待补成本' : moneyText(unit.officialCostAmount),
              ],
            ]
          : []),
        ...(can('stock.expenses.read')
          ? [
              [
                '其他费用',
                unit.extraExpenseAmount == null ? '未录入' : moneyText(unit.extraExpenseAmount),
              ],
            ]
          : []),
        ...(can('stock.profit.read') && unit.state === 'sold'
          ? [
              [
                '毛利',
                unit.grossProfit == null
                  ? unit.settlementAmount == null
                    ? '待补结算'
                    : '待补官网售价'
                  : moneyText(unit.grossProfit),
              ],
            ]
          : []),
        ['备注', unit.notes || '—'],
      ]
    : [];
  return (
    <StockModal title="设备详情" onClose={onClose} wide>
      <StockFeedback loading={resource.loading} error={resource.error} onRetry={resource.reload} />
      {unit && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="break-all font-mono text-lg">{unit.serialNumber}</strong>
            <StockBadge value={unit.state} />
            {unit.isHistorical && <span className="badge badge-info">历史补录</span>}
          </div>
          {unit.compatibilityReason && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              {unit.compatibilityReason}
            </p>
          )}
          <dl className="grid grid-cols-1 gap-x-5 gap-y-3 text-sm sm:grid-cols-2">
            {fields.map(([label, text]) => (
              <div key={label}>
                <dt className="text-gray-500">{label}</dt>
                <dd className="whitespace-pre-wrap break-words pt-1">{text}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap gap-2">
            {ledgerCan(unit, 'edit') && (
              <button
                className="btn btn-secondary"
                disabled={catalog.enabled === false}
                onClick={() => setAction('edit')}
              >
                编辑资料
              </button>
            )}
            {ledgerCan(unit, 'payment') && (
              <button
                className="btn btn-primary"
                disabled={catalog.enabled === false}
                onClick={() => setAction('payment')}
              >
                更新货款
              </button>
            )}
            {ledgerCan(unit, 'recover') && (
              <button
                className="btn btn-secondary"
                disabled={catalog.enabled === false}
                onClick={() => setAction('recover')}
              >
                更正误售为在库
              </button>
            )}
          </div>
          <StockFeedback error={evidence.error} onRetry={evidence.reload} />
          <StockAttachments
            target={{ type: 'unit', id }}
            items={evidence.data?.attachments || []}
            canWrite={can('stock.receive') && catalog.enabled !== false}
            onSaved={evidence.reload}
          />
          <section className="space-y-2 border-t pt-3">
            <h3 className="font-medium">修改记录</h3>
            <StockTable
              items={unit.events || []}
              columns={[
                {
                  key: 'time',
                  title: '时间',
                  render: event => dateText(event.occurredAt || event.createdAt),
                },
                { key: 'action', title: '操作', render: stockEventLabel },
                {
                  key: 'actor',
                  title: '操作人',
                  render: event => event.actorName || event.actor?.name || '内部人员',
                },
                {
                  key: 'reason',
                  title: '说明',
                  render: event => event.summary || event.reason || '—',
                },
              ]}
            />
          </section>
          {action === 'edit' && ledgerCan(unit, 'edit') && (
            <LedgerEditForm
              unit={unit}
              catalog={catalog}
              onClose={() => setAction(null)}
              onSaved={saved}
            />
          )}
          {action === 'payment' && ledgerCan(unit, 'payment') && (
            <LedgerPaymentForm
              units={[unit]}
              catalog={catalog}
              onClose={() => setAction(null)}
              onSaved={saved}
            />
          )}
          {action === 'recover' && ledgerCan(unit, 'recover') && (
            <LedgerRecoverForm
              unit={unit}
              catalog={catalog}
              onClose={() => setAction(null)}
              onSaved={saved}
            />
          )}
        </div>
      )}
    </StockModal>
  );
}
