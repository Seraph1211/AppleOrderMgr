import { useState } from 'react';
import { StockFeedback, StockFields, StockTable } from './StockCommon';
import { useStockCommand } from './stockHooks';

/** 按职责维护可选姓名；移出预置只停用候选，保留历史引用。 */
export default function LedgerPeopleSettings({ catalog, role, onSaved }) {
  const command = useStockCommand();
  const [name, setName] = useState('');
  const label = role === 'salesperson' ? '销售人' : '出货人';
  const people = catalog.people.filter(person => person.roles?.includes(role));
  const submit = async event => {
    event.preventDefault();
    try {
      const normalized = name.trim();
      const existing = catalog.people.find(person => person.name === normalized);
      if (existing?.roles.includes(role)) throw new Error('此姓名已在预置选项中');
      const result = await command.execute(
        existing ? 'PATCH' : 'POST',
        existing ? `/parties/${existing.id}` : '/parties',
        {
          name: normalized,
          partyType: existing?.partyType || 'external_person',
          roles: [...new Set([...(existing?.roles || []), role])],
          isActive: true,
          ...(existing ? { expectedVersion: existing.version } : {}),
        }
      );
      if (result) {
        setName('');
        onSaved(result);
      }
    } catch (failure) {
      command.setError(failure.message);
    }
  };
  const remove = async person => {
    try {
      const roles = person.roles.filter(value => value !== role);
      const result = await command.execute('PATCH', `/parties/${person.id}`, {
        expectedVersion: person.version,
        roles: roles.length ? roles : person.roles,
        isActive: roles.length > 0,
      });
      if (result) onSaved(result);
    } catch (failure) {
      command.setError(failure.message);
    }
  };
  return (
    <section className="space-y-3">
      <p className="text-sm text-gray-500">
        预置姓名可直接选择，登记时也可手动填写。移出预置会保留已有销售记录。
      </p>
      <StockTable
        items={people}
        empty={`暂无预置${label}，可在下方添加`}
        columns={[
          { key: 'name', title: `${label}姓名` },
          {
            key: 'action',
            title: '操作',
            render: person => (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={command.busy}
                onClick={() => remove(person)}
              >
                移出预置
              </button>
            ),
          },
        ]}
      />
      <form onSubmit={submit} className="space-y-3">
        <StockFields
          value={{ name }}
          onChange={next => setName(next.name)}
          disabled={command.busy}
          fields={[{ key: 'name', label: `新增${label}姓名`, required: true, maxLength: 100 }]}
        />
        <button className="btn btn-primary" type="submit" disabled={command.busy}>
          {command.busy ? '保存中…' : `添加${label}`}
        </button>
      </form>
      <StockFeedback error={command.error} />
    </section>
  );
}
