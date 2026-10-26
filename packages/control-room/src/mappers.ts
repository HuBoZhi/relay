/**
 * Relay wire types → control room view types.
 *
 * Mapping lives apart from fetching so the honesty rules are reviewable in one
 * place: missing timestamps stay visibly missing, a recipient is never guessed
 * from the channel currently open, and a `kind` the SDK could not classify is
 * reported as unknown rather than guessed from the recipient shape.
 */

import type { RelayChannel, RelayMessage } from '@agent-relay/sdk/messaging';

import { displayNameOf, toIso, zonedStamp } from './format.js';
import { receiptLabel } from './derive.js';
import type { MessageKindLabel, MessageView } from './types.js';

const UNKNOWN_DAY = '日期未知';
const UNKNOWN_TIME = '--:--:--';

const KIND_LABELS: Record<NonNullable<RelayMessage['kind']> | 'unknown', MessageKindLabel> = {
  channel: '频道消息',
  dm: '关联私信',
  group_dm: '群组私信',
  thread_reply: '线程回复',
  unknown: '类型未知',
};

function resolveRecipient(raw: RelayMessage): { to: string; toName: string; kindHint: MessageView['kind'] } {
  const target = raw.target;
  if (target && typeof target === 'object') {
    switch (target.kind) {
      case 'channel':
        return { to: String(target.channelName), toName: String(target.channelName), kindHint: 'channel' };
      case 'agent':
        return { to: String(target.agentName), toName: String(target.agentName), kindHint: 'dm' };
      case 'dm':
        return { to: String(target.conversationId), toName: String(target.conversationId), kindHint: 'dm' };
      case 'group_dm':
        return {
          to: String(target.conversationId),
          toName: String(target.conversationId),
          kindHint: 'group_dm',
        };
      default:
        break;
    }
  }
  // A channel message without a target still has its channel. A direct message
  // without a target does not, and inventing one would misattribute the message.
  if (raw.channel?.name) {
    return { to: raw.channel.name, toName: raw.channel.name, kindHint: 'channel' };
  }
  if (raw.conversationId) {
    return { to: raw.conversationId, toName: raw.conversationId, kindHint: 'dm' };
  }
  return { to: '', toName: '未标明接收对象', kindHint: 'unknown' };
}

export interface MapMessageContext {
  timezone: string;
  /** Channel the message was listed under, used only for the `channel*` fields. */
  channelName: string;
  channelLabel?: string;
}

export function mapMessage(raw: RelayMessage, context: MapMessageContext): MessageView {
  const recipient = resolveRecipient(raw);
  const kind: MessageView['kind'] = raw.kind && raw.kind !== 'unknown' ? raw.kind : recipient.kindHint;
  const createdAt = toIso(raw.createdAt);
  const stamp = createdAt ? zonedStamp(createdAt, context.timezone) : null;
  const readByCount = typeof raw.readByCount === 'number' ? raw.readByCount : null;
  const receipt = receiptLabel(kind, readByCount);
  const fromName = raw.from?.name ?? raw.from?.id ?? '未知发送者';

  return {
    id: String(raw.messageId ?? raw.id ?? ''),
    channel: context.channelName,
    channelName: context.channelName,
    channelLabel: context.channelLabel ?? context.channelName,
    from: raw.from?.name ?? raw.from?.id ?? '',
    fromName,
    to: recipient.to,
    toName: recipient.toName,
    kind,
    kindLabel: KIND_LABELS[kind],
    text: raw.text ?? '',
    createdAt: createdAt ?? '',
    day: stamp?.day ?? UNKNOWN_DAY,
    time: stamp?.time ?? UNKNOWN_TIME,
    receipt: receipt.text,
    receiptKnown: receipt.known,
    threadId: raw.threadId ?? null,
    parentId: raw.parentId ?? null,
    readByCount,
  };
}

export function channelDisplayName(channel: RelayChannel): string {
  const metadata = (channel.metadata ?? {}) as Record<string, unknown>;
  return displayNameOf(channel.name, metadata);
}

/** Sender display label, honouring a localized name from agent metadata. */
export function agentDisplayName(name: string, metadata?: Record<string, unknown> | null): string {
  return displayNameOf(name, metadata ?? null);
}
