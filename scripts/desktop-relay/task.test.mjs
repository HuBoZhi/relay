import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTask, completedTask } from './task.mjs';

test('Markdown task text stays intact and is distinct from a readiness probe', () => {
  const text = '# 任务\n请只读分析，不修改文件。';
  const task = prepareTask(text, 'nonce');
  assert.equal(task.input.task, text);
  assert.equal(task.expected, null);
  assert.equal(completedTask({ status: 'completed', response: '已分析' }, task.expected), true);
  assert.equal(completedTask({ status: 'completed', response: '' }, task.expected), false);
  assert.equal(completedTask({ status: 'error', response: '错误' }, task.expected), false);
});

test('readiness requires the current nonce, not an older response', () => {
  const task = prepareTask(undefined, 'current');
  assert.equal(completedTask({ status: 'completed', response: task.expected }, task.expected), true);
  assert.equal(completedTask({ status: 'completed', response: 'RELAY_DESKTOP_old:437' }, task.expected), false);
  assert.throws(() => prepareTask('', 'nonce'), /empty/);
});
