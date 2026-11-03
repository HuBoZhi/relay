import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Keep the stream's read-only credential separate from the workspace admin key. */
export async function observerCredential(config, createToken) {
  if (config.token.startsWith('ot_live_')) return config.token;
  const fingerprint=createHash('sha256').update(config.token).digest('hex');
  const cacheFile=join(config.profilePath,'observer.private.json');
  try {
    const cache=JSON.parse(await readFile(cacheFile,'utf8'));
    if(cache.workspaceFingerprint===fingerprint && typeof cache.token==='string' && cache.token.startsWith('ot_live_') &&
      (!cache.expiresAt || Date.parse(cache.expiresAt)>Date.now()+60_000)) return cache.token;
  } catch { /* Missing/stale cache is replaced only after a successful mint. */ }
  const result=await createToken({workspaceKey:config.token,name:'control-room-'+Date.now(),
    description:'Local control room read-only realtime stream',filters:{includeDms:false},
    ...(config.baseUrl?{baseUrl:config.baseUrl}:{})});
  if(typeof result.token!=='string'||!result.token.startsWith('ot_live_')) throw new Error('Relay 未返回有效的只读观察凭据');
  await mkdir(config.profilePath,{recursive:true});
  await writeFile(cacheFile,JSON.stringify({workspaceFingerprint:fingerprint,token:result.token,expiresAt:result.expiresAt}),{mode:0o600});
  return result.token;
}
