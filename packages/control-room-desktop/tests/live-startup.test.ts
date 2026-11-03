import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRoom } from '../lib/room-service.mjs';
import { observerConnectionUrl } from '../lib/observer-websocket.mjs';

describe('desktop live startup',()=>{
  it('uses the hosted WS authentication contract only for a read-only token',()=>{
    const url='wss://cast.agentrelay.com/v1/ws';
    expect(new URL(observerConnectionUrl(url,{headers:{authorization:'Bearer ot_live_fixture'}})).searchParams.get('token')).toBe('ot_live_fixture');
    expect(new URL(observerConnectionUrl(url,{headers:{authorization:'Bearer rk_live_admin'}})).search).toBe('');
    expect(new URL(observerConnectionUrl('ws://127.0.0.1:8787/v1/ws',{headers:{authorization:'Bearer ot_live_fixture'}})).search).toBe('');
  });
  it('uses a cached read-only stream credential and a Node 20 compatible socket',async()=>{
    const root=await mkdtemp(join(tmpdir(),'relay-observer-test-'));
    const seen:any[]=[];let minted=0;
    class Source {target='fixture';constructor(options:any){seen.push(options)}async start(){}async close(){}}
    class Socket {}
    const server={RelayControlRoomSource:Source,ObserverWebSocket:Socket,
      async createObserverToken(){minted++;return {token:'ot_live_fixture',expiresAt:null}},
      async startControlRoom(){return {url:'http://127.0.0.1:4320',port:4320,async close(){}}}};
    const config={demo:false,token:'rk_live_fixture',profilePath:root,port:4320,host:'127.0.0.1',timezone:'Asia/Shanghai'};
    try{
      await (await startRoom({config,serverModule:server})).close();
      await (await startRoom({config,serverModule:server})).close();
      expect(minted).toBe(1);
      expect(seen[0].observerToken).toBe('ot_live_fixture');
      expect(seen[0].webSocketImpl).toBe(Socket);
      expect(seen[0].workspaceKey).toBe('rk_live_fixture');
    }finally{await rm(root,{recursive:true,force:true})}
  });
});
