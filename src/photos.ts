/**
 * Pictures (MMS) in a conversation: number them, download the ones Claude will look at,
 * and report honestly on the ones it can't.
 *
 * Modes (SUMMARY_PHOTOS, or "photos" on a request):
 *   describe  list every photo with its link AND have Claude describe the most recent ones  (default)
 *   links     list every photo with its link only
 *   off       ignore attachments
 */
import type { Attachment, HistoryMessage } from "./ghl/conversations";
import { errorMessage, withTimeout } from "./lib/util";

export type PhotoMode = "describe" | "links" | "off";
export const DEFAULT_PHOTO_MODE: PhotoMode = "describe";

export function parsePhotoMode(raw: unknown): PhotoMode | null {
  const t = String(raw ?? "").trim().toLowerCase();
  return t === "describe" || t === "links" || t === "off" ? t : null;
}

/** Claude is shown at most this many photos (the most recent); the rest are listed by link only. */
export const MAX_ANALYZED = 8;
/** At most this many photos / attachments are listed in the summary. */
export const MAX_LISTED = 30;
/** The Messages API rejects images over 5 MB; stay under it. */
export const MAX_IMAGE_BYTES = 4_500_000;
const FETCH_TIMEOUT_MS = 12_000;
const FETCH_CONCURRENCY = 4;

export interface Photo {
  /** 1-based number across the whole history, in the order sent. This is the number Claude and the summary use. */
  n: number;
  /** 1-based position of the message that carried it (the [n] in the transcript). */
  message: number;
  url: string;
  kind: Attachment["kind"];
  at: string;
  dir: "in" | "out";
}

/** Every attachment in the history, numbered in the order sent. */
export function collectPhotos(messages: HistoryMessage[]): Photo[] {
  const out: Photo[] = [];
  messages.forEach((m, i) => {
    for (const a of m.attachments || []) out.push({ n: out.length + 1, message: i + 1, url: a.url, kind: a.kind, at: m.at, dir: m.dir });
  });
  return out;
}

export interface PhotoImage {
  n: number;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** base64 */
  data: string;
}

export interface LoadedPhotos {
  images: PhotoImage[];
  /** Why a photo wasn't shown to Claude (by photo number). */
  skipped: Map<number, string>;
}

/** Public https URLs on a named host only: never a bare IP, localhost or an internal name. */
export function isFetchableUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || h.startsWith("[")) return false;
    return true;
  } catch {
    return false;
  }
}

/** The image type from its first bytes (a server's Content-Type for a stored file is often wrong or generic). */
export function sniffImage(b: Uint8Array): PhotoImage["mediaType"] | "heic" | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) === "RIFF" && tag(8) === "WEBP") return "image/webp";
  if (tag(4) === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)/.test(tag(8))) return "heic";
  return null;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function loadOne(p: Photo): Promise<PhotoImage | string> {
  if (!isFetchableUrl(p.url)) return "link isn't a public https address";
  try {
    const res = await withTimeout(fetch(p.url, { redirect: "follow", headers: { accept: "image/*,*/*;q=0.5" } }), FETCH_TIMEOUT_MS, "photo download");
    if (!res.ok) return `couldn't be downloaded (HTTP ${res.status})`;
    const declared = Number(res.headers.get("content-length"));
    if (declared > MAX_IMAGE_BYTES) return "file is too large to analyze";
    const bytes = new Uint8Array(await withTimeout(res.arrayBuffer(), FETCH_TIMEOUT_MS, "photo download"));
    if (bytes.length > MAX_IMAGE_BYTES) return "file is too large to analyze";
    const type = sniffImage(bytes);
    if (type === "heic") return "iPhone HEIC format can't be analyzed";
    if (!type) return "not an image format that can be analyzed";
    return { n: p.n, mediaType: type, data: toBase64(bytes) };
  } catch (e) {
    return `couldn't be downloaded (${errorMessage(e).slice(0, 80)})`;
  }
}

/**
 * Download the images Claude will look at: the most recent MAX_ANALYZED that could be pictures.
 * Everything else, or anything that fails, gets a reason instead of silently disappearing.
 */
export async function loadPhotoImages(photos: Photo[], max = MAX_ANALYZED): Promise<LoadedPhotos> {
  const skipped = new Map<number, string>();
  const candidates = photos.filter((p) => p.kind !== "other");
  const chosen = new Set(candidates.slice(-max).map((p) => p.n));
  for (const p of candidates) if (!chosen.has(p.n)) skipped.set(p.n, `not analyzed (only the ${max} most recent photos are examined)`);
  const todo = photos.filter((p) => chosen.has(p.n));
  const images: PhotoImage[] = [];
  for (let i = 0; i < todo.length; i += FETCH_CONCURRENCY) {
    const batch = todo.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map(loadOne));
    results.forEach((r, j) => (typeof r === "string" ? skipped.set(batch[j].n, r) : images.push(r)));
  }
  images.sort((a, b) => a.n - b.n);
  return { images, skipped };
}
