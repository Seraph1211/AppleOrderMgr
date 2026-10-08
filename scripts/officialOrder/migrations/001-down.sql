-- 仅在明确放弃独立采集状态时手动回滚；先备份冷却及尝试记录。
-- 保留此前研究的 runs/budget 原始台账，禁止通过回滚重置预算。
BEGIN;
DROP TABLE collector_pauses;
DROP TABLE collector_attempts;
DELETE FROM collector_migrations WHERE version=1;
COMMIT;
