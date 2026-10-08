const isolatedTest =
  process.env.DB_NAME === 'receipt_binding_test' &&
  process.env.DB_HOST === 'receipt-binding-test-db'
    ? test
    : test.skip;
isolatedTest('同版 PostgreSQL 验证整单事务、幂等、权限、冲突与未知提交屏障', async () => {
  try {
    const { runReceiptBindingAcceptance } = require('../scripts/testOfficialReceiptBinding');
    await expect(runReceiptBindingAcceptance()).resolves.toMatchObject({
      outcome: 'PASSED',
      realPostgres: true,
      productionData: false,
    });
  } catch (error) {
    error.component = 'receiptDatabaseAcceptance';
    throw error;
  }
});
