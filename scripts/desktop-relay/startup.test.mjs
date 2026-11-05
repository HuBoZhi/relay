import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Factory launcher follows the highest complete version and always includes loopback Relay arguments', {skip:process.platform!=='win32'}, async () => {
  assert.match(tmpdir(), /^[DG]:/i);
  const root=await mkdtemp(join(tmpdir(),'factory-launch-test-'));
  try {
    for(const version of ['1.9.0','1.10.0','2.0.0']) await mkdir(join(root,'app-'+version));
    for(const version of ['1.9.0','1.10.0']) await writeFile(join(root,'app-'+version,'factory-desktop.exe'),'');
    const shell=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result=JSON.parse(execFileSync(shell,['-NoProfile','-File',fileURLToPath(new URL('./Start-RelayFactory.ps1',import.meta.url)),'-FactoryRoot',root,'-ResolveOnly'],{encoding:'utf8',windowsHide:true}));
    assert.equal(result.executable,join(root,'app-1.10.0','factory-desktop.exe'));
    assert.deepEqual(result.arguments,['--remote-debugging-port=19373','--remote-debugging-address=127.0.0.1']);
  } finally {await rm(root,{recursive:true,force:true});}
});
