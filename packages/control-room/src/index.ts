/**
 * `@agent-relay/control-room` — a read-only observer for a Relay workspace.
 *
 * Public surface: the two data sources, the HTTP server, and the view types
 * shared with the browser.
 */

export * from './types.js';
export { aggregateChannelState, deriveAgentWork, deriveMetricsFlags, receiptLabel } from './derive.js';
export { DemoControlRoomSource } from './demo-source.js';
export type { DemoSourceOptions } from './demo-source.js';
export { RelayControlRoomSource, reduceSessionEvents } from './relay-source.js';
export type { RelayMessagingLike, RelaySourceOptions } from './relay-source.js';
export { startControlRoom } from './server.js';
export type { ControlRoomServer, ControlRoomServerOptions } from './server.js';
export type { ControlRoomSource, MessageQuery } from './source.js';
export { ThroughputTracker } from './throughput.js';
export {
  DEFAULT_TIMEZONE,
  displayNameOf,
  relativeLabel,
  resolveTimezone,
  shiftDay,
  toIso,
  zonedStamp,
  zonedToday,
} from './format.js';
