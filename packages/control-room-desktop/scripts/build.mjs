/**
 * Build the desktop app: one server bundle, the web assets, and the icons.
 *
 * Everything the packaged app reads at runtime lands in `dist/` (server bundle
 * plus `web/`), which is also why `electron-builder` only has to ship `dist/`,
 * `lib/`, `main.mjs`, and `assets/`.
 */

import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const CONTROL_ROOM = join(PACKAGE_ROOT, '..', 'control-room');
const DIST = join(PACKAGE_ROOT, 'dist');
const ASSETS = join(PACKAGE_ROOT, 'assets');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureControlRoom() {
  if (await exists(join(CONTROL_ROOM, 'dist', 'index.js'))) return;
  console.log('· 控制中心尚未编译，先执行 tsc');
  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-p', CONTROL_ROOM], {
    cwd: PACKAGE_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw new Error('控制中心编译失败，请先运行 npm run build:core');
}

async function ensureIcons() {
  if (await exists(join(ASSETS, 'icon.ico'))) return;
  console.log('· 图标缺失，正在生成');
  const result = spawnSync(process.execPath, [join(HERE, 'make-icons.mjs')], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('图标生成失败');
}

async function main() {
  await ensureControlRoom();
  await ensureIcons();

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const result = await build({
    entryPoints: [join(PACKAGE_ROOT, 'src', 'server-entry.mjs')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: join(DIST, 'server.mjs'),
    // Electron's main process is ESM already; the bundle only needs Node builtins.
    external: ['electron'],
    legalComments: 'none',
    logLevel: 'warning',
    banner: {
      js: '// 由 scripts/build.mjs 生成：控制中心服务端打包产物，请勿手工修改。',
    },
  });
  if (result.errors.length > 0) throw new Error('服务端打包失败');

  await cp(join(CONTROL_ROOM, 'web'), join(DIST, 'web'), { recursive: true });
  // The prototype-only licence file is not part of the runtime.
  await rm(join(DIST, 'web', 'LUCIDE-LICENSE.txt'), { force: true });

  const size = (await stat(join(DIST, 'server.mjs'))).size;
  console.log(`· 服务端打包完成 ${(size / 1024).toFixed(0)} KB`);
  console.log('· 界面资源已复制到 dist/web');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
