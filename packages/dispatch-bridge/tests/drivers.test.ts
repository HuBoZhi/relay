import { describe, expect, it } from 'vitest';

import { modelOptionsFor } from '../src/drivers.mjs';

describe('ZCode model selection', () => {
  it.each(['zhipu', 'BigModel', 'bigmodel'])('resolves the %s account alias to the desktop provider id', (provider) => {
    expect(modelOptionsFor('zcode', {
      account: 'BigModel', provider, modelId: 'GLM-5.3', reasoning: 'max',
    })).toEqual({
      providerId: 'account:bigmodel-individual-coding-plan',
      modelId: 'GLM-5.3', options: { reasoningLevel: 'max' },
    });
  });

  it('preserves explicit native and custom provider ids', () => {
    for (const provider of ['account:bigmodel-individual-coding-plan', 'custom-provider']) {
      expect(modelOptionsFor('zcode', { account: 'BigModel', provider, modelId: 'GLM-5.3' }).providerId).toBe(provider);
    }
  });

  it('resolves the account when no provider was supplied', () => {
    expect(modelOptionsFor('zcode', { account: 'BigModel', modelId: 'GLM-5.3' }).providerId)
      .toBe('account:bigmodel-individual-coding-plan');
  });
});
