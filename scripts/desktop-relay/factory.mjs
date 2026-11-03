import { randomUUID } from 'node:crypto';

const WORKSPACE = 'D:/Programs/AgentRelay/desktop-workspace';
const q = JSON.stringify;
const METHODS = new Set(['initialize_session', 'load_session', 'list_opened_sessions',
  'get_session_turn_outcome', 'add_user_message']);

/** Uses the live desktop's preload bridge and daemon, never a separate Droid CLI. */
export class FactoryDesktop {
  constructor(transport, sessionId) { this.transport = transport; this.sessionId = sessionId; }

  async call(method, params, requestId = randomUUID()) {
    if (!METHODS.has(method)) throw new Error('Unsupported Factory native method');
    return this.transport.evaluate(`(async()=>{
      const channel=electronAPI.daemon;
      if(!await channel.isAvailable())throw Error('Factory native daemon unavailable');
      const method=${q(method)}, params=${q(params)}, id=${q(requestId)};
      if(method==='initialize_session'||method==='load_session'){
        const auth=await electronAPI.auth.getAuthData();
        if(!auth.accessToken)throw Error('Factory desktop is not signed in');
        params.token=auth.accessToken;
      }
      return new Promise((resolve,reject)=>{
        let unsubscribe=()=>{};
        const timer=setTimeout(()=>{unsubscribe();reject(Error('Factory IPC timed out; inspect state before retrying'));},45000);
        const finish=()=>{clearTimeout(timer);unsubscribe();};
        unsubscribe=channel.onMessage(raw=>{
          let message;try{message=JSON.parse(raw);}catch{return;}
          if(message.type!=='response'||message.id!==id)return;
          finish();
          if(message.error){reject(Error('Factory native RPC failed: '+message.error.code));return;}
          resolve(message.result);
        });
        channel.sendMessage(JSON.stringify({type:'request',jsonrpc:'2.0',factoryApiVersion:'1.0.0',
          factoryProtocolVersion:'1.291.0',id,method:'daemon.'+method,params})).catch(()=>{
            finish();reject(Error('Factory IPC submission failed; inspect state before retrying'));
          });
      });
    })()`);
  }

  async createSession() {
    const sessionId = randomUUID();
    const result = await this.call('initialize_session', {
      machineId: 'local', cwd: WORKSPACE, sessionId, title: 'Relay 专用 · Factory',
      interactionMode: 'auto', autonomyLevel: 'off', autoRejectPermissionRequests: true,
      mcpServers: [],
    });
    if (result?.sessionId !== sessionId) throw new Error('Factory session identity mismatch');
    this.sessionId = sessionId;
    return { sessionId, title: 'Relay 专用 · Factory', transport: 'local' };
  }

  async submit(sessionId, text, requestId = randomUUID()) {
    if (sessionId !== this.sessionId) throw new Error('Dedicated Factory session mismatch');
    let opened = await this.call('list_opened_sessions', {});
    if (!opened.sessions?.some(s => s.sessionId === sessionId)) {
      await this.call('load_session', { sessionId });
      opened = await this.call('list_opened_sessions', {});
    }
    const session = opened.sessions?.find(s => s.sessionId === sessionId);
    if (session?.cwd?.replaceAll('\\', '/') !== WORKSPACE) throw new Error('Dedicated Factory workspace mismatch');
    if (session.workingState !== 'idle') throw new Error('Factory session is busy');
    await this.call('add_user_message', { sessionId, messageId: requestId, text }, requestId);
    return { accepted: true, requestId };
  }

  async poll(sessionId, requestId) {
    if (sessionId !== this.sessionId) throw new Error('Dedicated Factory session mismatch');
    const result = await this.call('get_session_turn_outcome', { sessionId, turnId: requestId, timeoutMs: 1000 });
    if (result?.sessionId !== sessionId || result?.turnId !== requestId) throw new Error('Factory turn identity mismatch');
    if (result.status !== 'available') return { sessionId, requestId, status: 'running', response: '' };
    if (result.outcome?.turnId !== requestId) throw new Error('Factory outcome identity mismatch');
    const reason = result.outcome.reason;
    return { sessionId, requestId, status: reason === 'completed' ? 'completed' : reason === 'cancelled' ? 'cancelled' : 'error',
      response: result.finalOutput ?? '', nativeReason: reason };
  }
}
