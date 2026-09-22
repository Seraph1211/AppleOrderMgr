const { validateContact } = require('../src/services/mailContactService');
const { validateBatchForward } = require('../src/services/orderMailService');

describe('邮件联系人与批量收件人输入边界', () => {
  test('姓名去空白，邮箱规范化', () => {
    expect(validateContact({ name: ' 张三 ', email: ' USER@example.com ' })).toEqual({
      name: '张三',
      email: 'user@example.com',
    });
  });
  test.each([
    null,
    {},
    { name: '', email: 'a@example.com' },
    { name: 'a'.repeat(101), email: 'a@example.com' },
    { name: 'a\nb', email: 'a@example.com' },
    { name: 'a', email: 'one@example.com,two@example.com' },
    { name: 'a', email: 'A <a@example.com>' },
    { name: 'a', email: 'a@example.com\nBcc: x@example.com' },
  ])('拒绝无效联系人 %#', body => {
    expect(() => validateContact(body)).toThrow();
  });
  test('批量邮箱去重排序，同邮箱只排一个任务', () => {
    expect(
      validateBatchForward({
        recipients: ['B@example.com', ' a@example.com ', 'b@example.com'],
        idempotencyKey: 'batch-key-123456789',
      })
    ).toEqual({
      recipients: ['a@example.com', 'b@example.com'],
      note: '',
      idempotencyKey: 'batch-key-123456789',
    });
  });
  test.each([[], Array(51).fill('a@example.com'), ['invalid'], 'a@example.com', [null]])(
    '拒绝无效批量邮箱 %#',
    recipients => {
      expect(() =>
        validateBatchForward({ recipients, idempotencyKey: 'batch-key-123456789' })
      ).toThrow();
    }
  );
  test('备注及幂等键长度边界', () => {
    const body = {
      recipients: ['a@example.com'],
      idempotencyKey: 'a'.repeat(64),
      note: '字'.repeat(2000),
    };
    expect(validateBatchForward(body).note).toHaveLength(2000);
    expect(() => validateBatchForward({ ...body, note: '字'.repeat(2001) })).toThrow();
    expect(() => validateBatchForward({ ...body, idempotencyKey: 'a'.repeat(65) })).toThrow();
  });
});
