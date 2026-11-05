import { randomUUID } from 'node:crypto';

const WORKSPACE = 'D:/Programs/AgentRelay/desktop-workspace';
const q = JSON.stringify;

export class WorkBuddyDesktop {
  constructor(transport, sessionId, options = {}) { this.transport = transport; this.sessionId = sessionId; this.workspace = options.workspace ?? WORKSPACE; this.model = options.model; }

  async createSession() {
    const result = await this.transport.evaluate(`(async()=>{
      const x=await wb.conversations.create({cwd:${q(this.workspace)},title:'Relay 专用 · WorkBuddy',
        transport:'local',conversationOrigin:'local',mode:'craft',permissionMode:'default'});
      if(x.errorCode)throw Error(x.errorCode);
      return {sessionId:x.info.id,title:x.info.title,transport:x.info.transport};
    })()`);
    if (!result?.sessionId || result.transport !== 'local') throw new Error('WorkBuddy did not create a local session');
    this.sessionId = result.sessionId;
    return result;
  }

  async submit(sessionId, text, requestId = randomUUID()) {
    if (sessionId !== this.sessionId) throw new Error('Dedicated session mismatch');
    return this.transport.evaluate(`(async()=>{
      const c=await wb.conversations.get(${q(sessionId)});
      if(!c||c.info.id!==${q(sessionId)}||c.info.transport!=='local'||c.info.space?.cwd?.replaceAll('\\\\','/')!==${q(this.workspace)})throw Error('Dedicated session mismatch');
      if(c.info.state!=='idle')throw Error('WorkBuddy session is busy');
      const id=${q(requestId)}, key=${q(sessionId)}+':'+id;
      const jobs=globalThis.__relayNativeJobs??=new Map();
      if(jobs.has(key))return {accepted:true,requestId:id,duplicate:true};
      jobs.set(key,{status:'running',sessionId:c.info.id,requestId:id});
      c.runPrompt([{type:'text',text:${q(text)}}],{clientRequestId:id}).then(result=>{
        jobs.set(key,{status:result.state,sessionId:c.info.id,requestId:id,
          nativeRequestId:result.requestId,response:(result.content??[]).filter(x=>x.type==='text').map(x=>x.text??'').join(String.fromCharCode(10))});
      },()=>jobs.set(key,{status:'error',sessionId:c.info.id,requestId:id}));
      return {accepted:true,requestId:id};
    })()`);
  }

  async poll(sessionId, requestId) {
    return this.transport.evaluate(`globalThis.__relayNativeJobs?.get(${q(sessionId + ':' + requestId)})??{status:'unknown'}`);
  }
}

/** Resolve the service already connected to the live desktop host, not a new app-server. */
export class ZCodeDesktop {
  constructor(transport, sessionId, options = {}) { this.transport = transport; this.sessionId = sessionId; this.workspace = options.workspace ?? WORKSPACE; this.model = options.model; }
  async initialize() {
    // Read only the renderer's script metadata. Asset hashes and minified export
    // names change on upgrades; never import a remembered build's module.
    const modulePath = await this.transport.evaluate(`(async () => {
      const entries = [...document.scripts].map(s => s.src).filter(src => {
        const url = new URL(src, location.href);
        return url.protocol === 'file:' && !url.host &&
          url.href.startsWith(new URL('./assets/', location.href).href) &&
          /^index-[\\w-]+\\.js$/.test(url.pathname.split('/').pop());
      });
      if (entries.length !== 1) throw Error('Unsupported ZCode renderer entry');
      const response = await fetch(entries[0]);
      if (!response.ok) throw Error('ZCode renderer entry unavailable');
      const source = await response.text();
      const matches = [...source.matchAll(/["'](\\.\\/styles-[\\w-]+\\.js)["']/g)];
      const paths = [...new Set(matches.map(m => './assets/' + m[1].slice(2)))];
      if (paths.length !== 1) throw Error('Unsupported ZCode service module');
      return paths[0];
    })()`);
    if (typeof modulePath !== 'string' || !/^\.\/assets\/styles-[\w-]+\.js$/.test(modulePath)) {
      throw new Error('Unsupported ZCode version: service module unavailable');
    }
    const fn = await this.transport.request('Runtime.evaluate', {
      expression: `import(${q(modulePath)}).then(m=>Object.values(m).find(x=>typeof x==='function'))`, awaitPromise: true,
    });
    if (fn.exceptionDetails || fn.result?.type !== 'function' || !fn.result?.objectId) {
      throw new Error('Unsupported ZCode version: service module unavailable');
    }
    const props = await this.transport.request('Runtime.getProperties', { objectId: fn.result.objectId });
    const scopesId = props.internalProperties?.find(p => p.name === '[[Scopes]]')?.value?.objectId;
    if (!scopesId) throw new Error('ZCode service module scopes unavailable');
    const scopes = await this.transport.request('Runtime.getProperties', { objectId: scopesId, ownProperties: true });
    for (const scope of scopes.result) {
      if (!scope.value?.objectId || scope.value.description !== 'Module') continue;
      const values = await this.transport.request('Runtime.getProperties', { objectId: scope.value.objectId, ownProperties: true });
      for (const property of values.result) {
        if (property.value?.type !== 'function' || !property.value.objectId) continue;
        const registry = property.value.objectId;
        const probe = await this.transport.request('Runtime.callFunctionOn', {
          objectId: registry,
          functionDeclaration: `function() {
            try {
              const getter = Object.getOwnPropertyDescriptor(this, 'getState')?.value;
              if (typeof getter !== 'function') return false;
              const services = getter().baseServices;
              return typeof services?.zcodeTaskService?.createTask === 'function' &&
                typeof services?.zcodeTaskService?.sendPrompt === 'function' &&
                typeof services?.zcodeAgentService?.readSession === 'function';
            } catch { return false; }
          }`, returnByValue: true,
        });
        if (!probe.exceptionDetails && probe.result?.value === true) { this.registry = registry; return; }
      }
    }
    throw new Error('Unsupported ZCode version: connected service registry unavailable');
  }

  async call(service, method, params) {
    if (!this.registry) await this.initialize();
    const result = await this.transport.request('Runtime.callFunctionOn', {
      objectId: this.registry,
      functionDeclaration: 'async function(service,method,params){return this.getState().baseServices[service][method](params)}',
      arguments: [service, method, params].map(value => ({ value })),
      awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown error';
      const message = description.split('\n')[0].slice(0,300).replace(/(?:Bearer\s+\S+|(?:rk|at|ot)_live_[\w-]+|sk-[\w-]+)/gi, '[REDACTED]');
      throw new Error('ZCode native IPC call failed: ' + message);
    }
    return result.result?.value;
  }

  /**
   * Projects the app already has configured.
   *
   * The id is an internal handle a person never types; the path is what they
   * actually know. Callers pick a path and carry the id along.
   */
  async listProjects() {
    const projects = await this.call('projectService', 'readProjects', {});
    if (!Array.isArray(projects)) return [];
    return projects
      .filter(project => !project.deleted && project.hostId === 'local')
      .map(project => ({
        id: project.id,
        name: project.name ?? project.roots?.[0]?.rootPath ?? project.id,
        path: project.roots?.[0]?.rootPath ?? null,
      }))
      .filter(project => project.id && project.path);
  }

  async createSession() {
    const canonical = path => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
    const projects = await this.call('projectService', 'readProjects', {});
    const matches = projects.filter(project => !project.deleted && project.hostId === 'local' &&
      project.roots.some(root => canonical(root.rootPath) === canonical(this.workspace)));
    if (matches.length > 1) throw new Error('Multiple ZCode projects match this workspace');
    const project = matches[0];
    // ZCode uses the stored root string as a workspace identity. Preserve it,
    // even when another slash spelling points to the same physical directory.
    if (project) this.workspace = project.roots.find(root => canonical(root.rootPath) === canonical(this.workspace)).rootPath;
    // The caller may only know the folder. Record the handle it maps to, so the
    // dispatch receipt can carry the id back instead of an empty field.
    this.projectId = project?.id ?? null;
    const task = await this.call('zcodeTaskService', 'createTask', {
      workspacePath: this.workspace, mode: 'build', v4Create: true, mcpServers: [],
      modelSelection: this.model ?? { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'high' } },
    });
    if (!task?.taskId) throw new Error('ZCode did not create a task');
    this.sessionId = task.taskId;
    if (project) await this.call('projectService', 'moveTask', {
      task: { taskId: task.taskId, workspacePath: this.workspace, hostId: 'local' },
      projectId: project.id, hostId: 'local',
    });
    return { sessionId: task.taskId, title: 'Relay 专用 · ZCode', transport: 'local' };
  }

  async submit(sessionId, text, requestId = randomUUID()) {
    if (sessionId !== this.sessionId) throw new Error('Dedicated session mismatch');
    let snapshot;
    try {
      snapshot = await this.call('zcodeAgentService', 'readSession', { workspacePath: this.workspace, sessionId });
    } catch (error) {
      if (!error.message.includes('Session is not active:')) throw error;
      await this.call('zcodeTaskService', 'resumeTask', { workspacePath: this.workspace, taskId: sessionId, mcpServers: [] });
      snapshot = await this.call('zcodeAgentService', 'readSession', { workspacePath: this.workspace, sessionId });
    }
    if (snapshot?.session?.workspace?.workspacePath !== this.workspace) throw new Error('Dedicated ZCode workspace mismatch');
    if (this.model && snapshot.session.model && (snapshot.session.model.providerId !== this.model.providerId || snapshot.session.model.modelId !== this.model.modelId)) throw new Error('Saved session model mismatch');
    if (snapshot.session.status !== 'idle') throw new Error('ZCode session is busy');
    this.baseline = new Set((snapshot.messages ?? []).map(m => m.info?.messageId ?? m.messageId ?? m.id ?? m.info?.id));
    await this.call('zcodeTaskService', 'sendPrompt', {
      taskId: sessionId, content: text, traceId: requestId.replaceAll('-', ''), queryId: requestId,
    });
    return { accepted: true, requestId };
  }

  async poll(sessionId, requestId) {
    const snapshot = await this.call('zcodeAgentService', 'readSession', { workspacePath: this.workspace, sessionId });
    const messages = snapshot.messages ?? [];
    const messageId = m => m.info?.messageId ?? m.messageId ?? m.id ?? m.info?.id;
    const user = messages.find(m =>
      (m.info?.metadata?.conversationInputIntent?.sourceCommandId ?? m.info?.metadata?.inputIntent?.sourceCommandId) === requestId.replaceAll('-', ''));
    const descendants = new Set(user ? [messageId(user)] : []);
    for (const message of messages) if (descendants.has(message.info?.parentMessageId)) descendants.add(messageId(message));
    const assistants = messages.filter(m => (user ? descendants.has(messageId(m)) : this.baseline && !this.baseline.has(messageId(m))) &&
      (m.role === 'assistant' || m.info?.role === 'assistant'));
    const response = assistants.flatMap(m => m.parts ?? []).filter(p => p.type === 'text').map(p => p.text ?? p.content ?? '').join('\n');
    const status = snapshot.session?.status;
    const currentMessages = user ? messages.slice(messages.indexOf(user) + 1) :
      messages.filter(message => this.baseline && !this.baseline.has(messageId(message)));
    if (currentMessages.some(message => message.info?.metadata?.runtimeMessage?.source === 'interrupt_marker')) {
      return { sessionId, requestId, model: snapshot.session?.model, status: 'cancelled', response };
    }
    const pending = snapshot.runtime?.pendingRequestIds?.filter(id => id.startsWith('perm_')) ?? [];
    if (pending.length) {
      return { sessionId, requestId, model: snapshot.session?.model, status: 'error', response,
        error: { code: 'desktop_confirmation_required', pendingRequestIds: pending } };
    }
    return { sessionId, requestId, model: snapshot.session?.model, error: snapshot.projection?.lastError, status: status === 'idle' && response ? 'completed' : status, response };
  }
}
