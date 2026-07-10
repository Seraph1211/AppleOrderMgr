const XLSX = require('xlsx');
const logger = require('../utils/logger');
const { isValidEmail, isValidPhone, isValidIdCard } = require('../utils/helpers');

/**
 * 列名到字段名的映射
 */
const COLUMN_MAPPING = {
  apple_ids: {
    'Apple ID': 'appleId',
    '密码': 'password',
    '备注名称': 'nickname',
    '国家地区': 'country',
    '是否已修改': 'isModified',
    '状态': 'status',
    '密保问题1': 'question1',
    '密保答案1': 'answer1',
    '密保问题2': 'question2',
    '密保答案2': 'answer2',
    '密保问题3': 'question3',
    '密保答案3': 'answer3',
  },
  recipients: {
    '姓': 'lastName',
    '名': 'firstName',
    '身份证号': 'idCardNumber',
    '手机号': 'phone',
    '邮箱': 'email',
    '省': 'province',
    '市': 'city',
    '区': 'district',
    '街道地址': 'streetAddress',
    '绑定 Apple ID': 'appleId',
    '标签': 'tag',
    '状态': 'status',
    '备注': 'notes',
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
    const sheetName = type === 'apple_ids' ? 'Apple IDs' : 'Recipients';
    const worksheet = workbook.Sheets[sheetName];

    if (!worksheet) {
      throw new Error(`工作表 "${sheetName}" 不存在`);
    }

    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    if (data.length < 2) {
      throw new Error('Excel 文件至少需要包含表头和一行数据');
    }

    const headers = data[0];
    const rows = data.slice(1);
    const mapping = COLUMN_MAPPING[type];

    const parsedData = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // 跳过空行
      if (row.every(cell => !cell && cell !== 0)) {
        continue;
      }

      const rowData = {};
      headers.forEach((header, colIndex) => {
        const fieldName = mapping[header];
        if (fieldName) {
          const cellValue = row[colIndex];
          rowData[fieldName] = cellValue === '' ? null : String(cellValue).trim();
        }
      });

      parsedData.push({
        rowNumber: i + 2,
        data: rowData,
      });
    }

    logger.info('Excel 文件解析成功', {
      type,
      sheetName,
      totalRows: parsedData.length,
    });

    return parsedData;
  } catch (error) {
    logger.error('Excel 文件解析失败', { type, error: error.message });
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

  if (data.status && !['active', 'inactive'].includes(data.status)) {
    errors.push({
      field: 'status',
      message: '状态必须是 active 或 inactive',
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
  } else if (data.lastName.length !== 1) {
    errors.push({ field: 'lastName', message: '姓氏必须是1个字符' });
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
  if (data.status && !['active', 'inactive'].includes(data.status)) {
    errors.push({
      field: 'status',
      message: '状态必须是 active 或 inactive',
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
      const errors = validateFn(item.data);
      return {
        rowNumber: item.rowNumber,
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
