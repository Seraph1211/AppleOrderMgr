import client from './client';

/**
 * 预览导入数据
 * @param {File} file - Excel 文件
 * @param {string} type - 导入类型（apple_ids 或 recipients）
 */
export async function previewImport(file, type) {
  const formData = new FormData();
  for (const entry of Array.isArray(file) ? file : [file]) formData.append('files', entry);
  formData.append('type', type);

  const response = await client.post(`/import/preview?type=${encodeURIComponent(type)}`, formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  });

  return response;
}

/**
 * 执行批量导入
 * @param {string} type - 导入类型（apple_ids 或 recipients）
 * @param {Array} data - 导入数据
 */
export async function executeImport(sessionToken, type, decisions = {}) {
  const response = await client.post('/import/execute', { sessionToken, type, decisions });
  return response;
}

/**
 * 下载导入模板
 * @param {string} type - 模板类型（apple_ids 或 recipients）
 */
export async function downloadTemplate(type) {
  const blob = await client.get(`/import/template/${type}`, { responseType: 'blob' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download =
    type === 'apple_ids' ? 'apple_ids_import_template.xlsx' : 'recipients_import_template.xlsx';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

/** 重新预览差异裁定，不执行导入。 */
export const reviewImport = (sessionToken, type, decisions) =>
  client.post('/import/review', { sessionToken, type, decisions });
