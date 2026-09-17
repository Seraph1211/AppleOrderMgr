import { useState } from 'react';
import { mergeColumnConfig } from '../utils/columnConfig';

/**
 * 列配置 Hook
 * @param {string} tableName - 表格名称（orders, appleIds, recipients）
 * @param {Array} defaultColumns - 默认列配置
 */
export default function useColumnConfig(tableName, defaultColumns) {
  const storageKey = `columnConfig:${tableName}`;

  const loadConfig = () => {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        const config = JSON.parse(saved);
        return mergeColumnConfig(defaultColumns, config.columns);
      } catch (e) {
        console.error('Failed to parse column config:', e);
      }
    }
    return defaultColumns.map(col => ({
      ...col,
      visible: col.defaultVisible,
    }));
  };

  const [columns, setColumns] = useState(loadConfig);

  const saveConfig = newColumns => {
    const config = {
      version: '1.0',
      columns: newColumns.map((col, index) => ({
        key: col.key,
        visible: col.visible,
        order: index,
      })),
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(storageKey, JSON.stringify(config));
    setColumns(newColumns);
  };

  const resetConfig = () => {
    localStorage.removeItem(storageKey);
    const resetColumns = defaultColumns.map(col => ({
      ...col,
      visible: col.defaultVisible,
    }));
    setColumns(resetColumns);
  };

  return { columns, saveConfig, resetConfig };
}
