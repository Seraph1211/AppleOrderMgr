/** 库存台账的业务授权组合；底层权限码与服务端鉴权保持兼容。 */
const STOCK_PERMISSION_GROUPS = [
  {
    id: 'view',
    label: '库存查看',
    description: '查看 SN、规格、仓库及在库／已售状态，不含敏感金额。',
    options: [{ id: 'view', label: '可查看库存', codes: ['stock.read'] }],
  },
  {
    id: 'inventory',
    label: '库存管理',
    description:
      '入库、编辑实物、调整仓库及补来源关联。关联会同时授予订单查看、取货查看与登记，仍受订单 TAG 范围限制。',
    options: [
      {
        id: 'manage',
        label: '可管理库存',
        codes: ['stock.receive', 'stock.transfer', 'stock.source.link', 'orders.read'],
      },
    ],
  },
  {
    id: 'sales',
    label: '销售管理',
    description: '查看销售或登记售出、补录历史销售；不包含成本利润和货款登记。',
    options: [
      { id: 'read', label: '可查看销售', codes: ['stock.sales.read'] },
      {
        id: 'edit',
        label: '可登记销售',
        codes: ['stock.sales.edit', 'stock.sales.ship', 'stock.import'],
      },
    ],
  },
  {
    id: 'finance',
    label: '成本与利润',
    description: '成本、其他费用和毛利。查看毛利可推算成本；维护允许人工修改成本与费用。',
    options: [
      {
        id: 'read',
        label: '可查看成本与利润',
        codes: ['stock.cost.read', 'stock.expenses.read', 'stock.profit.read'],
      },
      {
        id: 'edit',
        label: '可维护成本与费用',
        codes: ['stock.cost.edit', 'stock.expenses.edit', 'stock.profit.read'],
      },
    ],
  },
  {
    id: 'payments',
    label: '货款管理',
    description:
      '客户付款、代收待转回及公司到账。两种资金事实分别记账；特殊分工可在细分配置中设置。',
    options: [
      { id: 'read', label: '可查看货款', codes: ['stock.collections.read', 'stock.receipts.read'] },
      { id: 'edit', label: '可登记货款', codes: ['stock.collections.edit', 'stock.receipts.edit'] },
    ],
  },
  {
    id: 'advanced',
    label: '高级管理',
    description: '按需授权。更正还需相应业务操作权限；误售恢复涉及库存、销售、费用及货款权限。',
    options: [
      { id: 'catalog', label: '维护基础资料', codes: ['stock.catalog.manage'] },
      { id: 'correct', label: '更正已生效记录', codes: ['stock.correct'] },
      { id: 'import', label: '导入资料', codes: ['stock.import'] },
      { id: 'export', label: '导出授权数据', codes: ['stock.export'] },
    ],
  },
];

/** 返回独立副本，避免调用方修改共享授权组合。 @returns {Object[]} 库存业务分组 */
function getStockPermissionGroups() {
  return JSON.parse(JSON.stringify(STOCK_PERMISSION_GROUPS));
}
module.exports = { getStockPermissionGroups };
