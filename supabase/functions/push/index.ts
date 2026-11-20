// Life Diary: phone notifications (Web Push).
//
// From the app (signed in, approved account):
//   publicKey                                       the key phones need to subscribe
//   subscribe   {subscription, timeZone, dailyTime, weekly}
//   update      {endpoint, timeZone, dailyTime, weekly}
//   unsubscribe {endpoint}
//   test        {endpoint}                          sends one notification now
// From the schedule (every 15 minutes, header x-tick-secret):
//   tick        sends the daily reminder and the Sunday "last week is ready" note when due
// The push keys are made here on first use and kept in app_secrets; nobody has to copy them.

import webpush from "npm:web-push@3.6.7";

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
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tick-secret",
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
async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(URL_BASE + "/rest/v1/" + path, { ...init, headers: admin((init.headers || {}) as Record<string, string>) });
  if (!r.ok) { console.error("rest", r.status, path.split("?")[0], await r.text()); return null; }
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}
async function secret(name: string): Promise<string | null> {
  const rows = await rest("app_secrets?select=value&name=eq." + name);
  return rows && rows[0] ? rows[0].value : null;
}
async function vapid(): Promise<{ publicKey: string; privateKey: string }> {
  let pub = await secret("vapid_public"), priv = await secret("vapid_private");
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    await rest("app_secrets?on_conflict=name", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify([{ name: "vapid_public", value: k.publicKey }, { name: "vapid_private", value: k.privateKey }]) });
    pub = await secret("vapid_public"); priv = await secret("vapid_private");   // whichever pair was saved first
  }
  return { publicKey: pub!, privateKey: priv! };
}
function validTime(t: unknown): string | null { return typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : null; }
function validZone(z: unknown): string {
  try { if (typeof z === "string" && z.length < 60) { new Intl.DateTimeFormat("en", { timeZone: z }); return z; } } catch (_) { /* not a zone */ }
  return "UTC";
}

type Sub = { endpoint: string; user_id: string; p256dh: string; auth: string; time_zone: string; daily_time: string | null; weekly: boolean; last_daily_sent: string | null; last_weekly_sent: string | null };
async function send(keys: { publicKey: string; privateKey: string }, sub: Sub, msg: Record<string, string>): Promise<"ok" | "gone" | "failed"> {
  try {
    const d = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(msg),
      { vapidDetails: { subject: "https://liorc1987.github.io/Lifestyle-Diary/", publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 6 * 3600, urgency: "normal" });
    const r = await fetch(d.endpoint, { method: d.method, headers: d.headers as Record<string, string>, body: d.body });
    if (r.status === 404 || r.status === 410) return "gone";
    if (!r.ok) { console.error("push", r.status, await r.text()); return "failed"; }
    return "ok";
  } catch (e) { console.error("push error", String(e)); return "failed"; }
}
function localNow(zone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: parts.year + "-" + parts.month + "-" + parts.day, time: parts.hour + ":" + parts.minute, weekday: parts.weekday };
}
function minutes(t: string) { return +t.slice(0, 2) * 60 + +t.slice(3, 5); }

async function tick() {
  const subs: Sub[] = (await rest("push_subscriptions?select=*")) || [];
  if (!subs.length) return { sent: 0 };
  const keys = await vapid();
  const approved = new Set(((await rest("accounts?select=user_id&status=eq.approved")) || []).map((a: { user_id: string }) => a.user_id));
  const diaries: Record<string, Record<string, unknown> | null> = {};
  const diaryOf = async (uid: string) => {
    if (!(uid in diaries)) { const rows = await rest("diaries?select=data&user_id=eq." + uid); diaries[uid] = rows && rows[0] ? rows[0].data : null; }
    return diaries[uid];
  };
  let sent = 0;
  for (const sub of subs) {
    if (!approved.has(sub.user_id)) continue;
    const now = localNow(sub.time_zone || "UTC"), nowMin = minutes(now.time);
    const patch: Record<string, string> = {};
    let gone = false;
    // Daily reminder: from the chosen time, for up to three hours, unless today's mood is already in.
    if (sub.daily_time && sub.last_daily_sent !== now.date && nowMin >= minutes(sub.daily_time) && nowMin < minutes(sub.daily_time) + 180) {
      const diary = await diaryOf(sub.user_id);
      const moods = (diary?.moods || []) as { localDate: string }[];
      if (moods.some((m) => m.localDate === now.date)) patch.last_daily_sent = now.date;
      else {
        const r = await send(keys, sub, { title: "Life Diary", body: "How was today? Tap your mood and check your meals.", tag: "daily", url: "./?open=today" });
        if (r === "gone") gone = true; else if (r === "ok") { patch.last_daily_sent = now.date; sent++; }
      }
    }
    // Sunday morning: the week (Sunday to Saturday) is over.
    if (!gone && sub.weekly && now.weekday === "Sun" && sub.last_weekly_sent !== now.date && nowMin >= 9 * 60 && nowMin < 21 * 60) {
      const diary = await diaryOf(sub.user_id);
      const settings = (diary?.settings || []) as { name: string; value: string }[];
      const claude = settings.some((s) => s.name === "claude.summaries" && s.value === "1");
      const r = await send(keys, sub, { title: "Last week is over", tag: "weekly", url: "./?open=weekly",
        body: claude ? "Open the diary to read Claude's summary of your week." : "Open the diary to look back on your week." });
      if (r === "gone") gone = true; else if (r === "ok") { patch.last_weekly_sent = now.date; sent++; }
    }
    if (gone) await rest("push_subscriptions?endpoint=eq." + encodeURIComponent(sub.endpoint), { method: "DELETE" });
    else if (Object.keys(patch).length) await rest("push_subscriptions?endpoint=eq." + encodeURIComponent(sub.endpoint), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  }
  return { sent };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "Use POST.");
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return fail(400, "The request was not readable."); }

  if (body.action === "tick") {
    const want = await secret("tick_secret");
    if (!want || req.headers.get("x-tick-secret") !== want) return fail(401, "Not allowed.");
    return reply(200, await tick());
  }

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return fail(401, "Sign in first.");
  const asUser = { apikey: PUBLISHABLE, Authorization: "Bearer " + token };
  const who = await fetch(URL_BASE + "/auth/v1/user", { headers: asUser });
  if (!who.ok) return fail(401, "Your sign-in has run out. Sign in again.");
  const uid: string = (await who.json()).id;
  const access = await fetch(URL_BASE + "/rest/v1/rpc/my_access", { method: "POST", headers: { ...asUser, "Content-Type": "application/json" }, body: "{}" });
  const status = access.ok ? String((await access.json())?.status || "") : "";
  if (status !== "approved") return fail(403, "Notifications start once your account is approved.");

  if (body.action === "publicKey") return reply(200, { publicKey: (await vapid()).publicKey });

  if (body.action === "subscribe") {
    const s = body.subscription as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
    if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) return fail(400, "The phone did not give a usable subscription.");
    const row = { endpoint: s.endpoint, user_id: uid, p256dh: s.keys.p256dh, auth: s.keys.auth, time_zone: validZone(body.timeZone),
      daily_time: validTime(body.dailyTime), weekly: body.weekly !== false, updated_at: new Date().toISOString() };
    const ok = await rest("push_subscriptions?on_conflict=endpoint", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
    return ok ? reply(200, { ok: true }) : fail(500, "Could not save. Try again.");
  }
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const mine = "push_subscriptions?endpoint=eq." + encodeURIComponent(endpoint) + "&user_id=eq." + uid;
  if (body.action === "update") {
    const patch = { time_zone: validZone(body.timeZone), daily_time: validTime(body.dailyTime), weekly: body.weekly !== false, updated_at: new Date().toISOString() };
    const rows = await rest(mine, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
    return rows && rows.length ? reply(200, { ok: true }) : fail(404, "This phone is not signed up for notifications. Switch them off and on again.");
  }
  if (body.action === "unsubscribe") { await rest(mine, { method: "DELETE" }); return reply(200, { ok: true }); }
  if (body.action === "test") {
    const rows: Sub[] = (await rest(mine.replace("push_subscriptions?", "push_subscriptions?select=*&"))) || [];
    if (!rows.length) return fail(404, "This phone is not signed up for notifications. Switch them off and on again.");
    const r = await send(await vapid(), rows[0], { title: "Life Diary", body: "Notifications are working.", tag: "test", url: "./" });
    if (r === "gone") { await rest(mine, { method: "DELETE" }); return fail(410, "The phone no longer accepts notifications from the diary. Switch them off and on again."); }
    return r === "ok" ? reply(200, { ok: true }) : fail(502, "The notification could not be sent. Try again later.");
  }
  return fail(400, "Unknown action.");
});
