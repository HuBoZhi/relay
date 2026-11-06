import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';

/** Bootstrap the user's unified clients after the GUI is ready, without owning it. */
export function startSystemClients(config, { consoleDir, env = process.env, log = console.log } = {}) {
  if (!config.systemLauncher || !config.workspaceStateFile || process.platform !== 'win32') return;
  const child = spawn(join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', config.systemLauncher,
    '-RuntimeRoot', dirname(dirname(config.workspaceStateFile)), '-ConsoleDir', consoleDir, '-Background', '-ClientsOnly',
  ], { env, windowsHide: true, stdio: 'ignore' });
  child.on('error', (error) => log(`[启动] 客户端启动失败：${error.message}`));
  child.on('exit', (code) => { if (code) log(`[启动] 客户端启动脚本退出：${code}`); });
  child.unref();
  return child;
}
