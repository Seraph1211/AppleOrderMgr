import TagMultiSelect from './TagMultiSelect';
import { OFFICIAL_ORDER_STATUS_LABELS } from '../constants/officialOrderStatus';

/** 复用订单页官网状态多选、全选和中文标签，未知官网状态保留原值。 */
export default function OfficialStatusFilter({
  options = [],
  value = [],
  onChange,
  triggerLabel = '',
}) {
  return (
    <TagMultiSelect
      enableSelectAll
      options={options}
      optionLabels={OFFICIAL_ORDER_STATUS_LABELS}
      value={value}
      onChange={onChange}
      ariaLabel="官网订单状态筛选"
      placeholder="全部官网状态"
      itemLabel="官网状态"
      triggerLabel={triggerLabel}
    />
  );
}
