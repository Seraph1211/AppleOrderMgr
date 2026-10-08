/** 库存正常采集的跨进程上限；请求速率另由数据库闸门控制。 */
module.exports = Object.freeze({ REQUEST_CONCURRENCY: 3, TASK_LEASE_MS: 90000 });
