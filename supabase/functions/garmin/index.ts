// Life Diary: Garmin sync through Garmin Connect's Personal API.
//
// Actions (POST JSON {action, ...}):
//   connect    {apiKey}       check the key with Garmin, then keep it for this account
//   sync       {start, end}   read workouts, sleep and steps for those days and return them
//   disconnect                forget the key
//   status                    whether a key is kept
// The key and the 24-hour access token stay in the garmin_links table, which only this
// function can read. The app gets back only the diary data.

const GARMIN = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const MAX_DAYS = 31;

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
function admin(extra: Record<string, string> = {}) {
  const h: Record<string, string> = { apikey: SECRET, "Content-Type": "application/json", ...extra };
  if (!SECRET.startsWith("sb_")) h.Authorization = "Bearer " + SECRET;   // legacy service_role key
  return h;
}
function isDate(s: unknown): s is string { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function addDays(iso: string, n: number) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function n(v: unknown): number | null { const x = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN; return Number.isFinite(x) ? x : null; }
function list(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v && typeof v === "object") for (const k of ["data", "values", "activityList", "activities", "items"]) {
    const inner = (v as Record<string, unknown>)[k];
    if (Array.isArray(inner)) return inner as Record<string, unknown>[];
  }
  return [];
}
function keysOf(v: unknown) { return v && typeof v === "object" ? Object.keys(v as object).slice(0, 40).join(",") : typeof v; }

type Link = { api_key: string; access_token: string | null; token_expires_at: string | null };
async function linkOf(uid: string): Promise<Link | null> {
  const r = await fetch(URL_BASE + "/rest/v1/garmin_links?select=api_key,access_token,token_expires_at&user_id=eq." + uid, { headers: admin() });
  const rows = r.ok ? await r.json() : [];
  return rows[0] || null;
}
async function newToken(apiKey: string): Promise<{ token: string; expires: string } | { error: number }> {
  const r = await fetch(GARMIN + TOKEN_PATH, { method: "POST", headers: { Accept: "*/*", Authorization: "ApiKey " + apiKey } });
  if (!r.ok) return { error: r.status };
  const token = (await r.text()).trim();
  let expires = new Date(Date.now() + 23 * 3600000).toISOString();
  try { const exp = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp; if (exp) expires = new Date(exp * 1000).toISOString(); } catch (_) { /* keep 23 h */ }
  return { token, expires };
}

const TYPE_MAP: [RegExp, string][] = [
  [/walk/, "Walk"], [/run/, "Run"], [/cycl|bik|spin/, "Cycling"], [/swim/, "Swimming"], [/pilates/, "Pilates"], [/yoga/, "Yoga"],
  [/strength|weight|gym|cardio_training|hiit|fitness_equipment/, "Gym"], [/hik/, "Hiking"], [/danc/, "Dancing"], [/stretch|mobility/, "Stretching"],
  [/trampoline/, "Trampoline"],
];
function diaryType(typeKey: string, name: string): string {
  const k = (typeKey || "").toLowerCase();
  for (const [re, t] of TYPE_MAP) if (re.test(k)) return t;
  return name || (k ? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Workout");
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
  const access = await fetch(URL_BASE + "/rest/v1/rpc/my_access", { method: "POST", headers: { ...asUser, "Content-Type": "application/json" }, body: "{}" });
  const status = access.ok ? String((await access.json())?.status || "") : "";
  if (status !== "approved") return fail(403, "Garmin sync starts once your account is approved.");

  let body: { action?: string; apiKey?: string; start?: string; end?: string };
  try { body = await req.json(); } catch (_) { return fail(400, "The request was not readable."); }

  if (body.action === "status") return reply(200, { connected: !!(await linkOf(uid)) });

  if (body.action === "disconnect") {
    await fetch(URL_BASE + "/rest/v1/garmin_links?user_id=eq." + uid, { method: "DELETE", headers: admin() });
    return reply(200, { connected: false });
  }

  if (body.action === "connect") {
    const key = String(body.apiKey || "").trim();
    if (key.length < 10 || key.length > 4000 || /\s/.test(key)) return fail(400, "That does not look like a Garmin personal API key.");
    const t = await newToken(key);
    if ("error" in t) return fail(400, t.error === 401 || t.error === 403 ? "Garmin did not accept this key. Check it was copied whole and has not expired." : "Garmin could not be reached (" + t.error + "). Try again later.");
    const row = { user_id: uid, api_key: key, access_token: t.token, token_expires_at: t.expires };
    const put = await fetch(URL_BASE + "/rest/v1/garmin_links?on_conflict=user_id", { method: "POST", headers: admin({ Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(row) });
    if (!put.ok) { console.error("save key", put.status, await put.text()); return fail(500, "The key could not be saved. Try again."); }
    return reply(200, { connected: true });
  }

  if (body.action !== "sync") return fail(400, "Unknown action.");
  const start = body.start, end = body.end;
  if (!isDate(start) || !isDate(end) || start > end || addDays(start, MAX_DAYS) < end) return fail(400, "Ask for up to " + MAX_DAYS + " days at a time.");
  const link = await linkOf(uid);
  if (!link) return fail(409, "Garmin is not connected. Add your key under Trackers → Garmin sync.");

  // A fresh access token when the kept one has under an hour left.
  let bearer = link.access_token || "";
  if (!bearer || !link.token_expires_at || Date.parse(link.token_expires_at) - Date.now() < 3600000) {
    const t = await newToken(link.api_key);
    if ("error" in t) return fail(t.error === 401 || t.error === 403 ? 410 : 502, t.error === 401 || t.error === 403
      ? "Garmin no longer accepts your key; it may have expired. Make a new one in Garmin Connect and add it again." : "Garmin could not be reached. Try again later.");
    bearer = t.token;
    await fetch(URL_BASE + "/rest/v1/garmin_links?user_id=eq." + uid, { method: "PATCH", headers: admin({ Prefer: "return=minimal" }), body: JSON.stringify({ access_token: t.token, token_expires_at: t.expires }) });
  }
  const get = async (path: string) => {
    const r = await fetch(GARMIN + path, { headers: { Accept: "application/json", Authorization: "Bearer " + bearer } });
    if (!r.ok) { console.error("Garmin", r.status, path.split("?")[0]); return null; }
    return await r.json().catch(() => null);
  };

  // Workouts.
  const acts = list(await get("/activitylist-service/activities/search/activities?start=0&limit=100&startDate=" + start + "&endDate=" + end));
  if (acts[0]) console.log("activity fields:", keysOf(acts[0]));
  const activities = acts.map((a) => {
    const local = String(a.startTimeLocal || a.startTimeGMT || "");
    const date = local.slice(0, 10), startTime = local.slice(11, 16);
    const secs = n(a.duration) ?? n(a.elapsedDuration) ?? n(a.movingDuration);
    const total = n(a.calories), bmr = n(a.bmrCalories);
    const active = n(a.activeKilocalories) ?? n(a.activeCalories) ?? (total != null && bmr != null ? total - bmr : null);
    const typeKey = String(((a.activityType as Record<string, unknown>) || {}).typeKey || "");
    let endTime: string | null = null;
    if (secs && /^\d\d:\d\d$/.test(startTime)) { const m = (+startTime.slice(0, 2) * 60 + +startTime.slice(3) + Math.round(secs / 60)) % 1440; endTime = String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }
    return {
      garminId: String(a.activityId || ""), name: diaryType(typeKey, String(a.activityName || "")), shownName: String(a.activityName || ""),
      date, start: startTime || null, end: endTime, durationMin: secs ? Math.max(1, Math.round(secs / 60)) : null,
      distanceKm: n(a.distance) ? Math.round((n(a.distance) as number) / 10) / 100 : null,
      activeKcal: active != null && active > 0 ? Math.round(active) : null, totalKcal: total != null && total > 0 ? Math.round(total) : null,
      avgHr: n(a.averageHR) ?? n(a.avgHr), 
    };
  }).filter((a) => a.garminId && isDate(a.date) && a.date >= start && a.date <= end && a.durationMin);

  // Sleep, one call per night (the day you woke up).
  const sleep: { date: string; minutes: number; score: number | null }[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const s = await get("/sleep-service/sleep/dailySleep?date=" + d);
    if (!s) continue;
    const dto = ((s as Record<string, unknown>).dailySleepDTO || s) as Record<string, unknown>;
    if (d === start) console.log("sleep fields:", keysOf(dto));
    const secs = n(dto.sleepTimeSeconds) ?? ((n(dto.deepSleepSeconds) ?? 0) + (n(dto.lightSleepSeconds) ?? 0) + (n(dto.remSleepSeconds) ?? 0) || null);
    const scores = (dto.sleepScores || {}) as Record<string, Record<string, unknown>>;
    if (secs && secs > 0) sleep.push({ date: isDate(dto.calendarDate) ? dto.calendarDate as string : d, minutes: Math.round(secs / 60), score: n(scores.overall?.value) });
  }

  // Steps per day.
  const stepRows = list(await get("/usersummary-service/stats/steps/daily/" + start + "/" + end));
  if (stepRows[0]) console.log("steps fields:", keysOf(stepRows[0]));
  const steps = stepRows.map((s) => ({ date: String(s.calendarDate || s.date || ""), steps: n(s.totalSteps) ?? n(s.steps) }))
    .filter((s) => isDate(s.date) && s.steps != null && (s.steps as number) > 0);

  await fetch(URL_BASE + "/rest/v1/garmin_links?user_id=eq." + uid, { method: "PATCH", headers: admin({ Prefer: "return=minimal" }), body: JSON.stringify({ last_sync_at: new Date().toISOString() }) });
  return reply(200, { activities, sleep, steps });
});
