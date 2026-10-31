/** Connects to a desktop renderer to call its IPC/SDK API. No input events or DOM actions. */
export class DesktopIpcTransport {
  #socket;
  #pending = new Map();
  #nextId = 0;
  #timeoutMs;

  static async connect({ port, client, fetch: get = globalThis.fetch,
    WebSocket: Socket = globalThis.WebSocket, timeoutMs = 15_000 }) {
    if (!['workbuddy', 'zcode'].includes(client)) throw new Error('Unsupported desktop client');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
    const response = await get(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (!response.ok) throw new Error('Desktop debugger discovery failed');
    const path = client === 'zcode'
      ? /\/zcode\/resources\/app\.asar\/out\/renderer\/index\.html$/i
      : /\/workbuddy\/resources\/app\.asar\/renderer\/index\.html$/i;
    const targets = (await response.json()).filter(target => {
      if (target.type !== 'page') return false;
      try {
        const url = new URL(target.url);
        return url.protocol === 'file:' && !url.host && path.test(decodeURIComponent(url.pathname));
      } catch { return false; }
    });
    if (targets.length !== 1) throw new Error(`Expected one ${client} desktop target; got ${targets.length}`);
    const endpoint = new URL(targets[0].webSocketDebuggerUrl);
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' ||
      Number(endpoint.port) !== port || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !endpoint.pathname.startsWith('/devtools/page/')) {
      throw new Error('Untrusted desktop debugger endpoint');
    }
    const socket = new Socket(endpoint.href);
    const transport = new DesktopIpcTransport(socket, timeoutMs);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Desktop connection timeout')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Desktop connection failed')); }, { once: true });
    });
    return transport;
  }

  constructor(socket, timeoutMs) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      message.error ? pending.reject(new Error(`CDP error ${message.error.code}`)) : pending.resolve(message.result);
    });
    for (const event of ['close', 'error']) socket.addEventListener(event, () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Desktop connection closed'));
      }
      this.#pending.clear();
    });
  }

  async request(method, params) {
    if (!['Runtime.evaluate', 'Runtime.getProperties', 'Runtime.callFunctionOn', 'Runtime.releaseObject'].includes(method)) {
      throw new Error('Unsupported desktop CDP method: only Runtime IPC calls are allowed');
    }
    const id = ++this.#nextId;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('Desktop IPC call timed out; inspect request state before retrying'));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer); this.#pending.delete(id); reject(error);
      }
    });
    return result;
  }

  async evaluate(expression) {
    const result = await this.request('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown error';
      const message = detail.split('\n')[0].slice(0,300).replace(/(?:Bearer\s+\S+|(?:rk|at|ot)_live_[\w-]+|sk-[\w-]+)/gi, '[REDACTED]');
      throw new Error('Desktop API rejected the call: ' + message);
    }
    return result.result?.value;
  }

  close() { this.#socket.close(); }
}
