/**
 * Async task surface: contract, engine, adapters, and store.
 *
 * Kept in its own directory rather than the observation modules so the write
 * capability is separable: an install that only observes loads `index.ts`, and
 * mounts these routes behind an explicit opt-in.
 */

export * from './contracts.js';
export {
  AdapterRegistry,
  HttpBridgeAdapter,
  assertLoopback,
  capabilitySeed,
  knownClients,
} from './adapters.js';
export type {
  ClientProbeResult,
  DeliverOutcome,
  DeliverRequest,
  DispatchAdapter,
  DispatchOutcome,
  DispatchRequest,
} from './adapters.js';
export { AsyncEngine, AsyncNotFoundError, AsyncValidationError, stageLabel } from './engine.js';
export type { EngineEvent, EngineOptions, ValidationIssue } from './engine.js';
export {
  AsyncStore,
  emptyState,
  findProjectIdByPath,
  findTopicByName,
  resolveDataRoot,
  STATE_VERSION,
} from './store.js';
export type { AsyncState, DataRootResolution, IdempotencyRecord, JournalEvent } from './store.js';
export {
  createId,
  normalizePathForComparison,
  projectLabel,
  samePath,
  stableHash,
  topicSlug,
} from './ids.js';
