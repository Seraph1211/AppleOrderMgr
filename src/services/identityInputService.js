const XLSX = require('xlsx');
const ApiError = require('../utils/ApiError');

const MAX_ROWS = 1000;
const LABELS = Object.freeze({
  pending: '待核验',
  processing: '核验中',
  matched: '一致',
  mismatched: '不一致',
  error: '接口异常',
  unknown: '结果未知',
  invalid: '格式错误',
  duplicate: '重复行',
  cancelled: '已停止',
});

/** 校验大陆18位身份证及姓名，保留原始值供显示。 @returns {string|null} 错误说明 */
function validateIdentity(name, idCardNumber) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 100 ||
    Array.from(name).some(char => char.charCodeAt(0) < 32)
  )
    return '姓名不能为空，最多100字，不能含控制字符';
  if (typeof idCardNumber !== 'string')
    return '身份证号必须为文本，请将Excel单元格设置为文本后重新填写';
  if (idCardNumber.length > 100) return '身份证字段过长，请检查原始数据';
  const card = idCardNumber.trim().toUpperCase();
  if (!/^[1-9]\d{16}[\dX]$/.test(card)) return '请填写大陆18位居民身份证号';
  const year = Number(card.slice(6, 10));
  const month = Number(card.slice(10, 12));
  const day = Number(card.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1800 ||
    date > new Date() ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return '身份证出生日期无效';
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = weights.reduce((total, weight, i) => total + Number(card[i]) * weight, 0);
  if ('10X98765432'[sum % 11] !== card[17]) return '身份证校验位错误，请核对原始号码';
  return null;
}

/** 解析受限Excel；数字身份证和公式必须报错，绝不恢复丢失的精度。 @returns {Object} 预览 */
function parseIdentityWorkbook(buffer) {
  let book;
  try {
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('not xlsx');
    book = XLSX.read(buffer, { type: 'buffer', cellFormula: true, sheetRows: 10002 });
  } catch (_error) {
    throw ApiError.badRequest('无法读取Excel，请上传有效的.xlsx文件');
  }
  const sheet = book.Sheets['身份核验'] || book.Sheets[book.SheetNames[0]];
  if (!sheet || !sheet['!ref']) throw ApiError.badRequest('工作表为空');
  const ref = sheet['!fullref'] || sheet['!ref'];
  const range = XLSX.utils.decode_range(ref);
  if (range.e.r >= 10000 || range.e.c >= 100)
    throw ApiError.badRequest('工作表范围过大，请使用模板并删除多余空白区域');
  const headers = new Map();
  for (let col = 0; col <= range.e.c; col++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: 0, c: col })];
    const value = String(cell?.v ?? '').trim();
    if (['姓名', '身份证号'].includes(value)) {
      if (headers.has(value)) throw ApiError.badRequest('表头重复，请只保留一列姓名和身份证号');
      headers.set(value, col);
    }
  }
  if (headers.size !== 2) throw ApiError.badRequest('第一行必须包含“姓名”和“身份证号”');
  const rows = [];
  const seen = new Map();
  let empty = 0;
  for (let r = 1; r <= range.e.r; r++) {
    const nameCell = sheet[XLSX.utils.encode_cell({ r, c: headers.get('姓名') })];
    const cardCell = sheet[XLSX.utils.encode_cell({ r, c: headers.get('身份证号') })];
    if (
      !nameCell?.f &&
      !cardCell?.f &&
      !String(nameCell?.v ?? '').trim() &&
      !String(cardCell?.v ?? '').trim()
    ) {
      empty++;
      continue;
    }
    if (rows.length >= MAX_ROWS) throw ApiError.badRequest('每批最多1000条非空数据');
    const name = String(nameCell?.v ?? '');
    const idCardNumber = String(cardCell?.v ?? '');
    if (name.length > 100 || idCardNumber.length > 100)
      throw ApiError.badRequest(`第${r + 1}行字段过长，请检查文件`);
    let message =
      nameCell?.f || cardCell?.f
        ? '姓名和身份证号不能使用公式，请粘贴为文本值'
        : cardCell?.t !== 's'
          ? '身份证号必须为文本，请设置文本格式后重新填写，避免精度丢失'
          : validateIdentity(name, idCardNumber);
    const key = JSON.stringify([name.trim(), idCardNumber.trim().toUpperCase()]);
    const duplicateOf = !message ? seen.get(key) || null : null;
    if (!message && !duplicateOf) seen.set(key, r + 1);
    if (duplicateOf) message = `与第${duplicateOf}行相同，共用一次核验结果`;
    rows.push({
      rowNumber: r + 1,
      name,
      idCardNumber,
      duplicateOf,
      status: duplicateOf ? 'duplicate' : message ? 'invalid' : 'pending',
      message,
    });
  }
  if (!rows.length) throw ApiError.badRequest('没有可预览的数据');
  return {
    rows,
    summary: {
      total: rows.length,
      empty,
      valid: rows.filter(row => row.status === 'pending').length,
      invalid: rows.filter(row => row.status === 'invalid').length,
      duplicates: rows.filter(row => row.status === 'duplicate').length,
    },
  };
}

/** 将原始输入和结果导出为文本单元格，避免公式执行和证件精度损失。 @returns {Buffer} xlsx */
function exportIdentityWorkbook(rows) {
  const values = [
    [
      '原始行号',
      '姓名',
      '身份证号',
      '核验结果',
      '说明',
      '重复来源行',
      '核验时间',
      '性别',
      '生日',
      '地区',
      '流水号',
    ],
    ...rows.map(row => [
      String(row.rowNumber),
      row.name,
      row.idCardNumber,
      LABELS[row.status] || row.status,
      row.message || '',
      row.duplicateOf ? String(row.duplicateOf) : '',
      row.finishedAt || '',
      row.resultData?.sex || '',
      row.resultData?.birthday || '',
      row.resultData?.area || '',
      row.resultData?.sn || '',
    ]),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(values.map(row => row.map(value => String(value))));
  for (const key of Object.keys(sheet))
    if (!key.startsWith('!')) {
      sheet[key].t = 's';
      sheet[key].z = '@';
    }
  sheet['!cols'] = [12, 18, 26, 14, 55, 14, 28, 10, 16, 32, 32].map(wch => ({ wch }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '核验结果');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  MAX_ROWS,
  LABELS,
  validateIdentity,
  parseIdentityWorkbook,
  exportIdentityWorkbook,
};
