/**
 * `@agent-relay/dispatch-bridge` — the local process that owns client integration.
 *
 * The task engine never talks to a desktop app. It calls this bridge over loopback
 * HTTP, the bridge drives the app through its own native interface, and the bridge
 * reports the result back to the engine when the turn ends.
 *
 * Why a separate process:
 *
 * - The engine must return a receipt as soon as the target accepted the prompt.
 *   Driving a client can take seconds; polling its native turn state takes minutes.
 *   Neither belongs on the dispatch path.
 * - The client interface depends on app internals (CDP → IPC/SDK). Keeping that in
 *   one bridge means an app upgrade breaks one adapter, not the engine.
 * - The bridge is the only component that polls a client. No model ever waits or
 *   asks whether work finished; the loop lives here, in transport code.
 */

export { resolveBridgeConfig, describeConfig, DEFAULT_PORT, PORTS } from './config.mjs';
export { loadDrivers, probeClient, driverFor } from './drivers.mjs';
export { BridgeStore } from './store.mjs';
export { TurnWatcher, mapPollResult } from './watcher.mjs';
export { createBridgeServer, startBridge } from './server.mjs';
