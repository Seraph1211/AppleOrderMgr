import assert from 'node:assert/strict';
import test from 'node:test';
import { getVisibleNavigationGroups, isNavigationItemActive } from '../src/constants/navigation.js';

test('无权限人员没有业务分组；仅付款任务权限不暴露调度及管理员菜单', () => {
  assert.deepEqual(
    getVisibleNavigationGroups({ role: 'operator' }, () => false),
    []
  );
  const groups = getVisibleNavigationGroups(
    { role: 'operator' },
    permission => permission === 'payment_tasks.read_own'
  );
  assert.deepEqual(
    groups.map(group => group.name),
    ['付款管理']
  );
  assert.deepEqual(
    groups[0].children.map(item => item.name),
    ['付款任务']
  );
});
test('管理员专属菜单不因普通人员具有其他业务权限而可见', () => {
  const groups = getVisibleNavigationGroups({ role: 'operator' }, () => true);
  assert(!groups.flatMap(group => group.children).some(item => item.adminOnly));
  const admin = getVisibleNavigationGroups({ role: 'admin' }, () => true);
  assert.deepEqual(
    admin.map(group => group.name),
    ['订单与库存', '库存监控', '付款管理', '基础资料', '通知与邮件', '系统管理']
  );
  assert.deepEqual(
    admin[0].children.map(item => item.name),
    ['订单管理', '代抢管理', '取货记录', '自有库存']
  );
  assert.deepEqual(
    admin[5].children.map(item => item.name),
    ['公开报价', '订单数据源', '服务器监控', '日志查询', '操作记录', '用户管理']
  );
});
test('日志与服务器监控共享权限，操作记录保持独立权限', () => {
  const groups = getVisibleNavigationGroups(
    { role: 'operator' },
    permission => permission === 'monitor.manage'
  );
  assert.deepEqual(
    groups.flatMap(group => group.children).map(item => item.name),
    ['服务器监控', '日志查询']
  );
});
test('详情路径高亮归属菜单，监控父子入口不会同时选中', () => {
  const items = getVisibleNavigationGroups({ role: 'admin' }, () => true).flatMap(
    group => group.children
  );
  for (const [pathname, name] of [
    ['/orders/123', '订单管理'],
    ['/channels/tag/orders', '渠道管理'],
    ['/server-monitor/logs', '日志查询'],
    ['/inventory-monitor/manage', '监控管理'],
  ]) {
    assert.deepEqual(
      items.filter(item => isNavigationItemActive(item, pathname)).map(item => item.name),
      [name]
    );
  }
  assert.equal(isNavigationItemActive({ href: '/orders' }, '/orders-other'), false);
  assert.equal(isNavigationItemActive({ href: '/' }, '/orders'), false);
});
