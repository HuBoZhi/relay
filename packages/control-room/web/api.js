// Browser client for the control room API. No credential ever reaches this file:
// the local server holds it and exposes view models only.
'use strict';

window.RelayApi = (() => {
  async function request(path, options = {}) {
    const response = await fetch(path, {
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      ...options,
    });
    if (!response.ok) {
      let message = `请求失败（状态码 ${response.status}）`;
      try {
        const body = await response.json();
        if (body && typeof body.error === 'string') message = body.error;
      } catch {
        // Keep the status-based message when the body is not JSON.
      }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  const STREAM_EVENTS = ['connection', 'bootstrap', 'message', 'agents', 'ping'];

  return {
    bootstrap(signal) {
      return request('/api/bootstrap', signal ? { signal } : {});
    },

    messages(channel, options = {}) {
      const params = new URLSearchParams();
      params.set('limit', String(options.limit || 50));
      if (options.before) params.set('before', options.before);
      if (options.q) params.set('q', options.q);
      if (options.from) params.set('from', options.from);
      if (options.day) params.set('day', options.day);
      return request(
        `/api/channels/${encodeURIComponent(channel)}/messages?${params.toString()}`,
        options.signal ? { signal: options.signal } : {}
      );
    },

    message(id) {
      return request(`/api/messages/${encodeURIComponent(id)}`);
    },

    search(query, channel) {
      const params = new URLSearchParams({ q: query });
      if (channel) params.set('channel', channel);
      return request(`/api/search?${params.toString()}`);
    },

    pause(paused) {
      return request('/api/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused }),
      });
    },

    /**
     * Subscribe to the live stream.
     *
     * EventSource reconnects on its own; `onStatus` reports transport changes so
     * the banner can stop claiming "实时" while the socket is down.
     */
    stream({ onFrame, onStatus }) {
      let source = null;
      let closed = false;

      const connect = () => {
        source = new EventSource('/api/stream');
        source.onopen = () => onStatus('open');
        source.onerror = () => onStatus('error');
        for (const name of STREAM_EVENTS) {
          source.addEventListener(name, (event) => {
            let payload;
            try {
              payload = JSON.parse(event.data);
            } catch {
              return;
            }
            onFrame(name, payload);
          });
        }
      };

      connect();

      return {
        close() {
          closed = true;
          if (source) source.close();
          return closed;
        },
      };
    },
  };
})();
