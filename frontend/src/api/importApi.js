import client from './client';

/**
 * 预览导入数据
 * @param {File} file - Excel 文件
 * @param {string} type - 导入类型（apple_ids 或 recipients）
 */
export async function previewImport(file, type) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('type', type);

  const response = await client.post('/import/preview', formData, {
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
export async function executeImport(sessionToken) {
  const response = await client.post('/import/execute', { sessionToken });
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
