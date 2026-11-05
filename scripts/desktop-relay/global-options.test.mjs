import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionBindingKey } from './global-options.mjs';

test('PowerShell JSON key order does not split the same project/model into new sessions', () => {
  const a={providerId:'p',modelId:'m',options:{reasoningLevel:'max'}};
  const b={options:{reasoningLevel:'max'},modelId:'m',providerId:'p'};
  assert.equal(sessionBindingKey('zcode','G:\\Code\\Project',a),sessionBindingKey('zcode','g:/code/project',b));
  assert.notEqual(sessionBindingKey('zcode','g:/other',a),sessionBindingKey('zcode','g:/code/project',a));
  assert.notEqual(sessionBindingKey('zcode','g:/code/project',a),sessionBindingKey('zcode','g:/code/project',{...a,modelId:'other'}));
});
