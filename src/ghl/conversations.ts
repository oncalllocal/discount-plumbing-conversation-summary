/**
 * GHL Conversations API: read a contact's message history.
 *
 *   GET /conversations/search?locationId&contactId        → the contact's conversations
 *   GET /conversations/:id/messages?limit&lastMessageId   → newest-first pages of messages
 *
 * Needs the token's `conversations.readonly` and `conversations/message.readonly`
 * scopes. Messages come back normalised (oldest first, one record per message).
 */
import type { Env } from "../env";
import { ghl } from "./client";

/** The Conversations endpoints are versioned separately from the contacts ones. */
const CONVERSATIONS_VERSION = "2021-04-15";
const PAGE_SIZE = 100;
/** Hard stops so a runaway thread can never loop forever or blow the Worker's subrequest budget. */
const MAX_PAGES_PER_CONVERSATION = 15;
const MAX_CONVERSATIONS = 10;

export type Channel = "sms" | "email" | "call" | "chat" | "other";

export interface HistoryMessage {
  id: string;
  /** "in" = the lead wrote it; "out" = the business (or its automations / Ashley) did. */
  dir: "in" | "out";
  channel: Channel;
  body: string;
  /** ISO timestamp (UTC). */
  at: string;
  /** Who sent an outbound message when GHL says so: "workflow", "bulk_actions", "app", "api"… */
  source?: string;
}

interface RawMessage {
  id?: string;
  direction?: string;
  body?: string;
  messageType?: string;
  type?: number;
  dateAdded?: string;
  status?: string;
  source?: string;
  contentType?: string;
}

/** GHL's `messageType` strings → our channel. Unknown types are "other" (and excluded by default). */
export function channelOf(m: Pick<RawMessage, "messageType" | "type">): Channel {
  const t = (m.messageType || "").toUpperCase();
  if (t === "TYPE_SMS" || t === "SMS") return "sms";
  if (t === "TYPE_EMAIL" || t === "EMAIL") return "email";
  if (t === "TYPE_CALL" || t === "CALL" || t === "TYPE_VOICEMAIL") return "call";
  if (t === "TYPE_LIVE_CHAT" || t === "TYPE_WEBCHAT" || t === "LIVE_CHAT") return "chat";
  if (!t && m.type === 2) return "sms"; // legacy numeric type
  return "other";
}

/** Messages that never reached the lead shouldn't appear in a summary of what was said. */
const UNDELIVERED = new Set(["failed", "undelivered", "error", "invalid", "cancelled", "canceled"]);

/** Turn one raw GHL message into a HistoryMessage, or null when it can't be part of the story. */
export function normalizeMessage(m: RawMessage, channels: ReadonlySet<Channel>): HistoryMessage | null {
  if (!m.id || !m.dateAdded || Number.isNaN(Date.parse(m.dateAdded))) return null;
  const channel = channelOf(m);
  if (!channels.has(channel)) return null;
  if (UNDELIVERED.has((m.status || "").toLowerCase())) return null;
  // Collapse runs of blank space, but keep it a faithful transcript otherwise.
  const body = String(m.body ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!body) return null;
  const dir = (m.direction || "").toLowerCase() === "inbound" ? "in" : "out";
  return { id: m.id, dir, channel, body, at: new Date(m.dateAdded).toISOString(), source: m.source };
}

/** Parse a "sms,chat" style setting into a channel set (unknown names ignored; empty → SMS only). */
export function parseChannels(raw: string | undefined): Set<Channel> {
  const valid: Channel[] = ["sms", "email", "call", "chat"];
  const set = new Set<Channel>();
  for (const part of (raw || "").toLowerCase().split(/[\s,]+/)) if ((valid as string[]).includes(part)) set.add(part as Channel);
  if (!set.size) set.add("sms");
  return set;
}

export interface HistoryResult {
  ok: boolean;
  error?: string;
  messages: HistoryMessage[];
  conversations: number;
  /** True when a page/conversation cap stopped the read before the beginning of the thread. */
  truncated: boolean;
}

/**
 * Every deliverable message in the channels asked for, across all of the contact's
 * conversations, oldest first. Fails closed: if any page can't be read the result is
 * an error rather than a silently partial history.
 */
export async function fetchContactHistory(env: Env, contactId: string, channels: ReadonlySet<Channel>): Promise<HistoryResult> {
  const loc = env.GHL_LOCATION_ID;
  if (!env.GHL_TOKEN || !loc) return { ok: false, error: "GHL_TOKEN / GHL_LOCATION_ID not set", messages: [], conversations: 0, truncated: false };

  const search = await ghl(env, "GET", `/conversations/search?${new URLSearchParams({ locationId: loc, contactId, limit: String(MAX_CONVERSATIONS) })}`, undefined, CONVERSATIONS_VERSION);
  if (!search.ok) return { ok: false, error: `${search.error}${search.status === 401 || search.status === 403 ? " (token needs the conversations.readonly scope)" : ""}`, messages: [], conversations: 0, truncated: false };
  const convos = ((search.data?.conversations || []) as { id?: string; contactId?: string }[])
    // The search is already filtered by contact; this is belt-and-braces against ever summarising someone else's thread.
    .filter((c) => c.id && (!c.contactId || c.contactId === contactId))
    .slice(0, MAX_CONVERSATIONS);

  const byId = new Map<string, HistoryMessage>();
  let truncated = false;
  for (const c of convos) {
    let lastMessageId: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES_PER_CONVERSATION) {
        truncated = true;
        break;
      }
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (lastMessageId) qs.set("lastMessageId", lastMessageId);
      const r = await ghl(env, "GET", `/conversations/${c.id}/messages?${qs}`, undefined, CONVERSATIONS_VERSION);
      if (!r.ok) return { ok: false, error: `${r.error}${r.status === 401 || r.status === 403 ? " (token needs the conversations/message.readonly scope)" : ""}`, messages: [], conversations: convos.length, truncated };
      const block = (r.data?.messages || {}) as { messages?: RawMessage[]; nextPage?: boolean; lastMessageId?: string };
      const raw = block.messages || [];
      for (const m of raw) {
        const n = normalizeMessage(m, channels);
        if (n) byId.set(n.id, n);
      }
      // Stop when GHL says it's the last page, the page is empty, or the cursor isn't advancing.
      if (!block.nextPage || !raw.length || !block.lastMessageId || block.lastMessageId === lastMessageId) break;
      lastMessageId = block.lastMessageId;
    }
  }
  const messages = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return { ok: true, messages, conversations: convos.length, truncated };
}
