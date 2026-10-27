/**
 * Bundle entry for the desktop build.
 *
 * esbuild inlines the control-room server (and the SDK it uses) into
 * `dist/server.mjs`, so the packaged app needs no node_modules and can never run
 * a copy of the server that differs from the CLI's.
 */
export { DemoControlRoomSource, RelayControlRoomSource, startControlRoom } from '@agent-relay/control-room';
