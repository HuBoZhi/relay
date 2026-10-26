/**
 * The data-source boundary.
 *
 * `ControlRoomServer` knows nothing about Relay wire types: it speaks this
 * interface. That keeps the HTTP layer testable with an in-memory fake and lets
 * the demo source stand in for a deployment with no credential configured.
 */

import type {
  BootstrapView,
  ControlRoomMode,
  MessagePageView,
  MessageView,
  SearchHitView,
  StreamFrame,
} from './types.js';

export interface MessageQuery {
  limit: number;
  /** Older-than cursor: message id of the oldest message already shown. */
  before?: string;
  /** Free-text filter applied to body, sender, and recipient. */
  query?: string;
  /** Sender identifier filter. */
  from?: string;
  /** Room-timezone calendar day filter (`2026-10-26`). */
  day?: string;
}

export interface ControlRoomSource {
  readonly mode: ControlRoomMode;
  /** Relay host being observed, for display. Never includes a credential. */
  readonly target: string;
  bootstrap(): Promise<BootstrapView>;
  messages(channel: string, query: MessageQuery): Promise<MessagePageView>;
  message(id: string): Promise<MessageView | null>;
  search(query: string, channel?: string): Promise<SearchHitView[]>;
  /**
   * Register a stream listener. Returns an unsubscribe function.
   *
   * Frames may arrive before the first {@link bootstrap}; the browser drops
   * message frames for channels it has not loaded yet.
   */
  subscribe(listener: (frame: StreamFrame) => void): () => void;
  /** Freeze what listeners receive while the operator reads history. */
  setPaused(paused: boolean): Promise<void>;
  close(): Promise<void>;
}
