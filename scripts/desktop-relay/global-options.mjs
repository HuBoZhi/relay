import { createHash } from 'node:crypto';

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}

export function sessionBindingKey(client, workspace, model) {
  const canonical = JSON.stringify(ordered({ workspace: workspace.replaceAll('\\','/').toLowerCase(), model: model ?? null }));
  return client + ':' + createHash('sha256').update(canonical).digest('hex').slice(0,24);
}
