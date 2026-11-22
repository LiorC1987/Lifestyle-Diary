// Life Diary: writes a summary of a diary period with Claude.
//
// The app sends the period's report (the same Markdown as "Share report") and
// the names of meal photos already saved in the person's account. This function
// checks who is asking, starts a job (summary_jobs) and answers straight away; the
// summary is then written in the background, so the app may close meanwhile. The
// background part fetches the photos with the person's own sign-in (so the storage
// rules still apply), asks Claude, and keeps the answer in the summaries table.
// The Claude key lives only here, as the ANTHROPIC_API_KEY secret.

const MODEL = "claude-sonnet-5-5";
const MAX_PER_DAY = 10;          // summaries per person in 24 hours
const MAX_PHOTOS = 20;
const MAX_REPORT_CHARS = 160000;
const MAX_TOKENS = 16000;        // thinking and the summary together
const EFFORT = "medium";         // keeps a week's summary well inside the server's time limit

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
  "Format: Markdown with '## ' section headings, short paragraphs and '- ' bullet points. Simple Markdown tables are allowed where the report asks for them. No other headings.",
  "Write the sections in the order the report asks for them, and finish every section; keep the analysis sections within their word limits rather than cutting later sections short.",
].join("\n");

// Asked for on top of the summary; the app hides this block and keeps the numbers per day.
const ESTIMATES = [
  "",
  "After the summary, if you estimated any meals, add one last fenced code block with the language name estimates, holding JSON only:",
  '{"days":[{"date":"YYYY-MM-DD","eaten_kcal":0,"burned_kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0}]}',
  "One entry per day with meals logged in this period, using the middle of your ranges as whole numbers.",
  "Use the same numbers as in your summary. Set burned_kcal to null where you did not estimate calories burned. Do not mention this block in the summary.",
].join("\n");

type DayEstimate = { date: string; eaten_kcal: number | null; burned_kcal: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null };
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n < 100000 ? Math.round(n) : null;
}
/* Takes the estimates block out of Claude's answer and reads the numbers in it. */
function splitEstimates(text: string, start: string, end: string): { text: string; days: DayEstimate[] } {
  const m = text.match(/```\s*estimates\s*\n([\s\S]*?)```\s*$/i) || text.match(/```\s*estimates\s*\n([\s\S]*?)```/i);
  if (!m) {
    const open = text.search(/```\s*estimates/i);   // cut off before the block ended
    return { text: open >= 0 ? text.slice(0, open).trim() : text, days: [] };
  }
  const rest = text.replace(m[0], "").trim();
  try {
    const j = JSON.parse(m[1]);
    const days = (Array.isArray(j?.days) ? j.days : []).filter((d: { date?: unknown }) => isDate(d?.date) && String(d.date) >= start && String(d.date) <= end)
      .map((d: Record<string, unknown>) => ({ date: String(d.date), eaten_kcal: num(d.eaten_kcal), burned_kcal: num(d.burned_kcal), protein_g: num(d.protein_g), carbs_g: num(d.carbs_g), fat_g: num(d.fat_g) }))
      .filter((d: DayEstimate) => d.eaten_kcal != null);
    return { text: rest, days };
  } catch (_) {
    return { text: rest, days: [] };
  }
}

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

  // Only accounts the admin has approved may use the Claude credit (see approvals.sql).
  const access = await fetch(URL_BASE + "/rest/v1/rpc/my_access", {
    method: "POST", headers: { ...asUser, "Content-Type": "application/json" }, body: "{}",
  });
  const status = access.ok ? String((await access.json())?.status || "") : "";
  if (status !== "approved") {
    return fail(403, status === "rejected" ? "This account was not approved, so Claude summaries are not available."
      : "Your account is waiting for approval. Claude summaries start once it is approved.");
  }

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

  const adminHeaders: Record<string, string> = { apikey: SECRET, "Content-Type": "application/json" };
  if (!SECRET.startsWith("sb_")) adminHeaders.Authorization = "Bearer " + SECRET;   // legacy service_role key

  // A daily limit, so a stuck button cannot use up the credit.
  const since = new Date(Date.now() - 86400000).toISOString();
  const recent = await fetch(URL_BASE + "/rest/v1/summary_jobs?select=id&user_id=eq." + uid + "&created_at=gte." + encodeURIComponent(since), { headers: adminHeaders });
  if (recent.ok && (await recent.json()).length >= MAX_PER_DAY) {
    return fail(429, "That is " + MAX_PER_DAY + " summaries in the last day, the most allowed. Try again tomorrow.");
  }
  const started = await fetch(URL_BASE + "/rest/v1/summary_jobs", {
    method: "POST", headers: { ...adminHeaders, Prefer: "return=representation" },
    body: JSON.stringify({ user_id: uid, period, start_date: start }),
  });
  const job = started.ok ? (await started.json())[0] : null;
  if (!job) { console.error("job", started.status, await started.text()); return fail(500, "The summary could not be started. Try again."); }
  const finish = (status: "done" | "failed", error: string | null = null) => fetch(URL_BASE + "/rest/v1/summary_jobs?id=eq." + job.id, {
    method: "PATCH", headers: { ...adminHeaders, Prefer: "return=minimal" }, body: JSON.stringify({ status, error, finished_at: new Date().toISOString() }),
  });

  // Everything below runs after the app has its answer, so closing the app does not stop it.
  const work = async () => {
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
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, output_config: { effort: EFFORT }, system: SYSTEM + ESTIMATES, messages: [{ role: "user", content }] }),
    });
    const answer = await claude.json().catch(() => ({}));
    if (!claude.ok) {
      const msg = String(answer?.error?.message || "");
      console.error("Claude API error", claude.status, msg);
      return finish("failed", claude.status === 401 ? "The Claude key was not accepted. Check the ANTHROPIC_API_KEY secret in Supabase."
        : /credit balance/i.test(msg) ? "The Claude credit has run out. Add credit in the Claude Console."
        : claude.status === 429 || claude.status === 529 ? "Claude was busy. Try again in a minute."
        : "Claude could not write the summary (" + claude.status + ").");
    }
    const raw = (answer.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n").trim();
    const { text, days } = splitEstimates(raw, start, end);
    if (!text) return finish("failed", "Claude sent back an empty summary. Try again.");
    const finalText = answer.stop_reason === "max_tokens" ? text + "\n\n*This summary was cut short. Tap Ask again for the full version.*" : text;
    console.log("summary", period, "tokens in/out", answer.usage?.input_tokens, answer.usage?.output_tokens, "stop", answer.stop_reason);

    // Keep it, so it shows again next time without asking Claude.
    const row = {
      user_id: uid, period, start_date: start, end_date: end, text: finalText, model: answer.model || MODEL,
      input_tokens: answer.usage?.input_tokens ?? null, output_tokens: answer.usage?.output_tokens ?? null,
    };
    const saved = await fetch(URL_BASE + "/rest/v1/summaries", { method: "POST", headers: { ...adminHeaders, Prefer: "return=minimal" }, body: JSON.stringify(row) });
    if (!saved.ok) { console.error("Could not save summary", saved.status, await saved.text()); return finish("failed", "The summary could not be saved. Try again."); }

    // The day-by-day numbers, for the calorie balance history.
    if (days.length) {
      const estimates = days.map((d) => ({
        user_id: uid, day: d.date, eaten_kcal: d.eaten_kcal, burned_kcal: d.burned_kcal, protein_g: d.protein_g,
        carbs_g: d.carbs_g, fat_g: d.fat_g, source_period: period, updated_at: new Date().toISOString(),
      }));
      const put = await fetch(URL_BASE + "/rest/v1/daily_estimates?on_conflict=user_id,day", {
        method: "POST", headers: { ...adminHeaders, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(estimates),
      });
      if (!put.ok) console.error("Could not save estimates", put.status, await put.text());
    }
    return finish("done");
  };
  const running = work().catch((e) => { console.error("summary failed", String(e)); return finish("failed", "Something went wrong while writing the summary. Try again."); });
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(running); else await running;

  return reply(202, { job: job.id, period, start });
});
