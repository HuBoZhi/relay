import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ZCodeDesktop } from './native-clients.mjs';

// CDP is the external boundary. Emulate changed bundle and minified names,
// including Chrome's error-object response when an obsolete import fails.
function renderer({ importError = false, registry = true, source = 'import { renamed } from "./styles-current.js";' } = {}) {
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
        if (params.arguments?.length) { this.calls.push(params.arguments.map(x => x.value)); return { result: { value: { status: 'idle' } } }; }
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

test('reports a failed import before trying to inspect an error as a function', async () => {
  await assert.rejects(new ZCodeDesktop(renderer({ importError: true })).initialize(), /service module unavailable/);
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
