import {
  getOperationalCase,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";

export interface MediaGroupAckFile {
  originalName: string | null | undefined;
  kind: string | null | undefined;
}

interface StoredMediaGroupAck {
  chat_id: number;
  media_group_id: string;
  case_id: string;
  files: Array<{ original_name: string | null; kind: string | null }>;
  mark_ready: boolean;
  first_file_at: string;
  last_file_at: string;
  ack_sent_at?: string | null;
}

type StoredMediaGroupAckMap = Record<string, StoredMediaGroupAck>;

const CONTEXT_KEY = "telegram_media_group_acks";
const DEFAULT_WINDOW_MS = 12_000;

function asContextRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function groupKey(chatId: number, mediaGroupId: string): string {
  return `${chatId}:${mediaGroupId}`;
}

function readAckMap(context: Record<string, unknown>): StoredMediaGroupAckMap {
  const raw = context[CONTEXT_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const map: StoredMediaGroupAckMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const group = value as Record<string, unknown>;
    if (
      typeof group.chat_id !== "number" ||
      typeof group.media_group_id !== "string" ||
      typeof group.case_id !== "string"
    ) {
      continue;
    }
    map[key] = {
      chat_id: group.chat_id,
      media_group_id: group.media_group_id,
      case_id: group.case_id,
      files: Array.isArray(group.files)
        ? group.files
            .map((item) => {
              if (!item || typeof item !== "object" || Array.isArray(item)) return null;
              const file = item as Record<string, unknown>;
              return {
                original_name:
                  typeof file.original_name === "string" ? file.original_name : null,
                kind: typeof file.kind === "string" ? file.kind : null,
              };
            })
            .filter((item): item is { original_name: string | null; kind: string | null } =>
              Boolean(item)
            )
        : [],
      mark_ready: group.mark_ready === true,
      first_file_at:
        typeof group.first_file_at === "string" ? group.first_file_at : new Date(0).toISOString(),
      last_file_at:
        typeof group.last_file_at === "string" ? group.last_file_at : new Date(0).toISOString(),
      ack_sent_at: typeof group.ack_sent_at === "string" ? group.ack_sent_at : null,
    };
  }
  return map;
}

function withAckMap(
  context: Record<string, unknown>,
  map: StoredMediaGroupAckMap
): Record<string, unknown> {
  return {
    ...context,
    [CONTEXT_KEY]: map,
  };
}

function appendInMap(params: {
  map: StoredMediaGroupAckMap;
  caseId: string;
  chatId: number;
  mediaGroupId: string;
  file: MediaGroupAckFile;
  markReady: boolean;
  nowIso: string;
}): StoredMediaGroupAckMap {
  const key = groupKey(params.chatId, params.mediaGroupId);
  const existing = params.map[key];
  const files = existing?.files ?? [];
  return {
    ...params.map,
    [key]: {
      chat_id: params.chatId,
      media_group_id: params.mediaGroupId,
      case_id: params.caseId,
      files: [
        ...files,
        {
          original_name: params.file.originalName?.trim() || null,
          kind: params.file.kind?.trim() || null,
        },
      ],
      mark_ready: (existing?.mark_ready ?? false) || params.markReady,
      first_file_at: existing?.first_file_at ?? params.nowIso,
      last_file_at: params.nowIso,
      ack_sent_at: null,
    },
  };
}

function isFlushable(params: {
  group: StoredMediaGroupAck;
  caseId: string;
  chatId: number;
  nowMs: number;
  windowMs: number;
  force: boolean;
  mediaGroupId?: string;
}): boolean {
  const { group, caseId, chatId } = params;
  if (group.case_id !== caseId || group.chat_id !== chatId) return false;
  if (group.ack_sent_at) return false;
  if (params.mediaGroupId && group.media_group_id !== params.mediaGroupId) return false;
  if (params.force) return true;
  const lastMs = Date.parse(group.last_file_at);
  if (!Number.isFinite(lastMs)) return false;
  return params.nowMs - lastMs >= params.windowMs;
}

function markSentInMap(
  map: StoredMediaGroupAckMap,
  keys: string[],
  sentAtIso: string
): StoredMediaGroupAckMap {
  const next: StoredMediaGroupAckMap = { ...map };
  for (const key of keys) {
    const group = next[key];
    if (!group) continue;
    next[key] = { ...group, ack_sent_at: sentAtIso };
  }
  return next;
}

export async function appendMediaGroupAckToCase(params: {
  db: DbClient;
  opCase: OperationalCase;
  chatId: number;
  mediaGroupId: string;
  file: MediaGroupAckFile;
  markReady: boolean;
  windowMs?: number;
}): Promise<OperationalCase> {
  let current = params.opCase;
  const maxAttempts = 2;
  const windowMs = params.windowMs ?? DEFAULT_WINDOW_MS;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const nowIso = new Date().toISOString();
    const context = asContextRecord(current.context_jsonb);
    const map = readAckMap(context);
    const nextMap = appendInMap({
      map,
      caseId: current.id,
      chatId: params.chatId,
      mediaGroupId: params.mediaGroupId,
      file: params.file,
      markReady: params.markReady,
      nowIso,
    });
    const dueIso = new Date(Date.now() + windowMs).toISOString();
    const nextActionAt =
      current.next_action_at && Date.parse(current.next_action_at) <= Date.parse(dueIso)
        ? current.next_action_at
        : dueIso;
    const updated = await updateOperationalCase(params.db, current.id, current.version, {
      context: withAckMap(context, nextMap),
      nextActionAt,
    });
    if (updated) return updated;
    const fresh = await getOperationalCase(params.db, current.id);
    if (!fresh) return current;
    current = fresh;
  }
  return current;
}

export async function flushMediaGroupAcksForCase(params: {
  db: DbClient;
  opCase: OperationalCase;
  chatId: number;
  sendAck: (
    files: Array<{ originalName: string | null; kind: string | null }>
  ) => Promise<void>;
  force?: boolean;
  mediaGroupId?: string;
  windowMs?: number;
}): Promise<{ opCase: OperationalCase; flushed: number; markReady: boolean }> {
  const windowMs = params.windowMs ?? DEFAULT_WINDOW_MS;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const context = asContextRecord(params.opCase.context_jsonb);
  const map = readAckMap(context);
  const candidates = Object.entries(map).filter(([, group]) =>
    isFlushable({
      group,
      caseId: params.opCase.id,
      chatId: params.chatId,
      nowMs,
      windowMs,
      force: params.force === true,
      mediaGroupId: params.mediaGroupId,
    })
  );
  if (candidates.length === 0) {
    return { opCase: params.opCase, flushed: 0, markReady: false };
  }
  const sentKeys: string[] = [];
  let shouldMarkReady = false;
  for (const [key, group] of candidates) {
    await params.sendAck(
      group.files.map((file) => ({
        originalName: file.original_name,
        kind: file.kind,
      }))
    );
    sentKeys.push(key);
    if (group.mark_ready) shouldMarkReady = true;
  }
  const nextMap = markSentInMap(map, sentKeys, nowIso);
  const updated =
    (await updateOperationalCase(params.db, params.opCase.id, params.opCase.version, {
      context: withAckMap(context, nextMap),
      nextActionAt: null,
    })) ?? params.opCase;
  return { opCase: updated, flushed: sentKeys.length, markReady: shouldMarkReady };
}

export const __testOnly = {
  groupKey,
  readAckMap,
  appendInMap,
  isFlushable,
  markSentInMap,
};
