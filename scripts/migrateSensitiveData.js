#!/usr/bin/env node

/**
 * 将存量敏感字段转换为应用密文。默认仅统计，传入 --execute 才写入。
 */

require('dotenv').config();

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../src/models');
const logger = require('../src/utils/logger');
const {
  encrypt,
  decrypt,
  blindIndex,
  encryptJson,
  isEncrypted,
} = require('../src/utils/fieldEncryption');

async function migrateRows(transaction) {
  const appleIds = await sequelize.query('SELECT id, password, security_qa FROM apple_ids', {
    type: QueryTypes.SELECT,
    transaction,
  });
  for (const row of appleIds) {
    const securityQa = row.security_qa?.__encrypted
      ? row.security_qa
      : encryptJson(row.security_qa);
    await sequelize.query(
      'UPDATE apple_ids SET password = :password, security_qa = :securityQa WHERE id = :id',
      {
        replacements: {
          id: row.id,
          password: encrypt(row.password),
          securityQa: securityQa ? JSON.stringify(securityQa) : null,
        },
        type: QueryTypes.UPDATE,
        transaction,
      }
    );
  }

  const recipients = await sequelize.query('SELECT id, id_card_number, password FROM recipients', {
    type: QueryTypes.SELECT,
    transaction,
  });
  for (const row of recipients) {
    const plaintextIdCard = isEncrypted(row.id_card_number)
      ? decrypt(row.id_card_number)
      : row.id_card_number;
    await sequelize.query(
      `UPDATE recipients
       SET id_card_number = :idCardNumber,
           id_card_last4 = :idCardLast4,
           id_card_hash = :idCardHash,
           password = :password
       WHERE id = :id`,
      {
        replacements: {
          id: row.id,
          idCardNumber: encrypt(plaintextIdCard),
          idCardLast4: plaintextIdCard.slice(-4),
          idCardHash: blindIndex(plaintextIdCard),
          password: row.password ? encrypt(row.password) : null,
        },
        type: QueryTypes.UPDATE,
        transaction,
      }
    );
  }

  const orders = await sequelize.query('SELECT id, apple_password, recipient_id_card FROM orders', {
    type: QueryTypes.SELECT,
    transaction,
  });
  for (const row of orders) {
    await sequelize.query(
      `UPDATE orders
       SET apple_password = :applePassword, recipient_id_card = :recipientIdCard
       WHERE id = :id`,
      {
        replacements: {
          id: row.id,
          applePassword: row.apple_password ? encrypt(row.apple_password) : null,
          recipientIdCard: row.recipient_id_card ? encrypt(row.recipient_id_card) : null,
        },
        type: QueryTypes.UPDATE,
        transaction,
      }
    );
  }

  const emailLogs = await sequelize.query('SELECT id, raw_content, parsed_data FROM email_logs', {
    type: QueryTypes.SELECT,
    transaction,
  });
  for (const row of emailLogs) {
    const parsedData = row.parsed_data?.__encrypted
      ? row.parsed_data
      : encryptJson(row.parsed_data);
    await sequelize.query(
      `UPDATE email_logs
       SET raw_content = :rawContent, parsed_data = :parsedData
       WHERE id = :id`,
      {
        replacements: {
          id: row.id,
          rawContent: row.raw_content ? encrypt(row.raw_content) : null,
          parsedData: parsedData ? JSON.stringify(parsedData) : null,
        },
        type: QueryTypes.UPDATE,
        transaction,
      }
    );
  }

  return {
    appleIds: appleIds.length,
    recipients: recipients.length,
    orders: orders.length,
    emailLogs: emailLogs.length,
  };
}

async function main() {
  try {
    await sequelize.authenticate();
    const execute = process.argv.includes('--execute');
    if (!execute) {
      const counts = {};
      for (const table of ['apple_ids', 'recipients', 'orders', 'email_logs']) {
        const [row] = await sequelize.query(`SELECT COUNT(*)::int AS count FROM ${table}`, {
          type: QueryTypes.SELECT,
        });
        counts[table] = row.count;
      }
      logger.info('敏感数据迁移预检完成，未写入', { counts });
      return;
    }

    const result = await sequelize.transaction(migrateRows);
    logger.info('敏感数据迁移完成', result);
  } catch (error) {
    logger.error('敏感数据迁移失败', { error: error.message, stack: error.stack });
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

main();
