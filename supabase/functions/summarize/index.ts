// Life Diary: writes a summary of a diary period with Claude.
//
// The app sends the period's report (the same Markdown as "Share report") and
// the names of meal photos already saved in the person's account. This function
// checks who is asking, fetches those photos with the person's own sign-in (so
// the storage rules still apply), asks Claude, and keeps the answer in the
// summaries table. The Claude key lives only here, as the ANTHROPIC_API_KEY secret.

const MODEL = "claude-sonnet-5-5";
const MAX_PER_DAY = 10;          // summaries per person in 24 hours
const MAX_PHOTOS = 20;
const MAX_REPORT_CHARS = 120000;

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
function namedKey(jsonVar: string, legacyVar: string): string {
  try {
    const all = JSON.parse(Deno.env.get(jsonVar) || "{}");
    if (all && typeof all === "object" && (all.default || Object.values(all)[0])) return String(all.default || Object.values(all)[0]);
  } catch (_) { /* fall back to the legacy key */ }
  return Deno.env.get(legacyVar) || "";
}
const PUBLISHABLE = namedKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
const SECRET = namedKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function fail(status: number, message: string) { return reply(status, { error: message }); }

const SYSTEM = [
  "You write summaries of a person's own diary for them. The summary appears inside their diary app.",
  "Follow the instructions at the top of the report.",
  "The reader cannot reply to you here, so do not ask questions or offer to do more.",
  "Write in the language most of the diary entries are written in; if that is unclear, write in English.",
  "Format: Markdown with '## ' section headings, short paragraphs and '- ' bullet points. A simple Markdown table is allowed only in the nutrition estimate. No other headings.",
].join("\n");

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function isDate(s: unknown): s is string { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "Use POST.");

  // Who is asking: the person's sign-in token, checked by Supabase Auth.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return fail(401, "Sign in first.");
  const asUser = { apikey: PUBLISHABLE, Authorization: "Bearer " + token };
  const who = await fetch(URL_BASE + "/auth/v1/user", { headers: asUser });
  if (!who.ok) return fail(401, "Your sign-in has run out. Sign in again.");
  const user = await who.json();
  const uid: string = user.id;

  let body: { period?: string; start?: string; end?: string; report?: string; photos?: string[] };
  try { body = await req.json(); } catch (_) { return fail(400, "The request was not readable."); }
  const period = body.period, start = body.start, end = body.end, report = body.report;
  if (!["day", "week", "month"].includes(String(period)) || !isDate(start) || !isDate(end)) return fail(400, "Missing period.");
  if (typeof report !== "string" || !report.trim()) return fail(400, "The report is empty.");
  if (report.length > MAX_REPORT_CHARS) return fail(413, "This period is too long to summarize in one go.");
  const photos = (Array.isArray(body.photos) ? body.photos : [])
    .filter((n) => typeof n === "string" && /^ld-photo-[\w.-]+\.jpg$/.test(n)).slice(0, MAX_PHOTOS);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return fail(503, "Claude summaries are not set up yet: the Claude key is missing.");

  // A daily limit, so a stuck button cannot use up the credit.
  const since = new Date(Date.now() - 86400000).toISOString();
  const recent = await fetch(URL_BASE + "/rest/v1/summaries?select=id&created_at=gte." + encodeURIComponent(since), { headers: asUser });
  if (recent.ok && (await recent.json()).length >= MAX_PER_DAY) {
    return fail(429, "That is " + MAX_PER_DAY + " summaries in the last day, the most allowed. Try again tomorrow.");
  }

  // Meal photos, fetched with the person's own sign-in.
  const content: unknown[] = [];
  for (const name of photos) {
    const r = await fetch(URL_BASE + "/storage/v1/object/authenticated/photos/" + encodeURIComponent(uid) + "/" + encodeURIComponent(name), { headers: asUser });
    if (!r.ok) continue;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > 4_000_000) continue;
    content.push({ type: "text", text: "Photo file: " + name });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: toBase64(bytes) } });
  }
  content.push({ type: "text", text: report });

  const claude = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 6000, system: SYSTEM, messages: [{ role: "user", content }] }),
  });
  const answer = await claude.json().catch(() => ({}));
  if (!claude.ok) {
    const msg = String(answer?.error?.message || "");
    console.error("Claude API error", claude.status, msg);
    if (claude.status === 401) return fail(502, "The Claude key was not accepted. Check the ANTHROPIC_API_KEY secret in Supabase.");
    if (/credit balance/i.test(msg)) return fail(402, "The Claude credit has run out. Add credit in the Claude Console.");
    if (claude.status === 429 || claude.status === 529) return fail(503, "Claude is busy right now. Try again in a minute.");
    return fail(502, "Claude could not write the summary (" + claude.status + ").");
  }
  const text = (answer.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n").trim();
  if (!text) return fail(502, "Claude sent back an empty summary. Try again.");
  // Room for Claude's thinking plus the answer is generous, but say so if it still ran out.
  const finalText = answer.stop_reason === "max_tokens" ? text + "\n\n*This summary was cut short. Tap Ask again for the full version.*" : text;

  // Keep it, so it shows again next time without asking Claude.
  const row = {
    user_id: uid, period, start_date: start, end_date: end, text: finalText, model: answer.model || MODEL,
    input_tokens: answer.usage?.input_tokens ?? null, output_tokens: answer.usage?.output_tokens ?? null,
  };
  const saveHeaders: Record<string, string> = { apikey: SECRET, "Content-Type": "application/json", Prefer: "return=representation" };
  if (!SECRET.startsWith("sb_")) saveHeaders.Authorization = "Bearer " + SECRET;   // legacy service_role key
  const saved = await fetch(URL_BASE + "/rest/v1/summaries", { method: "POST", headers: saveHeaders, body: JSON.stringify(row) });
  let createdAt = new Date().toISOString();
  if (saved.ok) { const rows = await saved.json(); if (rows?.[0]?.created_at) createdAt = rows[0].created_at; }
  else console.error("Could not save summary", saved.status, await saved.text());

  return reply(200, { text: finalText, created_at: createdAt, period, start });
});
