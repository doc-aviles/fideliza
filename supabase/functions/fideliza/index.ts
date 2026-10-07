// Fideliza · función de servidor (Supabase Edge Function)
// Rutas:  /inbound  (Twilio: mensaje entrante)   /status (Twilio: estado de entrega)
//         /tick     (reloj automático cada minuto, o la app al pulsar "Enviar ahora")
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  classify, digits10, filterSlots, firstName, fmtDate, fmtTime, freeSlots, inSendWindow,
  mxVariants, pickSlots, reminderDue, render, slotsText, twilioSignature, waAddress,
} from "./logic.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TW_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TW_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const TW_FROM = Deno.env.get("TWILIO_WHATSAPP_FROM") ?? "whatsapp:+14155238886";
const BASE = `${SUPABASE_URL}/functions/v1/fideliza`;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const TW_ERRORS: Record<string, string> = {
  "63015": "Este número no se ha unido al sandbox de Twilio. Debe enviar el código «join …» por WhatsApp.",
  "63016": "Han pasado más de 24 h desde el último mensaje del paciente. En el sandbox solo se puede escribir dentro de esas 24 h.",
  "63007": "El número de envío de Twilio no está habilitado para WhatsApp.",
  "63003": "El número de destino no tiene WhatsApp o está mal escrito.",
  "21211": "El número de destino no es válido.",
  "20003": "Twilio rechazó las credenciales (Account SID o Auth Token incorrectos).",
};
const explain = (code: unknown, fallback: string) => TW_ERRORS[String(code)] ?? `${fallback || "Error de Twilio"}${code ? ` (código ${code})` : ""}`;

const SANDBOX = "whatsapp:+14155238886";
let lastRoute = "";

async function twilioOnce(from: string, to: string, body: string) {
  const form = new URLSearchParams({ From: from, To: to, Body: body, StatusCallback: `${BASE}/status` });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${TW_SID}:${TW_TOKEN}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  return r.ok ? { sid: j.sid as string } : { error: explain(j.code, j.message) };
}

// Prueba las combinaciones de remitente y formato de número hasta que Twilio acepte una.
async function twilioSend(to: string, body: string): Promise<{ sid?: string; error?: string }> {
  if (!TW_SID || !TW_TOKEN) return { error: "Falta conectar Twilio: agrega TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN en los secretos de la función." };
  const froms = [...new Set([TW_FROM, SANDBOX])];
  const tried: string[] = [];
  let first = "";
  try {
    for (const from of froms) {
      for (const dest of mxVariants(to)) {
        const r = await twilioOnce(from, dest, body);
        if (r.sid) { lastRoute = `${from} > ${dest}`; return r; }
        tried.push(`${from.replace("whatsapp:", "")} a ${dest.replace("whatsapp:", "")}`);
        if (!first) first = r.error!;
      }
    }
    return { error: `${first} Se intentó: ${tried.join("; ")}.` };
  } catch (e) {
    return { error: "No se pudo contactar a Twilio: " + (e as Error).message };
  }
}

async function getSettings() {
  const { data, error } = await db.from("settings").select("*").eq("id", 1).single();
  if (error) throw new Error("No se pudo leer la configuración: " + error.message);
  return data;
}

function vars(patient: any, s: any, extra: Record<string, string> = {}) {
  return {
    nombre: firstName(patient?.name ?? ""),
    consultorio: s.clinic_name,
    doctor: s.doctor_name || s.clinic_name,
    telefono: patient?.phone ?? "",
    ...extra,
  };
}

// Envía un mensaje al paciente y lo deja registrado.
async function say(patient: any, s: any, body: string, kind: string, extra: Record<string, unknown> = {}) {
  const res = await twilioSend(waAddress(patient, s), body);
  await db.from("messages").insert({
    patient_id: patient.id, direction: "out", body, kind,
    status: res.sid ? "enviado" : "fallido", sent_at: new Date().toISOString(),
    twilio_sid: res.sid ?? null, error: res.error ?? null, from_number: res.sid ? lastRoute : null, ...extra,
  });
  return res;
}

async function setPatient(id: string, patch: Record<string, unknown>) {
  await db.from("patients").update(patch).eq("id", id);
}

// ───────────── Ofrecer horarios ─────────────
async function offerSlots(patient: any, s: any, ctx: any, pref: any, now: Date, prefix = "") {
  let duration = s.default_duration_min;
  if (ctx.procedure_id) {
    const { data: p } = await db.from("procedures").select("duration_min").eq("id", ctx.procedure_id).maybeSingle();
    if (p?.duration_min) duration = p.duration_min;
  }
  const { data: appts } = await db.from("appointments").select("starts_at,duration_min,status")
    .gte("starts_at", new Date(now.getTime() - 6 * 3600e3).toISOString()).neq("status", "cancelada");
  const all = freeSlots(now, s, appts ?? [], duration);
  let pool = filterSlots(all, pref, s.timezone);
  if (!pool.length) pool = all;
  const picks = pickSlots(pool, s.slots_to_offer, s.timezone);
  if (!picks.length) {
    await setPatient(patient.id, { needs_attention: true, conv_state: "idle" });
    await say(patient, s, prefix + render(s.tpl_no_slots, vars(patient, s)), "respuesta");
    return;
  }
  await setPatient(patient.id, {
    conv_state: "ofreciendo",
    conv_context: { ...ctx, slots: picks.map((d) => d.toISOString()), duration },
  });
  await say(patient, s, prefix + render(s.tpl_offer, vars(patient, s, { horarios: slotsText(picks, s.timezone) })), "respuesta");
}

// ───────────── Mensaje entrante de WhatsApp ─────────────
async function handleInbound(p: Record<string, string>) {
  const from = p.From ?? "";
  const body = (p.Body ?? "").trim();
  if (!from || !body) return;
  const s = await getSettings();
  const now = new Date();
  const d10 = digits10(from);

  const { data: found } = await db.from("patients").select("*").like("phone", `%${d10}`).order("is_sample").limit(1);
  const patient = found?.[0];
  const inRow = {
    patient_id: patient?.id ?? null, direction: "in", body, kind: "respuesta", status: "recibido",
    sent_at: now.toISOString(), twilio_sid: p.MessageSid ?? null, from_number: from,
    dedupe_key: p.MessageSid ? `in:${p.MessageSid}` : null,
  };
  const { error: dup } = await db.from("messages").insert(inRow);
  if (dup) return; // Twilio reintentó el mismo mensaje: ya está procesado.
  if (!patient) return; // Número desconocido: queda en la bandeja para revisarlo.

  const ctx = patient.conv_context ?? {};
  const state = patient.conv_state ?? "idle";
  const offered: Date[] = (ctx.slots ?? []).map((x: string) => new Date(x));
  const { intent, choice, pref } = classify(body, s, state, offered, now);
  const canReply = s.bot_enabled && !patient.bot_paused && !patient.opted_out;
  const pause = () => sleep(Math.min(Math.max(s.reply_delay_seconds ?? 0, 0), 20) * 1000);

  // La alarma se atiende siempre, aunque el asistente esté apagado.
  if (intent === "alarm") {
    await db.from("alerts").insert({ patient_id: patient.id, body });
    await setPatient(patient.id, { bot_paused: true, needs_attention: true, conv_state: "idle" });
    if (s.alert_whatsapp) {
      const text = render(s.tpl_alarm_doctor, vars(patient, s, { mensaje: body }));
      const res = await twilioSend(waAddress({ phone: s.alert_whatsapp }, s), text);
      await db.from("messages").insert({
        patient_id: patient.id, direction: "out", body: text, kind: "alerta",
        status: res.sid ? "enviado" : "fallido", sent_at: now.toISOString(), twilio_sid: res.sid ?? null, error: res.error ?? null,
      });
    }
    if (canReply) { await pause(); await say(patient, s, render(s.tpl_alarm_patient, vars(patient, s)), "respuesta"); }
    return;
  }

  if (intent === "optout") {
    await setPatient(patient.id, { opted_out: true, conv_state: "idle", conv_context: {} });
    if (s.bot_enabled) { await pause(); await say(patient, s, render(s.tpl_optout, vars(patient, s)), "respuesta"); }
    return;
  }

  if (!canReply) { await setPatient(patient.id, { needs_attention: true }); return; }
  await pause();

  if (intent === "choice") {
    const slot = offered[choice!];
    const duration = ctx.duration ?? s.default_duration_min;
    const end = new Date(slot.getTime() + duration * 60e3);
    const { data: clash } = await db.from("appointments").select("starts_at,duration_min")
      .neq("status", "cancelada").lt("starts_at", end.toISOString())
      .gte("starts_at", new Date(slot.getTime() - 6 * 3600e3).toISOString());
    const taken = (clash ?? []).some((a) => new Date(a.starts_at).getTime() + a.duration_min * 60e3 > slot.getTime());
    if (taken) return offerSlots(patient, s, ctx, null, now, "Ese horario se acaba de ocupar. ");
    await db.from("appointments").insert({
      patient_id: patient.id, procedure_id: ctx.procedure_id ?? null, treatment_id: ctx.treatment_id ?? null,
      starts_at: slot.toISOString(), duration_min: duration, status: "agendada", source: "fideliza",
    });
    await setPatient(patient.id, { conv_state: "idle", conv_context: {}, needs_attention: false });
    await say(patient, s, render(s.tpl_booked, vars(patient, s, { fecha: fmtDate(slot, s.timezone), hora: fmtTime(slot, s.timezone) })), "respuesta");
    return;
  }

  if (state === "confirmando" && ctx.appointment_id && (intent === "yes" || intent === "no")) {
    if (intent === "yes") {
      await db.from("appointments").update({ status: "confirmada" }).eq("id", ctx.appointment_id);
      await setPatient(patient.id, { conv_state: "idle", conv_context: {} });
      await say(patient, s, render(s.tpl_appt_confirmed, vars(patient, s)), "respuesta");
    } else {
      await db.from("appointments").update({ status: "cancelada" }).eq("id", ctx.appointment_id);
      await setPatient(patient.id, { needs_attention: true });
      await offerSlots(patient, s, { procedure_id: ctx.procedure_id, treatment_id: ctx.treatment_id }, null, now,
        render(s.tpl_appt_cancelled, vars(patient, s)) + " ");
    }
    return;
  }

  if (state === "postcuidado") {
    if (intent === "no") {
      await setPatient(patient.id, { needs_attention: true, conv_state: "idle" });
      await say(patient, s, render(s.tpl_fallback, vars(patient, s)), "respuesta");
    } else {
      await setPatient(patient.id, { conv_state: "idle", conv_context: {} });
      await say(patient, s, render(s.tpl_postcare_ok, vars(patient, s)), "respuesta");
    }
    return;
  }

  if (intent === "offer" || intent === "yes") return offerSlots(patient, s, ctx, pref, now);

  if (intent === "no") {
    if (ctx.treatment_id) {
      await db.from("treatments").update({ snoozed_until: new Date(now.getTime() + s.snooze_days * 86400e3).toISOString() }).eq("id", ctx.treatment_id);
    }
    await setPatient(patient.id, { conv_state: "idle", conv_context: {} });
    await say(patient, s, render(s.tpl_declined, vars(patient, s)), "respuesta");
    return;
  }

  // No se entendió: lo ve una persona del consultorio.
  const lastFallback = ctx.fallback_at ? new Date(ctx.fallback_at).getTime() : 0;
  await setPatient(patient.id, { needs_attention: true, conv_context: { ...ctx, fallback_at: now.toISOString() } });
  if (s.fallback_on && now.getTime() - lastFallback > 30 * 60e3) {
    await say(patient, s, render(s.tpl_fallback, vars(patient, s)), "respuesta");
  }
}

// ───────────── Estado de entrega ─────────────
async function handleStatus(p: Record<string, string>) {
  const map: Record<string, string> = { sent: "enviado", delivered: "entregado", read: "leido", failed: "fallido", undelivered: "fallido" };
  const status = map[p.MessageStatus ?? ""];
  if (!status || !p.MessageSid) return;
  const patch: Record<string, unknown> = { status };
  if (status === "fallido") patch.error = explain(p.ErrorCode, p.ErrorMessage ?? "No se entregó");
  let q = db.from("messages").update(patch).eq("twilio_sid", p.MessageSid);
  // Un "enviado" tardío no debe pisar un "leído".
  if (status === "enviado") q = q.in("status", ["enviando", "programado"]);
  if (status === "entregado") q = q.neq("status", "leido");
  await q;
}

// ───────────── Reloj: qué toca enviar ─────────────
async function plan(s: any, now: Date, forceTreatment?: string) {
  const out: { created: number; skipped?: string } = { created: 0 };
  const windowOpen = inSendWindow(now, s);
  const { data: procs } = await db.from("procedures").select("*");
  const procById = new Map((procs ?? []).map((p) => [p.id, p]));
  const { data: trs } = await db.from("treatments").select("*, patients(*)").order("performed_at", { ascending: false }).limit(5000);
  const latest = new Map<string, any>();
  for (const t of trs ?? []) {
    const k = `${t.patient_id}:${t.procedure_id}`;
    if (!latest.has(k)) latest.set(k, t);
  }
  const { data: future } = await db.from("appointments").select("patient_id").in("status", ["agendada", "confirmada"]).gt("starts_at", now.toISOString());
  const hasAppt = new Set((future ?? []).map((a) => a.patient_id));
  const { data: rems } = await db.from("messages").select("treatment_id,sent_at,created_at").eq("kind", "recordatorio").not("treatment_id", "is", null);
  const sentBy = new Map<string, { sent_at: string }[]>();
  for (const m of rems ?? []) {
    const list = sentBy.get(m.treatment_id) ?? [];
    list.push({ sent_at: m.sent_at ?? m.created_at });
    sentBy.set(m.treatment_id, list);
  }

  const queue = async (row: Record<string, unknown>, patientPatch: Record<string, unknown>) => {
    const { error } = await db.from("messages").insert({ direction: "out", status: "programado", scheduled_for: now.toISOString(), ...row });
    if (error) return false; // ya existía (dedupe_key)
    await setPatient(row.patient_id as string, patientPatch);
    out.created++;
    return true;
  };

  for (const t of latest.values()) {
    const proc = procById.get(t.procedure_id);
    const pt = t.patients;
    if (!proc || !pt) continue;
    const forced = forceTreatment === t.id;
    const eligible = pt.consent && !pt.opted_out && digits10(pt.phone).length === 10;
    if (forced && !eligible) { out.skipped = "El paciente no ha autorizado mensajes por WhatsApp, se dio de baja o no tiene un teléfono de 10 dígitos."; continue; }
    if (!eligible) continue;
    const sent = sentBy.get(t.id) ?? [];
    let n = 0;
    if (forced) n = sent.length + 1;
    else if (s.bot_enabled && windowOpen && !pt.bot_paused && !hasAppt.has(pt.id) && !(t.snoozed_until && new Date(t.snoozed_until) > now)) {
      n = reminderDue(new Date(t.performed_at), proc, sent, now);
    }
    if (n > 0) {
      await queue({
        patient_id: pt.id, treatment_id: t.id, kind: "recordatorio",
        body: render(proc.reminder_template, vars(pt, s, { procedimiento: proc.name })),
        dedupe_key: `rem:${t.id}:${n}`,
      }, { conv_state: "recordado", conv_context: { treatment_id: t.id, procedure_id: proc.id } });
    }
  }

  if (!s.bot_enabled || !windowOpen) return out;

  // Seguimiento después del procedimiento
  for (const t of trs ?? []) {
    const proc = procById.get(t.procedure_id);
    const pt = t.patients;
    if (!proc?.active || !proc.postcare_on || !pt?.consent || pt.opted_out || pt.bot_paused) continue;
    const done = new Date(t.performed_at).getTime();
    if (now.getTime() - done > 20 * 86400e3) continue;
    for (let i = 0; i < (proc.postcare_hours ?? []).length; i++) {
      const due = done + proc.postcare_hours[i] * 3600e3;
      if (now.getTime() < due || now.getTime() > due + 24 * 3600e3) continue;
      await queue({
        patient_id: pt.id, treatment_id: t.id, kind: "postcuidado",
        body: render(proc.postcare_template, vars(pt, s, { procedimiento: proc.name })),
        dedupe_key: `post:${t.id}:${i}`,
      }, { conv_state: "postcuidado", conv_context: { treatment_id: t.id, procedure_id: proc.id } });
    }
  }

  // Recordatorio de cita
  if (s.appt_reminder_on) {
    const lead = s.appt_reminder_hours * 3600e3;
    const { data: appts } = await db.from("appointments").select("*, patients(*)").eq("status", "agendada")
      .gt("starts_at", now.toISOString()).lte("starts_at", new Date(now.getTime() + lead).toISOString());
    for (const a of appts ?? []) {
      const pt = a.patients;
      if (!pt?.consent || pt.opted_out || pt.bot_paused) continue;
      const start = new Date(a.starts_at);
      if (new Date(a.created_at).getTime() > start.getTime() - lead) continue; // se agendó hace muy poco
      await queue({
        patient_id: pt.id, appointment_id: a.id, kind: "cita",
        body: render(s.tpl_appt_reminder, vars(pt, s, { fecha: fmtDate(start, s.timezone), hora: fmtTime(start, s.timezone) })),
        dedupe_key: `cita:${a.id}`,
      }, { conv_state: "confirmando", conv_context: { appointment_id: a.id, procedure_id: a.procedure_id, treatment_id: a.treatment_id } });
    }
  }
  return out;
}

async function sendDue(s: any, now: Date) {
  const res = { sent: 0, failed: 0, errors: [] as string[] };
  const { data: due } = await db.from("messages").select("*, patients(*)").eq("status", "programado").eq("direction", "out")
    .lte("scheduled_for", now.toISOString()).order("scheduled_for").limit(8);
  for (const m of due ?? []) {
    const { data: claimed } = await db.from("messages").update({ status: "enviando" }).eq("id", m.id).eq("status", "programado").select("id");
    if (!claimed?.length) continue;
    const pt = m.patients;
    let r: { sid?: string; error?: string };
    if (!pt) r = { error: "El mensaje no tiene paciente." };
    else if (pt.opted_out) r = { error: "El paciente se dio de baja de los mensajes." };
    else if (!pt.consent) r = { error: "El paciente no ha autorizado mensajes por WhatsApp." };
    else r = await twilioSend(waAddress(pt, s), m.body);
    await db.from("messages").update({
      status: r.sid ? "enviado" : "fallido", sent_at: new Date().toISOString(), twilio_sid: r.sid ?? null, error: r.error ?? null,
      from_number: r.sid ? lastRoute : null,
    }).eq("id", m.id);
    if (r.sid) res.sent++; else { res.failed++; res.errors.push(r.error!); }
    if (r.sid) await sleep(3100); // el sandbox permite un mensaje cada 3 segundos
  }
  return res;
}

async function authorized(req: Request): Promise<boolean> {
  const cron = req.headers.get("x-cron-secret");
  if (cron) {
    const { data } = await db.from("app_secrets").select("cron_secret").eq("id", 1).single();
    return !!data && data.cron_secret === cron;
  }
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data } = await db.auth.getUser(token);
  const email = data?.user?.email;
  if (!email) return false;
  const { data: st } = await db.from("staff").select("email").ilike("email", email).limit(1);
  return !!st?.length;
}

async function twilioParams(req: Request, route: string): Promise<Record<string, string> | null> {
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);
  if (!TW_TOKEN) return null;
  const expected = await twilioSignature(TW_TOKEN, `${BASE}/${route}`, params);
  return expected === req.headers.get("x-twilio-signature") ? params : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  try {
    if (route === "inbound" || route === "status") {
      const params = await twilioParams(req, route);
      if (!params) return new Response("firma no válida", { status: 403 });
      const work = (route === "inbound" ? handleInbound(params) : handleStatus(params)).catch((e) => console.error(route, e));
      // Se responde a Twilio de inmediato y el trabajo sigue en segundo plano.
      // deno-lint-ignore no-explicit-any
      const rt = (globalThis as any).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(work); else await work;
      return new Response("<Response></Response>", { headers: { "Content-Type": "text/xml" } });
    }
    if (route === "tick") {
      if (!(await authorized(req))) return json({ error: "No autorizado" }, 401);
      const body = await req.json().catch(() => ({}));
      const s = await getSettings();
      const now = new Date();
      const planned = await plan(s, now, body.force_treatment);
      const sent = await sendDue(s, now);
      return json({ ...planned, ...sent, twilio_ok: !!(TW_SID && TW_TOKEN), from: TW_FROM, webhook: `${BASE}/inbound` });
    }
    return json({ error: "Ruta desconocida" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
