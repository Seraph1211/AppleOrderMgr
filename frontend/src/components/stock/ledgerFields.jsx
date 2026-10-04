import { useId } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { StockField, StockFields } from './StockCommon';
import { productLabel, stockOptions } from './stockHelpers';
import { LEDGER_PAYMENT_LABELS } from './ledgerHelpers';

/** 就地选择或填写规格，无商品编码和配置前置步骤。 */
export function LedgerProductFields({ value, onChange, catalog, disabled = false }) {
  return (
    <StockFields
      value={value}
      onChange={onChange}
      disabled={disabled}
      fields={[
        {
          key: 'productId',
          label: '手机规格',
          type: 'select',
          required: true,
          options: [
            ...stockOptions(catalog.products, productLabel),
            { value: '__new__', label: '填写新规格…' },
          ],
        },
        {
          key: 'modelName',
          label: '型号',
          required: true,
          hidden: value.productId !== '__new__',
          placeholder: '如 iPhone 17 Pro',
        },
        {
          key: 'storageGb',
          label: '容量（GB）',
          type: 'number',
          min: 1,
          required: true,
          hidden: value.productId !== '__new__',
        },
        { key: 'colorName', label: '颜色', required: true, hidden: value.productId !== '__new__' },
      ]}
    />
  );
}

/** 历史姓名候选允许直接填写，不需要建立人员账号。 */
export function LedgerPersonField({
  label,
  value,
  onChange,
  people = [],
  required,
  disabled,
  hint,
}) {
  const listId = useId();
  return (
    <StockField label={label} hint={hint}>
      <input
        className="input"
        value={value || ''}
        list={listId}
        onChange={event => onChange(event.target.value)}
        required={required}
        disabled={disabled}
        maxLength={100}
        placeholder={required ? '选择或填写姓名' : '不知道时留空，保存为待补'}
      />
      <datalist id={listId}>
        {people.map(person => (
          <option key={person.id || person.name} value={person.name} />
        ))}
      </datalist>
    </StockField>
  );
}

/** 姓名是销售与实物交付两种职责，可以相同。 */
export function LedgerPeopleFields({
  value,
  onChange,
  catalog,
  historical = false,
  disabled = false,
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <LedgerPersonField
        label="销售人"
        value={value.salespersonName}
        onChange={salespersonName => onChange({ ...value, salespersonName })}
        people={catalog.people}
        required={!historical}
        disabled={disabled}
        hint={historical ? '不清楚可待补' : '负责成交的人'}
      />
      <LedgerPersonField
        label="出货人"
        value={value.handlerName}
        onChange={handlerName => onChange({ ...value, handlerName })}
        people={catalog.people}
        required={!historical}
        disabled={disabled}
        hint={historical ? '不清楚可待补' : '负责从仓库交货或寄件的人'}
      />
    </div>
  );
}

/** 单台全款状态；历史未知不猜测付款事实。 */
export function LedgerPaymentFields({
  value,
  onChange,
  catalog,
  historical = false,
  disabled = false,
  prefix = '',
}) {
  const { can } = useAuth();
  const options = [
    'unpaid',
    'agent_pending',
    'company_received',
    ...(historical ? ['unknown'] : []),
  ]
    .filter(status => status !== 'agent_pending' || can('stock.collections.edit'))
    .filter(
      status =>
        status !== 'company_received' ||
        (can('stock.receipts.edit') && can('stock.collections.edit'))
    );
  return (
    <div className="space-y-3">
      <StockFields
        value={value}
        onChange={onChange}
        disabled={disabled}
        prefix={prefix}
        fields={[
          {
            key: 'status',
            label: '货款状况',
            type: 'select',
            required: true,
            options: options.map(status => ({
              value: status,
              label: LEDGER_PAYMENT_LABELS[status],
            })),
          },
          {
            key: 'collectedOn',
            label: '收款日期',
            type: 'date',
            hidden: value.status !== 'agent_pending',
            hint: '不知道日期可待补',
          },
          {
            key: 'receivedOn',
            label: '公司到账日期',
            type: 'date',
            hidden: value.status !== 'company_received',
            required: !historical,
            hint: '按实际到账日期填写，历史日期不明可待补',
          },
        ]}
      />
      {value.status === 'agent_pending' && (
        <LedgerPersonField
          label={`${prefix}实际代收人`}
          value={value.collectorName}
          onChange={collectorName => onChange({ ...value, collectorName })}
          people={catalog.people}
          required
          disabled={disabled}
        />
      )}
    </div>
  );
}

/** 始终保留取消和提交，短视口中随表单一起滚动可达。 */
export function LedgerActions({ busy, onClose, submitLabel = '保存', disabled = false }) {
  return (
    <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
      <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
        取消
      </button>
      <button type="submit" className="btn btn-primary" disabled={busy || disabled}>
        {busy ? '保存中…' : submitLabel}
      </button>
    </div>
  );
}
