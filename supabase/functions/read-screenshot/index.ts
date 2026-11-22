// Life Diary: reads a workout (Apple Fitness, Garmin, Strava, a gym machine...) or a smart-scale
// measurement (weight and body composition) from a screenshot. Body: {image, today, kind?, types?};
// kind is "workout" (the default) or "scale".
//
// The app sends one shrunken JPEG. This function checks the sign-in and the account's
// approval, keeps to a daily limit, asks Claude to read the workout, and returns the
// numbers. The screenshot itself is not stored anywhere.

const MODEL = "claude-sonnet-5-5";
const MAX_PER_DAY = 30;
const MAX_IMAGE_BYTES = 3_000_000;

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
function adminHeaders(extra: Record<string, string> = {}) {
  const h: Record<string, string> = { apikey: SECRET, "Content-Type": "application/json", ...extra };
  if (!SECRET.startsWith("sb_")) h.Authorization = "Bearer " + SECRET;   // legacy service_role key
  return h;
}

function num(v: unknown, max: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n * 100) / 100 : null;
}
function hhmm(v: unknown): string | null {
  const m = typeof v === "string" ? v.trim().match(/^(\d{1,2}):(\d{2})$/) : null;
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? m[1].padStart(2, "0") + ":" + m[2] : null;
}
function isDate(s: unknown): s is string { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }

async function askClaude(image: string, ask: string, apiKey: string): Promise<{ json?: Record<string, unknown>; error?: Response }> {
  const claude = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
      { type: "text", text: ask },
    ] }] }),
  });
  const answer = await claude.json().catch(() => ({}));
  if (!claude.ok) {
    const msg = String(answer?.error?.message || "");
    console.error("Claude API error", claude.status, msg);
    if (/credit balance/i.test(msg)) return { error: fail(402, "The Claude credit has run out. Add credit in the Claude Console.") };
    if (claude.status === 429 || claude.status === 529) return { error: fail(503, "Claude is busy right now. Try again in a minute.") };
    return { error: fail(502, "Claude could not read the screenshot (" + claude.status + ").") };
  }
  const text = (answer.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  try { return { json: m ? JSON.parse(m[0]) : {} }; } catch (_) { return { json: {} }; }
}

/* A smart-scale screen: weight and body composition, all masses in kg. */
async function readScale(image: string, today: string, apiKey: string, uid: string): Promise<Response> {
  const ask = [
    "This is a screenshot from a smart scale's app. Read the measurement it shows and answer with JSON only, no other text:",
    '{"is_measurement": true, "date": "YYYY-MM-DD or null", "time": "HH:MM (24-hour) or null", "weight_kg": number or null, "body_fat_pct": number or null, ' +
      '"muscle_mass_kg": number or null, "skeletal_muscle_pct": number or null, "fat_free_kg": number or null, "visceral_fat": number or null, ' +
      '"body_water_pct": number or null, "bone_mass_kg": number or null, "protein_pct": number or null, "subcutaneous_fat_pct": number or null, "bmr_kcal": number or null}',
    "Rules: convert pounds to kilograms (1 lb = 0.4536 kg) and stones to kilograms. Read dates in the format the app uses (11/22/2026 is 22 November 2026). " +
      "Use null for anything not shown or cut off; never guess. Today is " + today + ". If the screenshot shows no scale measurement, answer {\"is_measurement\": false}.",
  ].join("\n");
  const r = await askClaude(image, ask, apiKey);
  if (r.error) return r.error;
  await fetch(URL_BASE + "/rest/v1/screenshot_reads", { method: "POST", headers: adminHeaders({ Prefer: "return=minimal" }), body: JSON.stringify({ user_id: uid }) });
  const j = r.json || {};
  if (!j.is_measurement) return fail(422, "Claude could not find a scale measurement in this screenshot.");
  const date = isDate(j.date) && j.date <= today ? j.date : null;
  return reply(200, {
    date, time: hhmm(j.time), weight_kg: num(j.weight_kg, 400), body_fat_pct: num(j.body_fat_pct, 75), muscle_mass_kg: num(j.muscle_mass_kg, 200),
    skeletal_muscle_pct: num(j.skeletal_muscle_pct, 80), fat_free_kg: num(j.fat_free_kg, 250), visceral_fat: num(j.visceral_fat, 60),
    body_water_pct: num(j.body_water_pct, 90), bone_mass_kg: num(j.bone_mass_kg, 20), protein_pct: num(j.protein_pct, 40),
    subcutaneous_fat_pct: num(j.subcutaneous_fat_pct, 75), bmr_kcal: num(j.bmr_kcal, 5000),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "Use POST.");

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return fail(401, "Sign in first.");
  const asUser = { apikey: PUBLISHABLE, Authorization: "Bearer " + token };
  const who = await fetch(URL_BASE + "/auth/v1/user", { headers: asUser });
  if (!who.ok) return fail(401, "Your sign-in has run out. Sign in again.");
  const uid: string = (await who.json()).id;

  // Only accounts the admin has approved may use the Claude credit (see approvals.sql).
  const access = await fetch(URL_BASE + "/rest/v1/rpc/my_access", { method: "POST", headers: { ...asUser, "Content-Type": "application/json" }, body: "{}" });
  const status = access.ok ? String((await access.json())?.status || "") : "";
  if (status !== "approved") {
    return fail(403, status === "rejected" ? "This account was not approved, so reading screenshots is not available."
      : "Your account is waiting for approval. Reading screenshots starts once it is approved.");
  }

  let body: { image?: string; today?: string; types?: string[]; kind?: string };
  try { body = await req.json(); } catch (_) { return fail(400, "The request was not readable."); }
  const image = String(body.image || "").replace(/^data:image\/jpeg;base64,/, "");
  if (!image || !/^[A-Za-z0-9+/=]+$/.test(image)) return fail(400, "No screenshot was sent.");
  if (image.length * 0.75 > MAX_IMAGE_BYTES) return fail(413, "The screenshot is too large.");
  const today = isDate(body.today) ? body.today : new Date().toISOString().slice(0, 10);
  const types = (Array.isArray(body.types) ? body.types : []).filter((t) => typeof t === "string" && t.length < 40).slice(0, 40);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return fail(503, "The Claude key is missing.");

  const since = new Date(Date.now() - 86400000).toISOString();
  const recent = await fetch(URL_BASE + "/rest/v1/screenshot_reads?select=id&user_id=eq." + uid + "&created_at=gte." + encodeURIComponent(since), { headers: adminHeaders() });
  if (recent.ok && (await recent.json()).length >= MAX_PER_DAY) return fail(429, "That is " + MAX_PER_DAY + " screenshots in the last day, the most allowed. Try again tomorrow.");

  if (body.kind === "scale") return await readScale(image, today, apiKey, uid);

  const ask = [
    "This is a screenshot from a fitness app, a watch or a gym machine. Read the workout it shows and answer with JSON only, no other text:",
    '{"is_workout": true, "name": "the workout name as shown", "type": "one of the listed types, or null", "date": "YYYY-MM-DD or null", ' +
      '"start": "HH:MM (24-hour) or null", "end": "HH:MM (24-hour) or null", "duration_min": number or null, "distance_km": number or null, ' +
      '"active_kcal": number or null, "total_kcal": number or null, "avg_hr": number or null}',
    "Rules: duration_min is the workout or moving time in minutes (24:18 is 24.3). Convert miles to km (1 mi = 1.609 km). " +
      "Use null for anything not shown; never guess. Today is " + today + ": if the date has no year, use the most recent such date not after today; " +
      "\"Today\" and \"Yesterday\" count from today. If the screenshot shows no workout, answer {\"is_workout\": false}.",
    "Types to choose from (pick the closest, such as Walk for an outdoor or indoor walk; null if none fits): " + types.join(", "),
  ].join("\n");
  const claude = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
      { type: "text", text: ask },
    ] }] }),
  });
  const answer = await claude.json().catch(() => ({}));
  if (!claude.ok) {
    const msg = String(answer?.error?.message || "");
    console.error("Claude API error", claude.status, msg);
    if (/credit balance/i.test(msg)) return fail(402, "The Claude credit has run out. Add credit in the Claude Console.");
    if (claude.status === 429 || claude.status === 529) return fail(503, "Claude is busy right now. Try again in a minute.");
    return fail(502, "Claude could not read the screenshot (" + claude.status + ").");
  }
  await fetch(URL_BASE + "/rest/v1/screenshot_reads", { method: "POST", headers: adminHeaders({ Prefer: "return=minimal" }), body: JSON.stringify({ user_id: uid }) });

  const text = (answer.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  let j: Record<string, unknown> = {};
  try { j = m ? JSON.parse(m[0]) : {}; } catch (_) { j = {}; }
  if (!j.is_workout) return fail(422, "Claude could not find a workout in this screenshot.");
  const type = typeof j.type === "string" && types.includes(j.type) ? j.type : null;
  const date = isDate(j.date) && j.date <= today ? j.date : null;
  return reply(200, {
    name: typeof j.name === "string" ? j.name.slice(0, 60) : null, type, date,
    start: hhmm(j.start), end: hhmm(j.end), duration_min: num(j.duration_min, 1440), distance_km: num(j.distance_km, 1000),
    active_kcal: num(j.active_kcal, 10000), total_kcal: num(j.total_kcal, 15000), avg_hr: num(j.avg_hr, 250),
  });
});
