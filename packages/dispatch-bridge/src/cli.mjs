#!/usr/bin/env node
/**
 * `relay-dispatch-bridge` — start the local bridge.
 *
 * It prints where it listens, which engine it reports to, and whether the client
 * adapter directory loaded. A bridge without an adapter still starts: it will say
 * "queued" instead of pretending to dispatch.
 */

import { describeConfig, resolveBridgeConfig, USAGE } from './config.mjs';
import { loadDrivers } from './drivers.mjs';
import { startBridge } from './server.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BridgeStore } from './store.mjs';

export async function main(argv = process.argv.slice(2)) {
  let config;
  try {
    config = resolveBridgeConfig({ argv });
  } catch (error) {
    console.error(error.message);
    console.error('使用 --help 查看可用参数。');
    process.exitCode = 1;
    return;
  }
  if (config.help) {
    console.log(USAGE);
    return;
  }

  const log = (message) => console.log(message);
  const store = new BridgeStore({ dir: config.dataDir, log });
  await store.open();

  const drivers = await loadDrivers(config.desktopNativeDir, { log });
  const bridge = await startBridge({ config, drivers, store, log });

  console.log('');
  console.log('  本机派发桥接已启动');
  console.log(`  地址：${bridge.url}`);
  console.log(`  ${describeConfig(config)}`);
  console.log(
    drivers.available
      ? '  客户端适配器：已加载'
      : `  客户端适配器：不可用（${drivers.reason}）；派发会停在已排队`
  );
  console.log('  只使用客户端本机 Runtime 接口，不模拟键鼠、不操作 DOM、不读取模型凭据。');
  console.log('');

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await bridge.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) void main();
