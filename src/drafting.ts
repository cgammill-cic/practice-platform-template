// Outreach drafting: one Claude call per person (Phase 2a, 2026-09-25).
//
// The app never SENDS anything. This produces a subject and body from what the record already says,
// under the rules the owner's outreach has always followed (Known. Remembered. Chosen., the cic-customer-eq
// skill): a meaningful reason to reach out, no pitch, one low-pressure ask, nothing invented.
//
// MODEL. Claude Opus 5 by default (the claude-api skill's standing default; the owner did not name one).
// A draft is ~2k tokens in and ~300 out, about 2 cents at Opus 5 prices. OUTREACH_MODEL overrides it.
//
// SHAPE OF THE REQUEST.
//   - The system prompt is FIXED TEXT (no names, dates or voice in it) and carries cache_control, so
//     repeated drafts in a run share the cached prefix. Everything that varies goes in the user turn.
//   - output_config.format json_schema returns {subject, body} as JSON; no prefill (removed on Opus 5).
//   - effort "medium": short, judgment-light writing; adaptive thinking stays on (Opus 5 default).
//   - fallbacks "default" (beta server-side-fallback-2026-07-01): if a safety classifier declines, the
//     API re-runs it on the recommended fallback model instead of returning a refusal. A refusal that
//     survives the chain is reported as an error on that one item, never a crash of the run.

import Anthropic from "@anthropic-ai/sdk";
import type { Bindings, Contact, D1Db, Interaction } from "./types";

export const DEFAULT_MODEL = "claude-opus-5";

/** $ per million tokens, from the claude-api skill's model table (cached 2026-06-24). Display only. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export interface DraftUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * Approximate cost in millionths of a dollar. Cache reads bill at ~0.1x and cache writes at ~1.25x of
 * the input price; an unknown model falls back to Opus 5 prices so the number errs high, not low.
 */
export function costMicros(model: string, u: DraftUsage): number {
  const p = PRICES[model] ?? PRICES[DEFAULT_MODEL];
  const input = u.input_tokens + u.cache_read_input_tokens * 0.1 + u.cache_creation_input_tokens * 1.25;
  return Math.round(input * p.input + u.output_tokens * p.output);
}

export const draftingConfigured = (env: Bindings) => !!env.ANTHROPIC_API_KEY?.trim();
export const modelFor = (env: Bindings) => env.OUTREACH_MODEL || DEFAULT_MODEL;

// ---------------------------------------------------------------- voice (a setting, per copy)

export const VOICE_KEY = "outreach_voice";
export interface Voice {
  sender: string;
  signoff: string;
  positioning: string;
}
/*
 * Neutral since Phase 3a (2026-09-25): a new copy drafts as its own first admin, with no positioning line
 * until the owner writes one on Outreach → Voice & limits. The owner's copy has his values saved as the
 * outreach_voice row, so nothing changed for him.
 */
export const DEFAULT_VOICE: Voice = { sender: "", signoff: "", positioning: "" };

export async function loadVoice(db: D1Db): Promise<Voice> {
  let v: Partial<Voice> = {};
  try {
    const row = await db.prepare("SELECT value FROM app_setting WHERE key = ?").bind(VOICE_KEY).first<{ value: string }>();
    v = row ? (JSON.parse(row.value) as Partial<Voice>) : {};
  } catch {
    /* no row or bad JSON: defaults below */
  }
  let sender = v.sender?.trim() || "";
  if (!sender) {
    const owner = await db
      .prepare("SELECT display_name FROM app_user WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1")
      .first<{ display_name: string }>()
      .catch(() => null);
    sender = owner?.display_name?.trim() || "";
  }
  return {
    sender,
    signoff: v.signoff?.trim() || sender.split(/\s+/)[0] || "",
    positioning: v.positioning?.trim() || "",
  };
}

export async function saveVoice(db: D1Db, v: Voice): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .bind(VOICE_KEY, JSON.stringify(v))
    .run();
}

// ---------------------------------------------------------------- the prompt

/** Fixed, so it caches. Nothing per-person, per-day or per-copy belongs in here. */
const SYSTEM_PROMPT = `You draft short, personal outreach messages that a consultant sends to people in their professional network. The sender reviews and edits every draft before anything is sent.

Principles:
- Give the person a real reason for this message, drawn only from what the record says: shared history, their role or company, something they cared about, a past conversation. Never write "just checking in" or "touching base".
- No pitch. Do not sell services, list capabilities, or ask for work. The goal is to stay known and remembered, so the tone is generous and specific.
- One low-pressure ask at most, easy to decline, such as a short call or a reply. Make it clear that no reply is needed if the timing is wrong.
- Use only facts present in the record. Never invent shared history, events, news, mutual contacts, titles or details. If the record is thin, write a warm, simple note that says less rather than guessing.
- Never claim attention or familiarity the record doesn't show: no "I've followed your work", "I've admired", "I noticed your recent...", "you've been on my mind", or "I realized I never...". A job title is a fact; what the person did in that job is not, unless the record says so.
- Describe the sender in one short clause at most, and only if it helps the reason for writing. Never describe the sender's services, clients or track record.
- When the record says its detail is thin (no notes and no interaction history), keep the message under 80 words: acknowledge the connection simply, show genuine interest in their current role, and ask one easy question.
- Plain, warm, direct language. Short paragraphs. No consultant jargon, hype or superlatives.
- Do not use em dashes or en dashes anywhere. Use commas, periods or parentheses instead.
- Write in the first person as the sender, and end with the sender's sign-off on its own line.
- Email: a specific subject line of under 60 characters about them, not the sender (not "Checking in", not "Hello from ..."), and a body of 60 to 140 words.
- LinkedIn message: no subject is needed (return an empty string), and a body under 600 characters with no formal greeting line beyond the person's first name.
- Follow-up after no reply: brief, no guilt, no "following up on my last email". Offer a different angle or an easy out.

Return only the requested JSON.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Email subject line, or an empty string for LinkedIn." },
    body: { type: "string", description: "The message body, ending with the sign-off." },
  },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

export interface DraftInput {
  contact: Contact & { organization_name?: string | null };
  referredBy?: string | null;
  interactions: Pick<Interaction, "date" | "type" | "direction" | "subject" | "summary">[];
  channel: "email" | "linkedin";
  kind: "first_touch" | "follow_up";
  previousMessages?: string[];
  instructions?: string | null;
  voice: Voice;
  today: string;
}

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** The per-person facts, as plain labelled lines. Blank fields are left out rather than sent empty. */
export function contactBrief(d: DraftInput): string {
  const c = d.contact;
  const lines: string[] = [];
  const add = (label: string, v: unknown) => {
    if (v !== null && v !== undefined && String(v).trim() !== "") lines.push(`${label}: ${String(v).trim()}`);
  };
  add("Name", c.full_name);
  add("Title", c.title);
  add("Company", c.organization_name);
  add("Department", c.department);
  add("Relationship stage", c.stage?.replace(/_/g, " "));
  add("Relationship strength", c.strength);
  add("In the sender's priority inner circle", c.is_priority ? "yes" : "");
  add("Referred to the sender by", d.referredBy);
  add("Last touch", c.last_touch);
  add("Notes", clip(c.notes, 1200));
  const history = d.interactions
    .map((i) => `- ${i.date} ${i.type}${i.direction ? ` (${i.direction})` : ""}: ${clip(i.subject, 120)}${i.summary ? `. ${clip(i.summary, 300)}` : ""}`)
    .join("\n");
  // Said out loud so the model writes less, rather than filling a bare record with guesses (2026-09-25:
  // the first real run drafted four contacts with no notes or history, and one draft invented familiarity).
  const thin = !c.notes?.trim() && !d.interactions.length;
  return `${lines.join("\n")}\n\nRecent interactions (newest first):\n${history || "- none recorded"}\n\nRecord detail: ${thin ? "thin (no notes and no interaction history)" : "has notes or history"}`;
}

export function userPrompt(d: DraftInput): string {
  const parts = [
    `Sender: ${d.voice.sender || "(not set: write in the first person and leave the sign-off as a blank line)"}`,
    `Sender sign-off: ${d.voice.signoff || "(none)"}`,
    ...(d.voice.positioning ? [`About the sender (context only, do not pitch it): ${d.voice.positioning}`] : []),
    `Today: ${d.today}`,
    `Channel: ${d.channel === "email" ? "email" : "LinkedIn message"}`,
    `Message type: ${d.kind === "first_touch" ? "first touch in this outreach cycle" : "follow-up after no reply"}`,
    "",
    "The person:",
    contactBrief(d),
  ];
  if (d.previousMessages?.length) parts.push("", "Earlier messages in this outreach (no reply yet):", ...d.previousMessages.map((m, i) => `[${i + 1}] ${clip(m, 800)}`));
  if (d.instructions?.trim()) parts.push("", `Sender's note for this draft: ${clip(d.instructions, 400)}`);
  return parts.join("\n");
}

/**
 * The house rule is "no em or en dashes" in anything customer-facing. The prompt says so; this is the
 * belt to its braces, because one slipped dash is exactly the kind of thing a reader notices.
 */
export function stripDashes(s: string): string {
  return s
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/ ,/g, ",");
}

export interface DraftResult {
  subject: string;
  body: string;
  model: string;
  usage: DraftUsage;
}

export class DraftError extends Error {}

/**
 * An Anthropic error, in words the page can show. The known setup mistakes get an instruction; anything
 * else gets the API's own message, pulled out of the JSON it arrives wrapped in, never the raw payload
 * (the first real run showed a wall of escaped JSON on every card).
 */
export function apiErrorText(status: number | undefined, raw: string): string {
  if (/not scoped to a workspace/i.test(raw))
    return "This API key isn't assigned to a workspace. Create the key inside a workspace (for example Default) at console.anthropic.com, then update the ANTHROPIC_API_KEY secret.";
  if (/credit balance is too low/i.test(raw))
    return "Your Anthropic credit balance is too low. Add credits under Billing at console.anthropic.com.";
  const inner = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1]?.replace(/\\"/g, '"');
  return `Anthropic couldn't draft this (${status ?? "error"}): ${inner ?? raw}`.slice(0, 300);
}

export async function draftMessage(env: Bindings, d: DraftInput): Promise<DraftResult> {
  if (!env.ANTHROPIC_API_KEY) throw new DraftError("Drafting isn't set up: add the ANTHROPIC_API_KEY secret.");
  const client = new Anthropic({
    // Trimmed: a space or line break picked up when pasting into the dashboard makes Anthropic reject
    // an otherwise good key, and the dashboard shows nothing once it is saved as a secret.
    apiKey: env.ANTHROPIC_API_KEY.trim(),
    ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
    // Resolve fetch at call time, so the Worker's (and a test's) global fetch is what's used.
    fetch: (input, init) => fetch(input, init),
    maxRetries: 2,
  });
  const model = modelFor(env);
  let res: Anthropic.Beta.BetaMessage;
  try {
    res = await client.beta.messages.create({
      model,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: [{ role: "user", content: userPrompt(d) }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new DraftError("Anthropic rejected the API key. Check the ANTHROPIC_API_KEY secret.");
    if (e instanceof Anthropic.RateLimitError) throw new DraftError("Anthropic rate limit reached. Try again in a minute.");
    if (e instanceof Anthropic.APIError) throw new DraftError(apiErrorText(e.status, e.message));
    throw new DraftError(`Could not reach Anthropic: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
  }
  if (res.stop_reason === "refusal") throw new DraftError("The model declined to draft this one. Write it by hand.");
  if (res.stop_reason === "max_tokens") throw new DraftError("The draft was cut off. Try Redraft.");
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  let parsed: { subject?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DraftError("The draft came back in an unexpected format. Try Redraft.");
  }
  const body = typeof parsed.body === "string" ? stripDashes(parsed.body.trim()) : "";
  if (!body) throw new DraftError("The draft came back empty. Try Redraft.");
  const subject = d.channel === "email" && typeof parsed.subject === "string" ? stripDashes(parsed.subject.trim()) : "";
  const u = res.usage;
  return {
    subject,
    body,
    model: res.model || model,
    usage: {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}
