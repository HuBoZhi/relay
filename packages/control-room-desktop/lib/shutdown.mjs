/** Stop admission and owned children before flushing the persistent task store. */
export async function shutdownDesktop({ unsubscribe, room, bridge, engine, settingsUpdates }, timeoutMs = 5000) {
  let timer;
  const closing = (async () => {
    try { unsubscribe?.(); } catch {}
    const results = await Promise.allSettled([
      Promise.resolve().then(() => room?.close()),
      Promise.resolve().then(() => bridge?.stop()),
      settingsUpdates,
    ]);
    const engineResult = await Promise.allSettled([Promise.resolve().then(() => engine?.close())]);
    return { timedOut: false, errors: [...results, ...engineResult].filter((r) => r.status === 'rejected').map((r) => r.reason) };
  })();
  try {
    return await Promise.race([closing, new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true, errors: [] }), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
