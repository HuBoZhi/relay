/** Apply the small Windows/storage patch to the upstream MIT-licensed zcode-mcp. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] || 'D:/Programs/AgentRelay/zcode-mcp');
if (/^C:/i.test(root)) throw new Error('Use a non-C installation');
const file = join(root, 'src/protocol.ts');
let source = await readFile(file, 'utf8');
if (!source.includes('RELAY_WINDOWS_STORAGE_PATCH')) {
  const start = source.indexOf('  private prepareEntryLink(): string {');
  const end = source.indexOf('\n  /** Start the app-server child', start);
  if (start < 0 || end < start || !source.includes('fork("zcode-entry.cjs"')) throw new Error('Unsupported upstream source; review before patching');
  source = source.replace('import { dirname, join } from "node:path";', 'import { dirname, join, isAbsolute } from "node:path";');
  source = source.slice(0, source.indexOf('  private prepareEntryLink(): string {')) + `  // RELAY_WINDOWS_STORAGE_PATCH: no symlinks, no task writes to the user's C-drive home.
  private prepareEntryLink(): string {
    const binary = realpathSync(this.binPath);
    if (!isAbsolute(binary) || !binary.endsWith('.cjs')) throw new Error('Invalid ZCODE_BIN');
    const dir = process.env.ZCODE_MCP_STATE_DIR;
    if (!dir || !isAbsolute(dir) || /^C:/i.test(dir)) throw new Error('Set ZCODE_MCP_STATE_DIR to a non-C absolute path');
    mkdirSync(dir, {recursive:true});
    return dir;
  }
` + source.slice(source.indexOf('\n  /** Start the app-server child', source.indexOf('  private prepareEntryLink(): string {')));
  source = source.replace('fork("zcode-entry.cjs",', 'fork(realpathSync(this.binPath),');
  source = source.replace('stdio: ["pipe", "pipe", "pipe", "ipc"],', 'stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true,');
  source = source.replace('if (!env.HTTPS_PROXY && env.ZCODE_MCP_AUTO_PROXY !== "0")', 'if (platform() === "darwin" && !env.HTTPS_PROXY && env.ZCODE_MCP_AUTO_PROXY !== "0")');
  await writeFile(file, source);
  const indexFile = join(root, 'src/index.ts');
  let index = await readFile(indexFile, 'utf8');
  index = index.replace('models = cachedModels.get(cwd) ?? [];', 'models = cachedModels.get(cwd) ?? (await c.createSession(cwd, "plan")).models;');
  // Closing the owning bridge must also close the app-server on Windows.
  index = index.replace('await server.connect(transport);', 'await server.connect(transport);\n  transport.onclose = () => { void client?.stop().finally(() => process.exit(0)); if (!client) process.exit(0); };');
  await writeFile(indexFile, index);
}
source = await readFile(file, 'utf8');
if (!source.includes('RELAY_WORKER_REVISION')) {
  source = source.replace('  private readBuiltinRevision(): string {', `  private readBuiltinRevision(): string {
    // RELAY_WORKER_REVISION: the isolated worker can have a different provider hash than the desktop.
    try {
      const dir = process.env.ZCODE_LOG_DIR;
      if (dir) {
        for (const file of readdirSync(dir).filter(f => /\\.(log|jsonl)$/.test(f)).sort().reverse()) {
          const lines = readFileSync(join(dir,file),'utf8').split('\\n').reverse();
          for (const line of lines) {
            try {
              const item = JSON.parse(line);
              if (item.event !== 'zcode_protocol.provider_registry.ready') continue;
              const marker = String(item.context?.accountRevision).match(/zcode-builtin:\\d+:[a-f0-9]{64}/);
              if (marker) return marker[0];
            } catch {}
          }
        }
      }
    } catch {}
`);
  await writeFile(file, source);
}
console.log('zcode-mcp Windows/storage compatibility patch ready');
