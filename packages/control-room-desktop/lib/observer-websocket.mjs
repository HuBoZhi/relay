import WebSocket from 'ws';

/** The hosted gateway currently requires its read-only token on the WS upgrade URL. */
export function observerConnectionUrl(address, options) {
  const url=new URL(address);
  const authorization=options?.headers?.authorization;
  if(url.hostname==='cast.agentrelay.com' && url.pathname==='/v1/ws' &&
    typeof authorization==='string' && authorization.startsWith('Bearer ot_live_')) {
    url.searchParams.set('token',authorization.slice('Bearer '.length));
  }
  return url.href;
}

// This socket exists only in the desktop main process. Its URL is never exposed
// to the browser or written to logs; workspace admin credentials cannot take this path.
export default class ObserverWebSocket extends WebSocket {
  constructor(address,options){super(observerConnectionUrl(address,options),options)}
}
