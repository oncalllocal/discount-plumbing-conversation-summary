/**
 * Minimal Anthropic Messages API client for structured output.
 *
 * Every call forces a single tool ("tool_choice") so the model must return
 * JSON matching the tool's input_schema. Adds:
 *   • retries with backoff on 429/5xx/529 + network errors (honours retry-after)
 *   • automatic max_tokens escalation when output is truncated
 *   • one validation-repair round-trip (tool_result is_error) for semantic errors
 *   • prompt caching support via cache_control on system blocks
 */
import { fillDefaults, schemaProblems } from "./schemaCheck";
import type { Env } from "../env";
import { errorMessage, sleep } from "../lib/util";

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export type ContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface CallOptions<T> {
  system: SystemBlock[];
  messages: Message[];
  tool: ToolDef;
  maxTokens?: number;
  model?: string;
  /** Return a list of problems; non-empty triggers one repair round. */
  validate?: (data: T) => string[];
  label?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface CallResult<T> {
  data: T;
  usage: Usage;
  model: string;
}

interface ApiResponse {
  id: string;
  model: string;
  stop_reason: string;
  content: ContentBlock[];
  usage: Usage;
}

export class ClaudeError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

async function post(env: Env, body: Record<string, unknown>, label: string): Promise<ApiResponse> {
  if (!env.ANTHROPIC_API_KEY) throw new ClaudeError("ANTHROPIC_API_KEY is not set");
  const url = `${(env.ANTHROPIC_API_URL || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;
  let lastErr = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (res.ok) return JSON.parse(text) as ApiResponse;
      lastErr = `Claude ${label} HTTP ${res.status}: ${text.slice(0, 400)}`;
      if (!RETRYABLE.has(res.status)) throw new ClaudeError(lastErr, res.status);
      const ra = Number(res.headers.get("retry-after"));
      const wait = isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(45000, 2000 * 2 ** attempt) + Math.random() * 1000;
      await sleep(wait);
    } catch (e) {
      if (e instanceof ClaudeError) throw e;
      lastErr = `Claude ${label} network error: ${errorMessage(e)}`;
      await sleep(Math.min(30000, 1500 * 2 ** attempt));
    }
  }
  throw new ClaudeError(lastErr || `Claude ${label} failed`);
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: (a.cache_creation_input_tokens || 0) + (b.cache_creation_input_tokens || 0),
    cache_read_input_tokens: (a.cache_read_input_tokens || 0) + (b.cache_read_input_tokens || 0),
  };
}

/** A validator that throws (e.g. on a shape it didn't expect) counts as a problem, not a crash. */
function safeValidate<T>(v: (d: T) => string[], d: T): string[] {
  try {
    return v(d);
  } catch (e) {
    return [`output could not be checked: ${e instanceof Error ? e.message : String(e)}`];
  }
}

export async function callTool<T>(env: Env, opts: CallOptions<T>): Promise<CallResult<T>> {
  const model = opts.model || env.CLAUDE_MODEL || "claude-sonnet-5";
  const label = opts.label || opts.tool.name;
  let maxTokens = opts.maxTokens || 8000;
  let messages = [...opts.messages];
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let repaired = false;

  for (let round = 0; round < 4; round++) {
    const res = await post(
      env,
      {
        model,
        max_tokens: maxTokens,
        system: opts.system,
        messages,
        tools: [opts.tool],
        tool_choice: { type: "tool", name: opts.tool.name },
      },
      label,
    );
    usage = addUsage(usage, res.usage);
    const call = res.content.find((c): c is Extract<ContentBlock, { type: "tool_use" }> => c.type === "tool_use" && c.name === opts.tool.name);

    if (res.stop_reason === "max_tokens") {
      if (maxTokens >= 32000) throw new ClaudeError(`Claude ${label}: output still truncated at ${maxTokens} tokens`);
      maxTokens = Math.min(32000, Math.round(maxTokens * 1.7));
      continue;
    }
    if (!call) throw new ClaudeError(`Claude ${label}: no tool call in response (stop_reason=${res.stop_reason})`);

    const data = call.input as T;
    const structural = schemaProblems(opts.tool.input_schema, data);
    const problems = [...structural, ...(opts.validate && !structural.length ? safeValidate(opts.validate, data) : [])];
    if (!problems.length) return { data, usage, model: res.model };
    if (repaired) {
      // Still missing required fields after the repair round: fill empty values of the right type so
      // the renderer never reads undefined (an empty list just renders nothing).
      if (structural.length) {
        console.warn(`Claude ${label}: filled missing fields after repair: ${structural.slice(0, 10).join("; ")}`);
        return { data: fillDefaults(opts.tool.input_schema, data), usage, model: res.model };
      }
      return { data, usage, model: res.model };
    }

    // One repair round: show the model exactly what to fix.
    repaired = true;
    messages = [
      ...messages,
      { role: "assistant", content: res.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: call.id,
            is_error: true,
            content: `Please call ${opts.tool.name} again with the complete corrected output. Fix these problems:\n- ${problems.slice(0, 25).join("\n- ")}`,
          },
        ],
      },
    ];
  }
  throw new ClaudeError(`Claude ${label}: gave up after retries`);
}
