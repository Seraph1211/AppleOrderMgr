import { useState, useEffect } from 'react'

/**
 * 合并默认列配置和已保存的列配置
 * 处理新增列的情况
 */
function mergeColumns(defaultColumns, savedColumns) {
  if (!savedColumns || savedColumns.length === 0) {
    return defaultColumns.map(col => ({ ...col, visible: col.defaultVisible }))
  }

  const savedMap = new Map(savedColumns.map(col => [col.key, col]))

  return defaultColumns.map(col => {
    const saved = savedMap.get(col.key)
    return {
      ...col,
      visible: saved ? saved.visible : col.defaultVisible,
    }
  })
}

/**
 * 列配置 Hook
 * @param {string} tableName - 表格名称（orders, appleIds, recipients）
 * @param {Array} defaultColumns - 默认列配置
 */
export default function useColumnConfig(tableName, defaultColumns) {
  const storageKey = `columnConfig:${tableName}`

  const loadConfig = () => {
    const saved = localStorage.getItem(storageKey)
    if (saved) {
      try {
        const config = JSON.parse(saved)
        return mergeColumns(defaultColumns, config.columns)
      } catch (e) {
        console.error('Failed to parse column config:', e)
      }
    }
    return defaultColumns.map(col => ({ ...col, visible: col.defaultVisible }))
  }

  const [columns, setColumns] = useState(loadConfig)

  const saveConfig = (newColumns) => {
    const config = {
      version: '1.0',
      columns: newColumns.map((col, index) => ({
        key: col.key,
        visible: col.visible,
        order: index,
      })),
      updatedAt: new Date().toISOString(),
    }
    localStorage.setItem(storageKey, JSON.stringify(config))
    setColumns(newColumns)
  }

  const resetConfig = () => {
    localStorage.removeItem(storageKey)
    const resetColumns = defaultColumns.map(col => ({
      ...col,
      visible: col.defaultVisible
    }))
    setColumns(resetColumns)
  }

  return { columns, saveConfig, resetConfig }
}
