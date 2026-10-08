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

/** A file sent with a message (a picture, video, PDF…). */
export interface Attachment {
  url: string;
  /** "image" by file extension, "other" for known non-image files, "unknown" when the URL doesn't say (checked on download). */
  kind: "image" | "other" | "unknown";
}

export interface HistoryMessage {
  id: string;
  /** "in" = the lead wrote it; "out" = the business (or its automations / Ashley) did. */
  dir: "in" | "out";
  channel: Channel;
  body: string;
  /** Files sent with the message (MMS pictures etc.). A picture-only text has an empty body. */
  attachments: Attachment[];
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
  attachments?: unknown;
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

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)$/i;
const OTHER_EXT = /\.(mp4|mov|m4v|3gp|3g2|avi|webm|mp3|m4a|wav|amr|ogg|aac|pdf|vcf|vcard|zip|docx?|xlsx?|pptx?|txt|csv)$/i;
const MAX_ATTACHMENTS_PER_MESSAGE = 20;

/**
 * GHL lists a message's files as `attachments`: an array of URLs (documented), but be lenient about
 * `{url}` objects and a single string. Only public http(s) URLs are kept, once each.
 */
export function parseAttachments(raw: unknown): Attachment[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? [raw] : [];
  const out: Attachment[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const u = typeof item === "string" ? item : item && typeof item === "object" ? ((item as Record<string, unknown>).url ?? (item as Record<string, unknown>).URL ?? (item as Record<string, unknown>).src) : undefined;
    if (typeof u !== "string") continue;
    let url: URL;
    try {
      url = new URL(u.trim());
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const kind = IMAGE_EXT.test(url.pathname) ? "image" : OTHER_EXT.test(url.pathname) ? "other" : "unknown";
    out.push({ url: url.href, kind });
    if (out.length >= MAX_ATTACHMENTS_PER_MESSAGE) break;
  }
  return out;
}

/** Turn one raw GHL message into a HistoryMessage, or null when it can't be part of the story. */
export function normalizeMessage(m: RawMessage, channels: ReadonlySet<Channel>): HistoryMessage | null {
  if (!m.id || !m.dateAdded || Number.isNaN(Date.parse(m.dateAdded))) return null;
  const channel = channelOf(m);
  if (!channels.has(channel)) return null;
  if (UNDELIVERED.has((m.status || "").toLowerCase())) return null;
  // Collapse runs of blank space, but keep it a faithful transcript otherwise.
  const body = String(m.body ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const attachments = parseAttachments(m.attachments);
  if (!body && !attachments.length) return null; // a picture-only text is still part of the story
  const dir = (m.direction || "").toLowerCase() === "inbound" ? "in" : "out";
  return { id: m.id, dir, channel, body, attachments, at: new Date(m.dateAdded).toISOString(), source: m.source };
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
export async function fetchContactHistory(env: Env, contactId: string, channels: ReadonlySet<Channel>, opts: { since?: string } = {}): Promise<HistoryResult> {
  const since = opts.since && !Number.isNaN(Date.parse(opts.since)) ? new Date(opts.since).toISOString() : undefined;
  const sinceMs = since ? Date.parse(since) : undefined;
  const loc = env.GHL_LOCATION_ID;
  if (!env.GHL_TOKEN || !loc) return { ok: false, error: "GHL_TOKEN / GHL_LOCATION_ID not set", messages: [], conversations: 0, truncated: false };

  const search = await ghl(env, "GET", `/conversations/search?${new URLSearchParams({ locationId: loc, contactId, limit: String(MAX_CONVERSATIONS), sortBy: "last_message_date", sort: "desc" })}`, undefined, CONVERSATIONS_VERSION);
  if (!search.ok) return { ok: false, error: `${search.error}${search.status === 401 || search.status === 403 ? " (token needs the conversations.readonly scope)" : ""}`, messages: [], conversations: 0, truncated: false };
  const convos = ((search.data?.conversations || []) as { id?: string; contactId?: string; lastMessageDate?: number }[])
    // The search is already filtered by contact; this is belt-and-braces against ever summarising someone else's thread.
    .filter((c) => c.id && (!c.contactId || c.contactId === contactId))
    // A conversation whose newest message is older than the window has nothing to contribute.
    .filter((c) => sinceMs === undefined || typeof c.lastMessageDate !== "number" || c.lastMessageDate >= sinceMs)
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
        if (n && (!since || n.at >= since)) byId.set(n.id, n);
      }
      // Pages come newest first: once a page reaches back past the window, everything after it is older still.
      if (since && raw.some((m) => m.dateAdded && Date.parse(m.dateAdded) < Date.parse(since))) break;
      // Stop when GHL says it's the last page, the page is empty, or the cursor isn't advancing.
      if (!block.nextPage || !raw.length || !block.lastMessageId || block.lastMessageId === lastMessageId) break;
      lastMessageId = block.lastMessageId;
    }
  }
  const messages = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return { ok: true, messages, conversations: convos.length, truncated };
}
