const service = require('../services/officialOrderRefreshService');
const { sequelize } = require('../models');
const MAX_INPUT_BYTES = 16777216;

/** 仅宿主机固定执行器使用；无 HTTP 完成接口，不接受浏览器提交官网结果。 */
async function main() {
  try {
    let result;
    if (process.argv[2] === 'claim-http') result = await service.claimHttp();
    else if (process.argv[2] === 'claim') result = await service.claim();
    else if (['finish', 'finish-group'].includes(process.argv[2])) {
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
      }
      result = await (process.argv[2] === 'finish-group' ? service.finishGroup : service.finish)(
        JSON.parse(input)
      );
    } else throw new Error('COMMAND_INVALID');
    process.stdout.write(`OFFICIAL_QUEUE_RESULT=${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`OFFICIAL_QUEUE_ERROR=${error.code || 'COMMAND_FAILED'}\n`);
    process.exitCode = 1;
  } finally {
    await sequelize.close().catch(() => {});
  }
}

main();
