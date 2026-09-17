/* eslint-disable no-unused-vars, require-await, camelcase */
const XLSX = require('xlsx');
const logger = require('../utils/logger');
const { isValidEmail, isValidPhone, isValidIdCard } = require('../utils/helpers');
const { ACCOUNT_STATUSES } = require('../constants/business');

/**
 * 列名到字段名的映射
 */
const COLUMN_MAPPING = {
  apple_ids: {
    'Apple ID': 'appleId',
    密码: 'password',
    备注名称: 'notes',
    备注: 'notes',
    AppleID: 'appleId',
    国家: 'country',
    使用状态: 'status',
    国家地区: 'country',
    是否已修改: 'isModified',
    状态: 'status',
    密保问题1: 'question1',
    密保答案1: 'answer1',
    密保问题2: 'question2',
    密保答案2: 'answer2',
    密保问题3: 'question3',
    密保答案3: 'answer3',
  },
  recipients: {
    姓: 'lastName',
    名: 'firstName',
    身份证号: 'idCardNumber',
    身份证号码: 'idCardNumber',
    姓名: 'name',
    真实联系电话: 'realPhone',
    下单手机号码: 'phone',
    下单手机号: 'phone',
    Email: 'email',
    下单邮箱: 'email',
    'Apple ID': 'appleId',
    AppleID: 'appleId',
    密码: 'password',
    TAG: 'tag',
    使用状态: 'status',
    手机号: 'phone',
    邮箱: 'email',
    省: 'province',
    市: 'city',
    区: 'district',
    街道地址: 'streetAddress',
    '绑定 Apple ID': 'appleId',
    标签: 'tag',
    状态: 'status',
    备注: 'notes',
  },
};

/**
 * 解析 Excel 文件
 * @param {string} filePath - Excel 文件路径
 * @param {string} type - 导入类型（apple_ids 或 recipients）
 * @returns {Array} 解析后的数据数组
 */
function parseExcelFile(filePath, type) {
  try {
    const workbook = XLSX.readFile(filePath);
    const parsedData = [];
    let matched = 0;
    for (const sheetName of workbook.SheetNames) {
      const tencentApple = type === 'apple_ids' && sheetName.startsWith('26年AppleID');
      if (type === 'apple_ids' && !tencentApple && sheetName !== 'Apple IDs') continue;
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet['!ref']) continue;
      const range = XLSX.utils.decode_range(worksheet['!ref']);
      if (range.e.r > 20000 || range.e.c > 100) throw new Error('工作表范围过大，请拆分文件');
      const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', blankrows: true });
      const headers = data[0]?.map(value => String(value).trim()) || [];
      const mapping = COLUMN_MAPPING[type];
      if (type === 'recipients' && !headers.some(h => ['身份证号', '身份证号码'].includes(h)))
        continue;
      matched++;
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const rowData = {};
        const issues = [];
        headers.forEach((header, colIndex) => {
          const field = Object.prototype.hasOwnProperty.call(mapping, header)
            ? mapping[header]
            : null;
          if (!field) return;
          if (tencentApple && ['status', 'country', 'notes'].includes(field)) return;
          const cell =
            worksheet[XLSX.utils.encode_cell({ r: i + range.s.r, c: colIndex + range.s.c })];
          if (field === 'idCardNumber' && cell?.t === 'n')
            issues.push({ field, message: '身份证必须为文本；数值单元格可能已丢精度，请修正源表' });
          // 不执行公式。身份／凭据不能从无缓存公式猜测。
          if (cell?.f && !cell.v)
            issues.push({ field, message: '公式没有缓存值，请在源表确认后粘贴为值' });
          if (row[colIndex] !== '' && row[colIndex] != null)
            rowData[field] = field === 'tag' ? String(row[colIndex]) : String(row[colIndex]).trim();
        });
        if (tencentApple) {
          rowData.country = '中国';
          rowData.status = row[10] ? String(row[10]).trim() : undefined;
          for (let j = 1; j <= 3; j++) {
            if (row[2 * j + 1] !== '') rowData[`question${j}`] = String(row[2 * j + 1] || '');
            if (row[2 * j + 2] !== '') rowData[`answer${j}`] = String(row[2 * j + 2] || '');
          }
          if (!sheetName.includes('香港') && row[11]) rowData.notes = String(row[11]);
        }
        if (
          !rowData.appleId &&
          !rowData.idCardNumber &&
          !rowData.firstName &&
          !rowData.lastName &&
          !rowData.password
        )
          continue;
        if (rowData.appleId) rowData.appleId = rowData.appleId.trim().toLowerCase();
        if (rowData.idCardNumber) rowData.idCardNumber = rowData.idCardNumber.toUpperCase();
        if (type === 'recipients') {
          const statusMapping = {
            已挂服务器: '使用中',
            '已挂 需下架': '使用中',
            '已进表 未挂': '未使用',
          };
          rowData.status = statusMapping[rowData.status] || rowData.status;
          if (rowData.name && (!rowData.lastName || !rowData.firstName))
            issues.push({ field: 'name', message: '请分别填写姓和名，系统不猜测复姓' });
        }
        parsedData.push({ rowNumber: i + 1 + range.s.r, sheetName, data: rowData, issues });
      }
    }
    if (!matched)
      throw new Error(
        type === 'apple_ids'
          ? '未找到 Apple IDs 或 26年AppleID 工作表'
          : '未找到包含身份证列的取机人工作表'
      );
    if (!parsedData.length) throw new Error('没有可导入资料');
    return parsedData;
  } catch (error) {
    logger.warn('导入解析失败', { type, errorType: error.name });
    throw error;
  }
}

/**
 * 校验 Apple ID 数据
 * @param {Object} data - 单行数据
 * @returns {Array} 错误数组
 */
function validateAppleId(data) {
  const errors = [];

  // 必填校验
  if (!data.appleId) {
    errors.push({ field: 'appleId', message: 'Apple ID 不能为空' });
  } else if (!isValidEmail(data.appleId)) {
    errors.push({ field: 'appleId', message: 'Apple ID 必须是有效的邮箱格式' });
  }

  if (!data.password) {
    errors.push({ field: 'password', message: '密码不能为空' });
  }

  // 密保完整性校验
  const securityFields = [
    data.question1,
    data.answer1,
    data.question2,
    data.answer2,
    data.question3,
    data.answer3,
  ];
  const hasAnySecurityQA = securityFields.some(field => field);
  const hasAllSecurityQA = securityFields.every(field => field);

  if (hasAnySecurityQA && !hasAllSecurityQA) {
    errors.push({
      field: 'securityQa',
      message: '密保问答必须填写完整（3个问题+3个答案）',
    });
  }

  // 枚举值校验
  if (data.isModified && !['是', '否'].includes(data.isModified)) {
    errors.push({
      field: 'isModified',
      message: '是否已修改必须是"是"或"否"',
    });
  }

  if (data.status && !ACCOUNT_STATUSES.includes(data.status)) {
    errors.push({
      field: 'status',
      message: `状态必须是 ${ACCOUNT_STATUSES.join('、')}`,
    });
  }

  return errors;
}

/**
 * 校验取机人数据
 * @param {Object} data - 单行数据
 * @returns {Array} 错误数组
 */
function validateRecipient(data) {
  const errors = [];

  // 必填校验
  if (!data.lastName) {
    errors.push({ field: 'lastName', message: '姓氏不能为空' });
  } else if (data.lastName.length > 50) {
    errors.push({ field: 'lastName', message: '姓氏不能超过50个字符' });
  }

  if (!data.firstName) {
    errors.push({ field: 'firstName', message: '名字不能为空' });
  } else if (data.firstName.length > 49) {
    errors.push({ field: 'firstName', message: '名字不能超过49个字符' });
  }

  // 身份证校验
  if (!data.idCardNumber) {
    errors.push({ field: 'idCardNumber', message: '身份证号不能为空' });
  } else if (!isValidIdCard(data.idCardNumber)) {
    errors.push({
      field: 'idCardNumber',
      message: '身份证号必须是18位有效格式',
    });
  }

  // 手机号校验
  if (data.phone && !isValidPhone(data.phone)) {
    errors.push({ field: 'phone', message: '手机号必须是11位数字' });
  }

  // 邮箱校验
  if (data.email && !isValidEmail(data.email)) {
    errors.push({ field: 'email', message: '邮箱格式不正确' });
  }

  if (data.appleId && !isValidEmail(data.appleId)) {
    errors.push({
      field: 'appleId',
      message: '绑定的 Apple ID 必须是有效邮箱格式',
    });
  }

  // 枚举值校验
  if (data.status && !ACCOUNT_STATUSES.includes(data.status)) {
    errors.push({
      field: 'status',
      message: `状态必须是 ${ACCOUNT_STATUSES.join('、')}`,
    });
  }

  return errors;
}

/**
 * 预览导入数据
 * @param {string} filePath - Excel 文件路径
 * @param {string} type - 导入类型（apple_ids 或 recipients）
 * @returns {Object} 预览结果
 */
function previewImportData(filePath, type) {
  try {
    const parsedData = parseExcelFile(filePath, type);
    const validateFn = type === 'apple_ids' ? validateAppleId : validateRecipient;

    const preview = parsedData.map(item => {
      const errors = [...(item.issues || []), ...validateFn(item.data)];
      return {
        rowNumber: item.rowNumber,
        sheetName: item.sheetName,
        data: item.data,
        errors,
      };
    });

    const validCount = preview.filter(item => item.errors.length === 0).length;
    const invalidCount = preview.length - validCount;

    return {
      preview,
      summary: {
        total: preview.length,
        valid: validCount,
        invalid: invalidCount,
      },
    };
  } catch (error) {
    logger.error('预览导入数据失败', { type, error: error.message });
    throw error;
  }
}

module.exports = {
  parseExcelFile,
  validateAppleId,
  validateRecipient,
  previewImportData,
};
