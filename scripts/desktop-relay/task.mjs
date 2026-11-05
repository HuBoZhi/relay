export function prepareTask(text, nonce) {
  if (text !== undefined && (typeof text !== 'string' || !text.trim() || text.length > 16_000)) {
    throw new Error('Task is empty or exceeds 16000 characters');
  }
  const expected = text === undefined ? `RELAY_DESKTOP_${nonce}:437` : null;
  return { input: { requestNonce: nonce, task: text ??
    `这是用户授权的 Relay 桌面接口联调。计算 19×23，只回复 ${expected}。不要调用任何工具，不读写文件，不启动子代理。` }, expected };
}

export function completedTask(result, expected) {
  return result?.status === 'completed' && typeof result.response === 'string' &&
    !!result.response.trim() && (expected === null || result.response.trim() === expected);
}
