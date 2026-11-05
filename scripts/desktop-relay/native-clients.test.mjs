import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ZCodeDesktop } from './native-clients.mjs';
import { modelOptionsFor } from '../../packages/dispatch-bridge/src/drivers.mjs';

// CDP is the external boundary. Emulate changed bundle and minified names,
// including Chrome's error-object response when an obsolete import fails.
function renderer({ importError = false, registry = true, source = 'import { renamed } from "./styles-current.js";', serviceResult } = {}) {
  return {
    imports: [], calls: [],
    async evaluate(expression) {
      return vm.runInNewContext(expression, {
        document: { scripts: [{ src: 'file:///D:/ZCode/out/renderer/assets/index-current.js' }] },
        location: { href: 'file:///D:/ZCode/out/renderer/index.html' }, URL,
        fetch: async () => ({ ok: true, text: async () => source }),
      });
    },
    async request(method, params) {
      if (method === 'Runtime.releaseObject') return {};
      if (method === 'Runtime.evaluate') {
        this.imports.push(params.expression);
        if (importError || params.expression.includes('styles-CQuzX8si')) {
          return { result: { type: 'object', subtype: 'error', objectId: 'error' }, exceptionDetails: { text: 'Uncaught' } };
        }
        return { result: { type: 'function', objectId: 'export' } };
      }
      if (method === 'Runtime.getProperties') {
        if (params.objectId === 'export') return { internalProperties: [{ name: '[[Scopes]]', value: { objectId: 'scopes' } }] };
        if (params.objectId === 'scopes') return { result: [{ name: '0', value: { objectId: 'module', description: 'Module' } }] };
        if (params.objectId === 'module') return { result: [
          { name: 'unrelated', value: { type: 'function', objectId: 'other' } },
          { name: 'renamedStore', value: { type: 'function', objectId: 'store' } },
        ] };
      }
      if (method === 'Runtime.callFunctionOn') {
        if (params.arguments?.length) {
          const args = params.arguments.map(x => x.value);
          this.calls.push(args);
          return { result: { value: serviceResult ? serviceResult(...args) : { status: 'idle' } } };
        }
        return { result: { value: registry && params.objectId === 'store' } };
      }
      throw Error(`Unexpected CDP request: ${method} ${params.objectId}`);
    },
  };
}

test('reads the existing desktop service after bundle, export and store names change', async () => {
  const transport = renderer();
  const desktop = new ZCodeDesktop(transport);
  assert.deepEqual(await desktop.call('zcodeAgentService', 'readSession', { sessionId: 'existing' }), { status: 'idle' });
  assert.match(transport.imports[0], /styles-current/);
  assert.deepEqual(transport.calls, [['zcodeAgentService', 'readSession', { sessionId: 'existing' }]]);
});

test('creates a task in its existing desktop project using that project root and execution mode', async () => {
  const root = 'G:\\Coding\\Gitee\\MediaDock';
  const transport = renderer({ serviceResult: (service, method) => {
    if (method === 'readProjects') return [{ id: 'project-media', hostId: 'local', roots: [{ rootPath: root }] }];
    if (method === 'createTask') return { taskId: 'new-task' };
    if (method === 'moveTask') return undefined;
    throw Error('Unexpected service call: ' + method);
  } });
  const desktop = new ZCodeDesktop(transport, null, { workspace: 'G:/Coding/Gitee/MediaDock' });
  assert.equal((await desktop.createSession()).sessionId, 'new-task');
  const create = transport.calls.find(c => c[1] === 'createTask')[2];
  assert.equal(create.workspacePath, root);
  assert.equal(create.mode, 'build');
  const move = transport.calls.find(c => c[1] === 'moveTask')[2];
  assert.equal(move.projectId, 'project-media');
  assert.equal(move.task.workspacePath, root);
  assert.equal(move.addMissingRoot, undefined);
});

test('reports a failed import before trying to inspect an error as a function', async () => {
  await assert.rejects(new ZCodeDesktop(renderer({ importError: true })).initialize(), /service module unavailable/);
});

test('dispatches a new GLM task with the native provider returned by ZCode', async () => {
  const workspace = 'G:\\Coding\\Gitlab\\空白';
  const model = modelOptionsFor('zcode', {
    account: 'BigModel', provider: 'zhipu', modelId: 'GLM-5.3', reasoning: 'max',
  });
  const transport = renderer({ serviceResult: (_service, method) => {
    if (method === 'readProjects') return [];
    if (method === 'createTask') return { taskId: 'new-task' };
    if (method === 'readSession') return { session: {
      workspace: { workspacePath: workspace }, status: 'idle',
      model: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3' },
    }, messages: [] };
    if (method === 'sendPrompt') return undefined;
    throw Error('Unexpected service call: ' + method);
  } });
  const desktop = new ZCodeDesktop(transport, null, { workspace, model });
  const { sessionId } = await desktop.createSession();
  assert.equal((await desktop.submit(sessionId, '你好', 'request')).accepted, true);
  assert.deepEqual(transport.calls.find(c => c[1] === 'createTask')[2].modelSelection, model);
  assert.equal(transport.calls.filter(c => c[1] === 'sendPrompt').length, 1);

  desktop.model = { ...model, modelId: 'GLM-5.3-Flash' };
  await assert.rejects(desktop.submit(sessionId, 'wrong model', 'other'), /model mismatch/);
  assert.equal(transport.calls.filter(c => c[1] === 'sendPrompt').length, 1);
});

test('fails closed when the current module has no connected desktop services', async () => {
  await assert.rejects(new ZCodeDesktop(renderer({ registry: false })).initialize(), /connected service registry unavailable/);
});

test('rejects ambiguous current service modules before importing or submitting a task', async () => {
  const transport = renderer({ source: 'import "./styles-one.js"; import "./styles-two.js";' });
  await assert.rejects(new ZCodeDesktop(transport).initialize(), /Unsupported ZCode service module/);
  assert.equal(transport.imports.length, 0);
  assert.equal(transport.calls.length, 0);
});

function turnSnapshot({ pending = [], interrupted = false } = {}) {
  return {
    session: { status: interrupted ? 'idle' : 'running', title: 'User task name' },
    runtime: { pendingRequestIds: pending },
    messages: [
      { info: { messageId: 'user', metadata: { inputIntent: { sourceCommandId: 'request' } } } },
      { info: { messageId: 'answer', parentMessageId: 'user', role: 'assistant' }, parts: [{ type: 'text', text: 'Here is my plan' }] },
      ...(interrupted ? [{ info: { messageId: 'interrupt', metadata: { runtimeMessage: { source: 'interrupt_marker' } } } }] : []),
    ],
  };
}

test('surfaces pending confirmation instead of claiming active development', async () => {
  const desktop = new ZCodeDesktop(renderer({ serviceResult: () => turnSnapshot({ pending: ['perm_approval'] }) }));
  const result = await desktop.poll('task', 'request');
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'desktop_confirmation_required');
});

test('does not report a plan followed by interruption as completed or replace its title', async () => {
  const transport = renderer({ serviceResult: () => turnSnapshot({ interrupted: true }) });
  const result = await new ZCodeDesktop(transport).poll('task', 'request');
  assert.equal(result.status, 'cancelled');
  assert.ok(transport.calls.every(c => c[1] !== 'renameTask'));
});
