import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
const GOOGLE_CALENDAR = "https://www.googleapis.com/calendar/v3";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

const appOrigin = (Deno.env.get("AS_HUB_ORIGIN") || "https://as-hub-orpin.vercel.app").replace(/\/$/, "");
const callbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-calendar`;

function adminClient() {
  const current = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
  const key = current.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("SUPABASE_SECRET_KEYS no está configurado");
  return createClient(Deno.env.get("SUPABASE_URL") || "", key, { auth: { persistSession: false } });
}

function cors(req: Request) {
  const origin = req.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": origin === appOrigin ? origin : appOrigin,
    "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-as-session, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json; charset=utf-8" },
  });
}

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
};
const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const base64Url = (bytes: Uint8Array) => bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encryptionKey() {
  const source = Deno.env.get("GOOGLE_TOKEN_ENCRYPTION_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!source) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY no está configurado");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return { token_ciphertext: bytesToBase64(new Uint8Array(ciphertext)), token_iv: bytesToBase64(iv) };
}

async function unseal(ciphertext: string, iv: string) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    await encryptionKey(),
    base64ToBytes(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

async function sessionProfile(req: Request, db: ReturnType<typeof adminClient>) {
  const token = req.headers.get("x-as-session") || "";
  if (token.length < 8 || token.length > 200) return null;
  const { data, error } = await db.from("sessions").select("profile_id")
    .eq("token", token).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (error) throw error;
  return data?.profile_id || null;
}

function googleConfig() {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET");
  return { clientId, clientSecret };
}

async function exchangeCode(code: string, verifier: string) {
  const { clientId, clientSecret } = googleConfig();
  const response = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: callbackUrl, grant_type: "authorization_code", code_verifier: verifier,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description || payload.error || "Google rechazó el código OAuth");
  return payload;
}

async function refreshTokens(tokens: Record<string, unknown>) {
  const expiresAt = Number(tokens.expires_at || 0);
  if (tokens.access_token && expiresAt > Date.now() + 60_000) return tokens;
  if (!tokens.refresh_token) throw new Error("Google no entregó refresh_token; vuelve a conectar la cuenta");
  const { clientId, clientSecret } = googleConfig();
  const response = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: String(tokens.refresh_token), grant_type: "refresh_token",
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description || payload.error || "No se pudo renovar Google");
  return { ...tokens, ...payload, expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000 };
}

async function googleFetch(path: string, accessToken: string, init: RequestInit = {}) {
  const response = await fetch(`${GOOGLE_CALENDAR}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Google Calendar respondió ${response.status}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return payload;
}

function eventTimes(item: Record<string, any>) {
  if (item.start?.dateTime) {
    const start = new Date(item.start.dateTime);
    const end = new Date(item.end?.dateTime || start.getTime() + 3_600_000);
    return {
      date: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(start),
      start: start.toLocaleTimeString("en-GB", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false }),
      end: end.toLocaleTimeString("en-GB", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false }),
    };
  }
  return { date: item.start?.date, start: "09:00", end: "10:00" };
}

function googleEvent(title: string, date: string, time: string, duration: number, kind: string, id: string) {
  const start = new Date(`${date}T${time}:00-05:00`);
  const end = new Date(start.getTime() + duration * 60_000);
  return {
    summary: title,
    start: { dateTime: start.toISOString(), timeZone: "America/Bogota" },
    end: { dateTime: end.toISOString(), timeZone: "America/Bogota" },
    extendedProperties: { private: { ashub_kind: kind, ashub_id: id } },
  };
}

async function syncCalendar(req: Request, db: ReturnType<typeof adminClient>, profileId: string) {
  const { data: connection, error } = await db.from("google_calendar_connections").select("*").eq("profile_id", profileId).single();
  if (error || !connection) return json(req, { error: "Google Calendar no está conectado" }, 409);
  let tokens = await refreshTokens(await unseal(connection.token_ciphertext, connection.token_iv));
  const accessToken = String(tokens.access_token);
  const encrypted = await seal(tokens);
  await db.from("google_calendar_connections").update({ ...encrypted, token_expires_at: new Date(Number(tokens.expires_at)).toISOString(), updated_at: new Date().toISOString() }).eq("profile_id", profileId);

  let pulled = 0;
  let conflicts = 0;
  let nextSyncToken: string | null = null;
  const pull = async (useToken: boolean) => {
    let pageToken = "";
    do {
      const params = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "2500" });
      if (useToken && connection.sync_token) params.set("syncToken", connection.sync_token);
      else params.set("timeMin", new Date(Date.now() - 90 * 864e5).toISOString());
      if (pageToken) params.set("pageToken", pageToken);
      const page = await googleFetch(`/calendars/${encodeURIComponent(connection.calendar_id)}/events?${params}`, accessToken);
      for (const item of page.items || []) {
        const kind = item.extendedProperties?.private?.ashub_kind;
        const localId = item.extendedProperties?.private?.ashub_id;
        const times = eventTimes(item);
        if (kind === "task" && localId) {
          const { data: task } = await db.from("tasks").select("*").eq("id", localId).eq("profile_id", profileId).maybeSingle();
          if (!task) continue;
          const googleUpdated = new Date(item.updated || 0).getTime();
          const knownExternal = new Date(task.external_updated_at || 0).getTime();
          if (task.sync_status === "pending" && googleUpdated > knownExternal) {
            await db.from("tasks").update({ sync_status: "conflict" }).eq("id", task.id); conflicts += 1; continue;
          }
          if (task.sync_status === "pending") continue;
          await db.from("tasks").update(item.status === "cancelled"
            ? { scheduled_date: null, scheduled_time: null, sync_status: "synced", external_updated_at: item.updated }
            : { title: item.summary || task.title, scheduled_date: times.date, scheduled_time: times.start,
                duration_min: Math.max(30, Math.round((new Date(item.end.dateTime).getTime() - new Date(item.start.dateTime).getTime()) / 60000 / 30) * 30),
                external_event_id: item.id, external_calendar_id: connection.calendar_id,
                external_updated_at: item.updated, sync_status: "synced" }).eq("id", task.id);
          pulled += 1; continue;
        }
        if (kind === "agenda" && localId) {
          const { data: local } = await db.from("agenda_events").select("*").eq("id", localId).eq("profile_id", profileId).maybeSingle();
          if (!local) continue;
          const googleUpdated = new Date(item.updated || 0).getTime();
          const knownExternal = new Date(local.external_updated_at || 0).getTime();
          if (local.sync_status === "pending" && googleUpdated > knownExternal) {
            await db.from("agenda_events").update({ sync_status: "conflict" }).eq("id", local.id); conflicts += 1; continue;
          }
          if (local.sync_status === "pending") continue;
          await db.from("agenda_events").update(item.status === "cancelled"
            ? { archived_at: new Date().toISOString(), sync_status: "synced", external_updated_at: item.updated }
            : { title: item.summary || local.title, event_date: times.date, start_time: times.start, end_time: times.end,
                external_event_id: item.id, external_calendar_id: connection.calendar_id,
                external_updated_at: item.updated, sync_status: "synced", updated_at: new Date().toISOString() }).eq("id", local.id);
          pulled += 1; continue;
        }
        if (!localId && item.status !== "cancelled" && times.date) {
          const { data: existing } = await db.from("agenda_events").select("id").eq("profile_id", profileId).eq("external_event_id", item.id).maybeSingle();
          const payload = { title: item.summary || "Evento de Google", event_date: times.date, start_time: times.start, end_time: times.end,
            recurrence: "none", color: "#4285f4", profile_id: profileId, external_event_id: item.id,
            external_calendar_id: connection.calendar_id, external_updated_at: item.updated, sync_status: "synced", updated_at: new Date().toISOString() };
          if (existing) await db.from("agenda_events").update(payload).eq("id", existing.id);
          else await db.from("agenda_events").insert(payload);
          pulled += 1;
        }
      }
      pageToken = page.nextPageToken || "";
      nextSyncToken = page.nextSyncToken || nextSyncToken;
    } while (pageToken);
  };

  try { await pull(Boolean(connection.sync_token)); }
  catch (syncError) {
    if ((syncError as Error & { status?: number }).status !== 410) throw syncError;
    await db.from("google_calendar_connections").update({ sync_token: null }).eq("profile_id", profileId);
    connection.sync_token = null;
    await pull(false);
  }

  let pushed = 0;
  const { data: removedTasks } = await db.from("tasks").select("id,external_event_id")
    .eq("profile_id", profileId).eq("sync_status", "pending").not("external_event_id", "is", null)
    .or("status.eq.done,archived_at.not.is.null,scheduled_date.is.null");
  for (const task of removedTasks || []) {
    await googleFetch(`/calendars/${encodeURIComponent(connection.calendar_id)}/events/${encodeURIComponent(task.external_event_id)}`, accessToken, { method: "DELETE" }).catch((deleteError) => {
      if ((deleteError as Error & { status?: number }).status !== 404) throw deleteError;
    });
    await db.from("tasks").update({ sync_status: "synced", external_updated_at: new Date().toISOString() }).eq("id", task.id);
    pushed += 1;
  }
  const { data: removedEvents } = await db.from("agenda_events").select("id,external_event_id")
    .eq("profile_id", profileId).eq("sync_status", "pending").not("external_event_id", "is", null).not("archived_at", "is", null);
  for (const event of removedEvents || []) {
    await googleFetch(`/calendars/${encodeURIComponent(connection.calendar_id)}/events/${encodeURIComponent(event.external_event_id)}`, accessToken, { method: "DELETE" }).catch((deleteError) => {
      if ((deleteError as Error & { status?: number }).status !== 404) throw deleteError;
    });
    await db.from("agenda_events").update({ sync_status: "synced", external_updated_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", event.id);
    pushed += 1;
  }
  const { data: tasks } = await db.from("tasks").select("*").eq("profile_id", profileId).is("archived_at", null).neq("status", "done").not("scheduled_date", "is", null).not("scheduled_time", "is", null).in("sync_status", ["local", "pending"]);
  for (const task of tasks || []) {
    const body = googleEvent(task.title, task.scheduled_date, task.scheduled_time.slice(0, 5), Number(task.duration_min || 30), "task", task.id);
    const result = task.external_event_id
      ? await googleFetch(`/calendars/${encodeURIComponent(connection.calendar_id)}/events/${encodeURIComponent(task.external_event_id)}`, accessToken, { method: "PATCH", body: JSON.stringify(body) })
      : await googleFetch(`/calendars/${encodeURIComponent(connection.calendar_id)}/events`, accessToken, { method: "POST", body: JSON.stringify(body) });
    await db.from("tasks").update({ external_event_id: result.id, external_calendar_id: connection.calendar_id, external_updated_at: result.updated, sync_status: "synced" }).eq("id", task.id);
    pushed += 1;
  }
  const { data: events } = await db.from("agenda_events").select("*").eq("profile_id", profileId).is("archived_at", null).in("sync_status", ["local", "pending"]);
  for (const event of events || []) {
    const duration = Math.max(30, (Number(event.end_time.slice(0, 2)) * 60 + Number(event.end_time.slice(3, 5))) - (Number(event.start_time.slice(0, 2)) * 60 + Number(event.start_time.slice(3, 5))));
    const body = googleEvent(event.title, event.event_date, event.start_time.slice(0, 5), duration, "agenda", event.id);
    const result = event.external_event_id
      ? await googleFetch(`/calendars/${encodeURIComponent(connection.calendar_id)}/events/${encodeURIComponent(event.external_event_id)}`, accessToken, { method: "PATCH", body: JSON.stringify(body) })
      : await googleFetch(`/calendars/${encodeURIComponent(connection.calendar_id)}/events`, accessToken, { method: "POST", body: JSON.stringify(body) });
    await db.from("agenda_events").update({ external_event_id: result.id, external_calendar_id: connection.calendar_id, external_updated_at: result.updated, sync_status: "synced", updated_at: new Date().toISOString() }).eq("id", event.id);
    pushed += 1;
  }
  await db.from("google_calendar_connections").update({ sync_token: nextSyncToken, last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("profile_id", profileId);
  return json(req, { ok: true, pulled, pushed, conflicts, synced_at: new Date().toISOString() });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const db = adminClient();
  try {
    const url = new URL(req.url);
    if (req.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"))) {
      const state = url.searchParams.get("state") || "";
      const stateHash = await sha256(state);
      const { data: pending } = await db.from("google_calendar_oauth_states").select("*").eq("state_hash", stateHash)
        .gt("expires_at", new Date().toISOString()).maybeSingle();
      if (!pending) return new Response("OAuth state inválido o vencido", { status: 400, headers: { "Content-Type": "text/plain" } });
      await db.from("google_calendar_oauth_states").delete().eq("state_hash", stateHash);
      if (url.searchParams.has("error")) return Response.redirect(`${pending.return_to}?google=denied`, 302);
      const received = await exchangeCode(url.searchParams.get("code") || "", pending.code_verifier);
      const { data: current } = await db.from("google_calendar_connections").select("token_ciphertext,token_iv").eq("profile_id", pending.profile_id).maybeSingle();
      let oldTokens: Record<string, unknown> = {};
      if (current) oldTokens = await unseal(current.token_ciphertext, current.token_iv);
      const tokens = { ...oldTokens, ...received, refresh_token: received.refresh_token || oldTokens.refresh_token,
        expires_at: Date.now() + Number(received.expires_in || 3600) * 1000 };
      const encrypted = await seal(tokens);
      await db.from("google_calendar_connections").upsert({ profile_id: pending.profile_id, ...encrypted,
        token_expires_at: new Date(Number(tokens.expires_at)).toISOString(), scope: received.scope || CALENDAR_SCOPE,
        connected_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return Response.redirect(`${pending.return_to}?google=connected`, 302);
    }

    if (req.method !== "POST") return json(req, { error: "Método no permitido" }, 405);
    const profileId = await sessionProfile(req, db);
    if (!profileId) return json(req, { error: "Sesión inválida o vencida" }, 401);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "status");

    if (action === "start") {
      const { clientId } = googleConfig();
      await db.from("google_calendar_oauth_states").delete().lt("expires_at", new Date().toISOString());
      const stateBytes = crypto.getRandomValues(new Uint8Array(32));
      const verifierBytes = crypto.getRandomValues(new Uint8Array(64));
      const state = base64Url(stateBytes);
      const verifier = base64Url(verifierBytes);
      const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      const returnTo = `${appOrigin}/#/tareas/agenda`;
      const { error } = await db.from("google_calendar_oauth_states").insert({
        state_hash: await sha256(state), profile_id: profileId, code_verifier: verifier,
        return_to: returnTo, expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      if (error) throw error;
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl, response_type: "code",
        scope: CALENDAR_SCOPE, access_type: "offline", include_granted_scopes: "true", prompt: "consent",
        state, code_challenge: challenge, code_challenge_method: "S256" });
      return json(req, { authorization_url: `${GOOGLE_AUTH}?${params}`, redirect_uri: callbackUrl });
    }
    if (action === "status") {
      const { data } = await db.from("google_calendar_connections").select("scope,calendar_id,connected_at,last_sync_at,updated_at").eq("profile_id", profileId).maybeSingle();
      return json(req, { connected: Boolean(data), connection: data || null, configured: Boolean(Deno.env.get("GOOGLE_CLIENT_ID") && Deno.env.get("GOOGLE_CLIENT_SECRET")) });
    }
    if (action === "disconnect") {
      const { data } = await db.from("google_calendar_connections").select("token_ciphertext,token_iv").eq("profile_id", profileId).maybeSingle();
      if (data) {
        const tokens = await unseal(data.token_ciphertext, data.token_iv);
        const token = tokens.refresh_token || tokens.access_token;
        if (token) await fetch(GOOGLE_REVOKE, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: String(token) }) }).catch(() => null);
      }
      await db.from("google_calendar_connections").delete().eq("profile_id", profileId);
      return json(req, { ok: true });
    }
    if (action === "sync") return syncCalendar(req, db, profileId);
    return json(req, { error: "Acción inválida" }, 400);
  } catch (error) {
    console.error("google-calendar", error instanceof Error ? error.message : error);
    const message = error instanceof Error ? error.message : "Error interno";
    const status = message.startsWith("Faltan GOOGLE_") ? 503 : 500;
    return json(req, { error: message }, status);
  }
});
