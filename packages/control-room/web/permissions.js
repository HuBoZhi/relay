/* ZCode's execution policy labels, shared by both dispatch entry points. */
'use strict';
window.RELAY_PERMISSION_MODES = [
  ['', '访问权限：连接默认'],
  ['plan', '计划模式'],
  ['build', '变更前确认'],
  ['edit', '自动编辑'],
  ['guarded', '自主模式'],
  ['yolo', '完全访问'],
];
window.relayPermissionLabel = mode => window.RELAY_PERMISSION_MODES.find(([value]) => value === mode)?.[1] || '连接默认';
