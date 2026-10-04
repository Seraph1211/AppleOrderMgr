const { Client } = require('pg');
const {
  readOfficialOrderInput,
  readOfficialOrderGroupInput,
  officialInputErrorCode,
} = require('/app/src/services/officialOrderInput');

/** 在既有 API 容器内只读提取一单，stdout 必须直接写服务器私密文件。 */
async function main() {
  let client;
  try {
    client = new Client({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    await client.connect();
    let input;
    if (process.env.OFFICIAL_ACCOUNT_GROUP) {
      input = await readOfficialOrderGroupInput(
        client,
        process.env.OFFICIAL_ACCOUNT_GROUP,
        process.env.OFFICIAL_GROUP_LEASE
      );
    } else {
      input = { samples: [await readOfficialOrderInput(client, process.env.OFFICIAL_ORDER_ID)] };
    }
    process.stdout.write(JSON.stringify({ capturedAt: new Date().toISOString(), ...input }));
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ outcome: officialInputErrorCode(error), stage: 'input' })}\n`
    );
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

main();
