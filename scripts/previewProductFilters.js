const { buildProductFilterItems, collectProductOptions } = require('../src/utils/productFilter');

/** 只读预览离线商品归组，不依赖新增字段、不输出订单身份或联系方式。 */
async function previewProductFilters(sequelize) {
  try {
    const [rows] = await sequelize.query(
      'SELECT products, source_snapshot AS "sourceSnapshot" FROM orders ORDER BY id'
    );
    const indexed = rows.map(row => ({
      ...row,
      productFilterItems: buildProductFilterItems(row.products, [], row.sourceSnapshot?.products),
    }));
    return {
      orderCount: rows.length,
      options: collectProductOptions(indexed),
      reviewItemCount: indexed
        .flatMap(row => row.productFilterItems)
        .filter(item => item.needsReview).length,
    };
  } catch (error) {
    throw new Error('商品筛选处理失败', { cause: error });
  }
}

if (require.main === module) {
  const { sequelize } = require('../src/models');
  previewProductFilters(sequelize)
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    })
    .finally(() => sequelize.close());
}

module.exports = { previewProductFilters };
