/**
 * Worker bindings, variables and secrets for the Discount Plumbing conversation summary.
 * Vars live in wrangler.toml; secrets are set with `wrangler secret put NAME` (see README).
 */
export interface Env {
  /** Run records and per-contact locks. */
  STATE: KVNamespace;

  // ── Vars (wrangler.toml [vars]) ────────────────────────────
  /** The business the texts belong to; named in the prompt so Claude knows who "BUSINESS" is. */
  BUSINESS_NAME: string;
  /** Claude model used for the summary. */
  CLAUDE_MODEL: string;
  /** Time zone for the date stamps when the contact has none (IANA name). */
  SUMMARY_TIMEZONE?: string;
  /** Channels to read, comma-separated from sms,email,call,chat (default sms). */
  SUMMARY_CHANNELS?: string;
  /** Only texts from the last N days are summarised (default 35; 0 or "all" = no limit). A request can override it with "days". */
  SUMMARY_WINDOW_DAYS?: string;
  /** Tag added when the summary field is filled / when a run failed. */
  GHL_TAG_SUMMARY?: string;
  GHL_TAG_SUMMARY_FAILED?: string;
  /** Override for tests / proxies. Defaults to https://api.anthropic.com */
  ANTHROPIC_API_URL?: string;

  // ── Secrets ────────────────────────────────────────────────
  ANTHROPIC_API_KEY: string;
  /** Discount Plumbing's GHL Private Integration token. */
  GHL_TOKEN: string;
  /** Discount Plumbing's GHL sub-account (location) id. */
  GHL_LOCATION_ID: string;
  /** Shared secret the GHL webhook sends (?token=, x-summary-token header or Bearer). */
  SUMMARY_TOKEN: string;
}
