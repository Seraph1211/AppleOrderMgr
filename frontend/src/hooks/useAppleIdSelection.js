import { useEffect, useRef, useState } from 'react';
import client from '../api/client';
import { loadAppleIdSelection, togglePageSelection } from '../utils/appleIdBatch';

/** 管理 Apple ID 跨页选择及筛选结果快照，丢弃过期选择请求。 */
export default function useAppleIdSelection() {
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState('');
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );
  const clearSelection = () => {
    generation.current += 1;
    setSelectedIds(new Set());
    setSelecting(false);
    setSelectionError('');
  };
  const selectPage = ids => {
    generation.current += 1;
    setSelectedIds(new Set(ids));
    setSelecting(false);
    setSelectionError('');
  };
  const toggleIds = (ids, checked) => {
    generation.current += 1;
    setSelecting(false);
    const next = togglePageSelection(selectedIds, ids, checked);
    if (next.size > 5000) {
      setSelectionError('最多选择 5000 个 Apple ID，请缩小选择范围');
      return;
    }
    setSelectedIds(next);
    setSelectionError('');
  };
  const selectFiltered = params =>
    loadAppleIdSelection({
      fetchIds: () => client.get('/apple-ids/selection-ids', { params }),
      generation,
      onSelected: setSelectedIds,
      onLoading: setSelecting,
      onError: setSelectionError,
    });
  return {
    selectedIds,
    selecting,
    selectionError,
    clearSelection,
    selectPage,
    toggleIds,
    selectFiltered,
  };
}
