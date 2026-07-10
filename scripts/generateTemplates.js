const XLSX = require('xlsx');
const path = require('path');

/**
 * 生成 Excel 导入模板
 */
function generateTemplates() {
  // Apple IDs 模板
  const appleIdsData = [
    [
      'Apple ID',
      '密码',
      '国家地区',
      '密保问题1',
      '密保答案1',
      '密保问题2',
      '密保答案2',
      '密保问题3',
      '密保答案3',
    ],
    [
      'lajavve036@hotmail.com',
      'NdMH5943',
      '美国',
      '朋友',
      'Aa64',
      '工作',
      '136',
      '父母',
      '142',
    ],
    [
      'test123@gmail.com',
      'Pass@2024',
      '中国',
      '朋友',
      'john',
      '工作',
      'teacher',
      '父母',
      'mary',
    ],
  ];

  const appleIdsWorkbook = XLSX.utils.book_new();
  const appleIdsWorksheet = XLSX.utils.aoa_to_sheet(appleIdsData);
  XLSX.utils.book_append_sheet(appleIdsWorkbook, appleIdsWorksheet, 'Apple IDs');
  XLSX.writeFile(
    appleIdsWorkbook,
    path.join(__dirname, '../templates/apple_ids_import_template.xlsx')
  );

  // Recipients 模板
  const recipientsData = [
    [
      '姓',
      '名',
      '身份证号',
      '标签',
    ],
    [
      '李',
      '浩',
      '431225199301151815',
      '刘天佟 微信',
    ],
    [
      '张',
      '三',
      '110101199001011234',
      '群华华 微信',
    ],
  ];

  const recipientsWorkbook = XLSX.utils.book_new();
  const recipientsWorksheet = XLSX.utils.aoa_to_sheet(recipientsData);
  XLSX.utils.book_append_sheet(recipientsWorkbook, recipientsWorksheet, 'Recipients');
  XLSX.writeFile(
    recipientsWorkbook,
    path.join(__dirname, '../templates/recipients_import_template.xlsx')
  );

  console.log('✅ Excel 模板生成成功');
  console.log('  - templates/apple_ids_import_template.xlsx');
  console.log('  - templates/recipients_import_template.xlsx');
}

// 执行生成
generateTemplates();
