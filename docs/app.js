// Fideliza · aplicación del consultorio
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const cfg = window.FIDELIZA || {};
const DEMO = new URLSearchParams(location.search).has("demo") || !cfg.url;
const DAY = 86400e3;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let sb = null, api = null, user = null;
let D = { settings: null, procedures: [], patients: [], treatments: [], appointments: [], messages: [], alerts: [], staff: [] };
const ui = { week: 0, search: "", conn: null, pendingRefresh: false, msgFilter: "todos" };

// ───────────── Fechas en la zona horaria del consultorio ─────────────
const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const tz = () => D.settings?.timezone || "America/Tijuana";
function localParts(d) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz(), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const p = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, dow: DOW[p.weekday] };
}
function zonedToUtc(y, m, d, h, min) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const p = localParts(new Date(guess));
  return new Date(guess - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - guess));
}
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => { const p = localParts(new Date(d)); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const fmt = (d, o) => new Intl.DateTimeFormat("es-MX", { timeZone: tz(), ...o }).format(new Date(d));
const fDate = (d) => fmt(d, { day: "numeric", month: "short", year: "numeric" });
const fDay = (d) => fmt(d, { weekday: "short", day: "numeric", month: "short" });
const fTime = (d) => { const p = localParts(new Date(d)); return `${p.h}:${pad(p.min)}`; };
const fWhen = (d) => (dayKey(d) === dayKey(Date.now()) ? fTime(d) : `${fmt(d, { day: "numeric", month: "short" })}, ${fTime(d)}`);
const fromDateInput = (v, h = 12, mi = 0) => { const [y, m, d] = v.split("-").map(Number); return zonedToUtc(y, m, d, h, mi); };
const money = (n) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(n || 0);
const cleanPhone = (v) => { const t = (v || "").trim(); const dg = t.replace(/\D/g, ""); return t.startsWith("+") ? "+" + dg : dg; };

// ───────────── Datos ─────────────
const TABLES = ["procedures", "patients", "treatments", "appointments", "messages", "alerts", "staff"];
const ORDER = { procedures: ["sort", true], patients: ["name", true], treatments: ["performed_at", false], appointments: ["starts_at", true], messages: ["created_at", false], alerts: ["created_at", false], staff: ["email", true] };

function realApi() {
  return {
    async list(table) {
      let q = sb.from(table).select("*");
      if (ORDER[table]) q = q.order(ORDER[table][0], { ascending: ORDER[table][1] });
      if (table === "messages") q = q.limit(800);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
    async insert(table, row) { const { data, error } = await sb.from(table).insert(row).select(); if (error) throw error; return data[0]; },
    async update(table, id, patch, key = "id") { const { error } = await sb.from(table).update(patch).eq(key, id); if (error) throw error; },
    async remove(table, id, key = "id") { const { error } = await sb.from(table).delete().eq(key, id); if (error) throw error; },
    async fn(body = {}) {
      const { data, error } = await sb.functions.invoke("fideliza/tick", { body });
      if (error) {
        let msg = error.message;
        try { msg = (await error.context.json()).error || msg; } catch (_) { /* sin detalle */ }
        throw new Error(msg);
      }
      return data;
    },
  };
}

function sampleRows(procs) {
  const p = (name) => procs.find((x) => x.name.toLowerCase().includes(name))?.id;
  const ago = (n) => new Date(Date.now() - n * DAY).toISOString();
  const lp = localParts(new Date());
  const at = (off, h, mi) => zonedToUtc(lp.y, lp.m, lp.d + off, h, mi).toISOString();
  const people = [
    ["Ana Martínez", [["toxina", 111, "Tercio superior"], ["hialur", 207, "Pómulos"]]],
    ["Carolina Ruiz", [["hialur", 329, "Labios"]]],
    ["Fernanda Torres", [["toxina", 158, "Tercio superior"]]],
    ["María López", [["hilos", 382, ""]]],
    ["Valeria Gómez", [["glp", 7, "Semana 6"]]],
    ["Lucía Herrera", [["toxina", 30, "Entrecejo"]]],
    ["Paola Sánchez", [["hialur", 120, "Surco nasogeniano"]]],
    ["Daniela Cruz", []],
  ];
  const appts = [["Lucía Herrera", 0, 10, 0, "toxina"], ["Paola Sánchez", 0, 11, 30, "hialur"], ["Valeria Gómez", 0, 13, 0, "glp"], ["Daniela Cruz", 0, 16, 30, "hilos"], ["Carolina Ruiz", 1, 16, 30, "hialur"]];
  return { people, appts, p, ago, at };
}

function mockApi() {
  let n = 1;
  const id = () => "m" + n++;
  const store = { settings: [MOCK_SETTINGS], procedures: [], patients: [], treatments: [], appointments: [], messages: [], alerts: [], staff: [{ email: "demo@fideliza.app", name: "Demostración" }] };
  [["Toxina botulínica", 90, 120, 90, 3, 2, 30, 4400, [24]], ["Ácido hialurónico", 270, 365, 270, 7, 2, 45, 7500, [24, 168]], ["Hilos tensores", 365, 540, 365, 14, 2, 90, 15000, [24, 168]], ["Control GLP-1", 7, 9, 6, 2, 1, 20, 1800, []]]
    .forEach(([name, a, b, c, d, e, f, g, h], i) => store.procedures.push({ id: id(), name, active: true, reminders_on: true, window_min_days: a, window_max_days: b, first_reminder_days: c, repeat_days: d, max_reminders: e, duration_min: f, price: g, postcare_on: h.length > 0, postcare_hours: h, sort: i, reminder_template: "Hola {nombre}, te escribe {consultorio}. Ya es buen momento para tu revaloración. ¿Te aparto un espacio esta semana?", postcare_template: "Hola {nombre}, ¿cómo te has sentido después de tu visita?" }));
  D.settings = MOCK_SETTINGS;
  const s = sampleRows(store.procedures);
  for (const [name, trs] of s.people) {
    const pt = { id: id(), name, phone: "664555" + pad(n) + pad(n), consent: name !== "Fernanda Torres", opted_out: false, bot_paused: false, needs_attention: false, conv_state: "idle", conv_context: {}, notes: "", is_sample: true, created_at: s.ago(400) };
    store.patients.push(pt);
    for (const [proc, days, zone] of trs) store.treatments.push({ id: id(), patient_id: pt.id, procedure_id: s.p(proc), performed_at: s.ago(days), zone, price: 0, source: "consultorio" });
  }
  const byName = (x) => store.patients.find((q) => q.name === x);
  for (const [name, off, h, mi, proc] of s.appts) store.appointments.push({ id: id(), patient_id: byName(name).id, procedure_id: s.p(proc), starts_at: s.at(off, h, mi), duration_min: 30, status: "agendada", source: name === "Carolina Ruiz" ? "fideliza" : "manual", notes: "", created_at: s.ago(1) });
  const ana = byName("Ana Martínez"), caro = byName("Carolina Ruiz");
  const tr = (pt) => store.treatments.find((t) => t.patient_id === pt.id);
  const msg = (pt, direction, body, kind, status, hrs, extra = {}) => store.messages.push({ id: id(), patient_id: pt.id, direction, body, kind, status, created_at: new Date(Date.now() - hrs * 3600e3).toISOString(), sent_at: new Date(Date.now() - hrs * 3600e3).toISOString(), ...extra });
  msg(ana, "out", "Hola Ana, te escribe Consultorio de ejemplo. Ya es buen momento para tu revaloración. ¿Te aparto un espacio esta semana?", "recordatorio", "leido", 20, { treatment_id: tr(ana).id });
  msg(caro, "out", "Hola Carolina, te escribe Consultorio de ejemplo. Ya es buen momento para tu revaloración. ¿Te aparto un espacio esta semana?", "recordatorio", "leido", 26, { treatment_id: tr(caro).id });
  msg(caro, "in", "Hola! Sí, ya me tocaba. ¿Tienen algo mañana en la tarde?", "respuesta", "recibido", 25.6);
  msg(caro, "out", "Con gusto, Carolina. Tengo estos horarios:\n1. 16:30\n2. 17:30\nResponde con el número del que prefieras.", "respuesta", "leido", 25.5);
  msg(caro, "in", "1", "respuesta", "recibido", 25.4);
  msg(caro, "out", "Listo, Carolina. Tu cita quedó agendada. Te esperamos.", "respuesta", "entregado", 25.3);
  return {
    async list(t) { return structuredClone(store[t]); },
    async insert(t, row) { const rows = (Array.isArray(row) ? row : [row]).map((r) => ({ id: id(), created_at: new Date().toISOString(), ...r })); store[t].push(...rows); return rows[0]; },
    async update(t, i, patch, key = "id") { store[t].filter((r) => r[key] === i).forEach((r) => Object.assign(r, patch)); },
    async remove(t, i, key = "id") { store[t] = store[t].filter((r) => r[key] !== i); },
    async fn(body = {}) {
      store.messages.filter((m) => m.status === "programado").forEach((m) => { m.status = "enviado"; m.sent_at = new Date().toISOString(); });
      if (body.force_treatment) {
        const t = store.treatments.find((x) => x.id === body.force_treatment), pt = store.patients.find((x) => x.id === t.patient_id);
        if (!pt.consent) return { created: 0, sent: 0, failed: 0, skipped: "El paciente no ha autorizado mensajes por WhatsApp.", twilio_ok: false };
        store.messages.push({ id: id(), patient_id: pt.id, direction: "out", kind: "recordatorio", status: "enviado", treatment_id: t.id, body: `Hola ${pt.name.split(" ")[0]}, te escribe ${MOCK_SETTINGS.clinic_name}. Ya es buen momento para tu revaloración. ¿Te aparto un espacio esta semana?`, created_at: new Date().toISOString(), sent_at: new Date().toISOString() });
        return { created: 1, sent: 1, failed: 0, twilio_ok: false };
      }
      return { created: 0, sent: 0, failed: 0, twilio_ok: false, from: "whatsapp:+14155238886", webhook: "(modo demostración)" };
    },
  };
}
const MOCK_SETTINGS = { id: 1, clinic_name: "Consultorio de ejemplo", doctor_name: "Dra. Ejemplo", timezone: "America/Tijuana", bot_enabled: true, alert_whatsapp: "", mx_prefix: "+521", sandbox_join_code: "", send_start: "10:00", send_end: "19:00", send_days: [1, 2, 3, 4, 5, 6], reply_delay_seconds: 4, work_days: [1, 2, 3, 4, 5, 6], day_start: "09:00", day_end: "18:00", slot_minutes: 30, default_duration_min: 30, min_notice_hours: 3, horizon_days: 14, slots_to_offer: 3, snooze_days: 30, appt_reminder_on: true, appt_reminder_hours: 24, yes_words: ["si", "claro", "quiero", "agendar"], no_words: ["no", "despues", "luego"], optout_words: ["baja", "stop"], alarm_words: ["dolor", "hinchado", "fiebre"], tpl_offer: "Con gusto, {nombre}. Tengo estos horarios:\n{horarios}\nResponde con el número del que prefieras.", tpl_no_slots: "", tpl_booked: "Listo, {nombre}. Tu cita quedó para el {fecha} a las {hora}.", tpl_declined: "", fallback_on: true, tpl_fallback: "", tpl_alarm_patient: "", tpl_alarm_doctor: "", tpl_optout: "", tpl_appt_reminder: "", tpl_appt_confirmed: "", tpl_appt_cancelled: "", tpl_postcare_ok: "" };

async function load() {
  const [settings, ...rest] = await Promise.all([api.list("settings"), ...TABLES.map((t) => api.list(t))]);
  if (!settings.length) return false;
  D.settings = settings[0];
  TABLES.forEach((t, i) => (D[t] = rest[i]));
  return true;
}
const proc = (id) => D.procedures.find((p) => p.id === id);
const pat = (id) => D.patients.find((p) => p.id === id);
const nextAppt = (pid) => D.appointments.filter((a) => a.patient_id === pid && ["agendada", "confirmada"].includes(a.status) && new Date(a.starts_at) > Date.now())[0];
const STATUS = { programado: "Programado", enviando: "Enviando", enviado: "Enviado", entregado: "Entregado", leido: "Leído", fallido: "No se envió", recibido: "Recibido" };
const KIND = { recordatorio: "Aviso de retoque", postcuidado: "Seguimiento", cita: "Recordatorio de cita", respuesta: "Asistente", alerta: "Aviso al médico", manual: "Escrito a mano" };

// Última aplicación de cada procedimiento por paciente, con su ventana.
function tracks() {
  const map = new Map();
  for (const t of D.treatments) { // ya vienen de la más reciente a la más antigua
    const k = t.patient_id + ":" + t.procedure_id;
    if (!map.has(k)) map.set(k, t);
  }
  return [...map.values()].map((t) => {
    const p = proc(t.procedure_id), pt = pat(t.patient_id);
    if (!p || !pt) return null;
    const days = Math.floor((Date.now() - new Date(t.performed_at)) / DAY);
    const state = days >= p.window_max_days ? "fuera" : days >= p.window_min_days ? "ventana" : "antes";
    const rems = D.messages.filter((m) => m.treatment_id === t.id && m.kind === "recordatorio");
    return { t, p, pt, days, state, rems, appt: nextAppt(pt.id) };
  }).filter(Boolean);
}
function followText(k) {
  if (k.pt.opted_out) return `<span class="tag red">Se dio de baja</span>`;
  if (!k.pt.consent) return `<span class="tag amber">Sin autorización de WhatsApp</span>`;
  if (k.appt) return `Tiene cita el ${esc(fDay(k.appt.starts_at))}`;
  if (k.pt.bot_paused) return `<span class="tag red">Asistente en pausa</span>`;
  if (k.t.snoozed_until && new Date(k.t.snoozed_until) > Date.now()) return `Pospuesto hasta el ${esc(fDate(k.t.snoozed_until))}`;
  if (!k.p.reminders_on || !k.p.active) return "Avisos apagados";
  if (k.rems.length) return `${k.rems.length} de ${k.p.max_reminders} avisos · ${esc(STATUS[k.rems[0].status] || k.rems[0].status)}`;
  if (k.days >= k.p.first_reminder_days) return "Sale en el siguiente horario de envío";
  return `Primer aviso en ${k.p.first_reminder_days - k.days} días`;
}
function winBar(k, caption = false) {
  const scale = Math.max(k.p.window_max_days * 1.25, k.days * 1.05, 1);
  const pct = (n) => Math.min(100, (n / scale) * 100).toFixed(1);
  const label = k.state === "fuera" ? `Fuera de ventana, día ${k.days}` : k.state === "ventana" ? `En ventana, día ${k.days}` : `Día ${k.days}; la ventana abre el día ${k.p.window_min_days}`;
  return `<div class="win ${k.state}" role="img" aria-label="${esc(label)}"><div class="zone" style="left:${pct(k.p.window_min_days)}%;width:${(pct(k.p.window_max_days) - pct(k.p.window_min_days)).toFixed(1)}%"></div><div class="now" style="left:${pct(k.days)}%"></div></div>` +
    (caption ? `<div class="win-cap"><span>${esc(label)}</span><span>Ventana: día ${k.p.window_min_days} a ${k.p.window_max_days}</span></div>` : "");
}
const stateTag = (k) => k.state === "fuera" ? `<span class="tag red">Fuera de ventana</span>` : k.state === "ventana" ? `<span class="tag blue">En ventana</span>` : `<span class="tag">Aún no toca</span>`;

// ───────────── Vistas ─────────────
function viewHoy() {
  const ks = tracks();
  const due = ks.filter((k) => k.state !== "antes").sort((a, b) => (b.state === "fuera") - (a.state === "fuera") || b.days - a.days);
  const today = D.appointments.filter((a) => dayKey(a.starts_at) === dayKey(Date.now()) && a.status !== "cancelada");
  const alerts = D.alerts.filter((a) => !a.resolved_at);
  const attention = D.patients.filter((p) => p.needs_attention && !alerts.some((a) => a.patient_id === p.id));
  const unknown = D.messages.filter((m) => !m.patient_id && m.direction === "in").slice(0, 3);
  const lp = localParts(new Date());
  const monthStart = zonedToUtc(lp.y, lp.m, 1, 0, 0);
  const inMonth = (d) => new Date(d) >= monthStart;
  const rem = D.messages.filter((m) => m.kind === "recordatorio" && m.status !== "fallido" && inMonth(m.created_at));
  const reminded = new Set(rem.map((m) => m.patient_id));
  const replied = new Set(D.messages.filter((m) => m.direction === "in" && inMonth(m.created_at) && reminded.has(m.patient_id)).map((m) => m.patient_id));
  const booked = D.appointments.filter((a) => a.source === "fideliza" && inMonth(a.created_at));
  const income = D.treatments.filter((t) => t.source === "fideliza" && inMonth(t.performed_at)).reduce((s, t) => s + Number(t.price || 0), 0);
  const nIn = due.filter((k) => k.state === "ventana").length, nOut = due.length - nIn;
  const lastIn = (pid) => D.messages.find((m) => m.patient_id === pid && m.direction === "in");

  return `
  <div class="head"><div>
    <h1>${nOut ? `${nOut} ${nOut === 1 ? "paciente ya salió" : "pacientes ya salieron"} de su ventana` : nIn ? `${nIn} ${nIn === 1 ? "paciente está" : "pacientes están"} en ventana de retoque` : "Todo al día"}</h1>
    <p class="muted">${esc(fmt(Date.now(), { weekday: "long", day: "numeric", month: "long" }))} · ${nIn} en ventana · ${today.length} ${today.length === 1 ? "cita" : "citas"} hoy</p>
  </div><button class="primary" data-act="new-patient">Nuevo paciente</button></div>

  ${D.settings.bot_enabled ? "" : `<div class="notice amber"><div><strong>El asistente está apagado.</strong> No saldrán avisos automáticos ni respuestas.</div><a href="#/config">Encender en Configuración</a></div>`}
  ${alerts.map((a) => `<div class="notice red"><div><strong>${esc(pat(a.patient_id)?.name || "Paciente")} reportó una molestia</strong> · ${esc(fWhen(a.created_at))}<br>«${esc(a.body)}»</div>
    <div class="acts"><a class="btn" href="#/paciente/${a.patient_id}">Abrir conversación</a><button data-act="resolve-alert" data-id="${a.id}">Marcar como atendida</button></div></div>`).join("")}
  ${attention.map((p) => `<div class="notice amber"><div><strong>${esc(p.name)} espera respuesta</strong><br>${esc(lastIn(p.id)?.body || "Escribió un mensaje que el asistente no supo contestar.")}</div>
    <div class="acts"><a class="btn" href="#/paciente/${p.id}">Abrir conversación</a><button data-act="clear-attention" data-id="${p.id}">Ya lo atendí</button></div></div>`).join("")}
  ${unknown.map((m) => `<div class="notice"><div><strong>Mensaje de un número que no está registrado</strong> · ${esc((m.from_number || "").replace("whatsapp:", ""))}<br>${esc(m.body)}</div></div>`).join("")}

  <section><div class="sec-head"><h2>Por recuperar</h2><span class="muted small">La franja azul es la ventana ideal para volver; la línea es hoy.</span></div>
  <div class="sheet">${due.length ? `<table><thead><tr><th>Paciente</th><th>Procedimiento</th><th>Última vez</th><th style="width:190px">Ventana</th><th>Seguimiento</th><th></th></tr></thead><tbody>
    ${due.map((k) => `<tr><td><a class="name" href="#/paciente/${k.pt.id}">${esc(k.pt.name)}</a></td><td>${esc(k.p.name)}</td>
      <td>${esc(fDate(k.t.performed_at))}<div class="muted small">hace ${k.days} días</div></td><td>${winBar(k)}${stateTag(k)}</td>
      <td class="small">${followText(k)}</td><td><button data-act="force" data-id="${k.t.id}">Enviar aviso ahora</button></td></tr>`).join("")}
    </tbody></table>` : `<div class="empty">Nadie está en ventana todavía. Registra procedimientos en la ficha de cada paciente y aquí aparecerán cuando les toque volver.</div>`}</div></section>

  <section><div class="sec-head"><h2>Citas de hoy</h2><a href="#/agenda">Ver la semana</a></div>
  <div class="sheet">${today.length ? `<table><tbody>${today.map((a) => `<tr><td style="width:80px"><strong>${esc(fTime(a.starts_at))}</strong></td><td><a class="name" href="#/paciente/${a.patient_id}">${esc(pat(a.patient_id)?.name || "")}</a></td><td>${esc(proc(a.procedure_id)?.name || "Valoración")}</td><td>${apptTag(a)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No hay citas para hoy.</div>`}</div></section>

  <section><div class="sec-head"><h2>Este mes</h2></div><div class="figures">
    <div><strong>${rem.length}</strong><span>avisos de retoque enviados</span></div>
    <div><strong>${replied.size}</strong><span>pacientes respondieron</span></div>
    <div><strong>${booked.length}</strong><span>citas agendadas por Fideliza</span></div>
    <div><strong>${money(income)}</strong><span>ingreso de pacientes que volvieron por un aviso</span></div>
  </div></section>`;
}
const apptTag = (a) => `<span class="tag ${a.status === "confirmada" ? "blue" : a.status === "cancelada" ? "red" : ""}">${{ agendada: "Agendada", confirmada: "Confirmada", atendida: "Atendida", cancelada: "Cancelada" }[a.status] || a.status}</span>${a.source === "fideliza" ? ` <span class="tag blue">Por Fideliza</span>` : ""}`;

function viewPacientes() {
  const q = ui.search.toLowerCase();
  const ks = tracks();
  const list = D.patients.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.phone || "").includes(q));
  return `
  <div class="head"><div><h1>Pacientes</h1><p class="muted">${D.patients.length} registrados</p></div><button class="primary" data-act="new-patient">Nuevo paciente</button></div>
  <div class="field" style="max-width:340px"><label for="q">Buscar por nombre o teléfono</label><input id="q" type="search" value="${esc(ui.search)}" data-search></div>
  <div class="sheet">${list.length ? `<table><thead><tr><th>Paciente</th><th>Teléfono</th><th>Último procedimiento</th><th>Estado</th><th>WhatsApp</th></tr></thead><tbody>
  ${list.map((p) => {
    const mine = ks.filter((k) => k.pt.id === p.id).sort((a, b) => a.days - b.days);
    const worst = mine.find((k) => k.state === "fuera") || mine.find((k) => k.state === "ventana") || mine[0];
    return `<tr><td><a class="name" href="#/paciente/${p.id}">${esc(p.name)}</a></td><td>${esc(p.phone || "—")}</td>
    <td>${mine[0] ? `${esc(mine[0].p.name)} <span class="muted small">· hace ${mine[0].days} días</span>` : `<span class="muted">Sin procedimientos</span>`}</td>
    <td>${worst ? stateTag(worst) : ""}</td>
    <td>${p.opted_out ? `<span class="tag red">Se dio de baja</span>` : p.consent ? `<span class="tag blue">Autorizado</span>` : `<span class="tag amber">Sin autorización</span>`}</td></tr>`;
  }).join("")}</tbody></table>` : `<div class="empty">${q ? "Ningún paciente coincide con la búsqueda." : "Aún no hay pacientes. Agrega el primero con «Nuevo paciente»."}</div>`}</div>`;
}

function viewPaciente(id) {
  const p = pat(id);
  if (!p) return `<p>No se encontró al paciente. <a href="#/pacientes">Volver a pacientes</a></p>`;
  const ks = tracks().filter((k) => k.pt.id === id);
  const trs = D.treatments.filter((t) => t.patient_id === id);
  const appts = D.appointments.filter((a) => a.patient_id === id).sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));
  const msgs = D.messages.filter((m) => m.patient_id === id).slice().reverse();
  const alert = D.alerts.find((a) => a.patient_id === id && !a.resolved_at);
  return `
  <p class="small" style="margin-bottom:12px"><a href="#/pacientes">Pacientes</a></p>
  <div class="head"><div><h1>${esc(p.name)}</h1><p class="muted">${esc(p.phone || "Sin teléfono")} · paciente desde ${esc(fmt(p.created_at, { month: "long", year: "numeric" }))}</p></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button data-act="edit-patient" data-id="${id}">Editar datos</button><button data-act="new-treatment" data-id="${id}">Registrar procedimiento</button><button class="primary" data-act="new-appt" data-id="${id}">Agendar cita</button></div></div>
  ${alert ? `<div class="notice red"><div><strong>Reportó una molestia.</strong> El asistente dejó de contestarle hasta que lo marques como atendido.<br>«${esc(alert.body)}»</div><button data-act="resolve-alert" data-id="${alert.id}">Marcar como atendida</button></div>` : ""}
  ${!p.consent && !p.opted_out ? `<div class="notice amber"><div><strong>No ha autorizado mensajes por WhatsApp.</strong> Mientras no lo marques como autorizado, Fideliza no le escribe.</div><button data-act="edit-patient" data-id="${id}">Registrar autorización</button></div>` : ""}
  ${p.opted_out ? `<div class="notice red"><div><strong>Se dio de baja de los mensajes.</strong> Fideliza ya no le escribe.</div></div>` : ""}
  <div class="cols"><div>
    <div class="panel"><h2>Ventanas de retoque</h2>${ks.length ? `<div class="rows">${ks.map((k) => `<div style="display:block"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><strong>${esc(k.p.name)}${k.t.zone ? ` <span class="muted" style="font-weight:400">· ${esc(k.t.zone)}</span>` : ""}</strong><span class="small">${followText(k)}</span></div>${winBar(k, true)}
      <div style="margin-top:8px"><button data-act="force" data-id="${k.t.id}">Enviar aviso ahora</button></div></div>`).join("")}</div>` : `<p class="muted">Registra un procedimiento para empezar a darle seguimiento.</p>`}</div>
    <div class="panel"><h2>Historial</h2>${trs.length ? `<div class="rows">${trs.map((t) => `<div><span><strong>${esc(proc(t.procedure_id)?.name || "")}</strong>${t.zone ? ` · ${esc(t.zone)}` : ""}${t.source === "fideliza" ? ` <span class="tag blue">Volvió por un aviso</span>` : ""}</span><span class="muted">${esc(fDate(t.performed_at))} <button class="link danger" data-act="del-treatment" data-id="${t.id}" aria-label="Borrar este registro">Borrar</button></span></div>`).join("")}</div>` : `<p class="muted">Sin procedimientos registrados.</p>`}</div>
    <div class="panel"><h2>Citas</h2>${appts.length ? `<div class="rows">${appts.map((a) => `<div><span><strong>${esc(fDay(a.starts_at))}, ${esc(fTime(a.starts_at))}</strong> · ${esc(proc(a.procedure_id)?.name || "Valoración")}</span><span>${apptTag(a)} <button class="link" data-act="open-appt" data-id="${a.id}">Cambiar</button></span></div>`).join("")}</div>` : `<p class="muted">Sin citas.</p>`}</div>
    ${p.notes ? `<div class="panel"><h2>Notas</h2><p style="white-space:pre-wrap">${esc(p.notes)}</p></div>` : ""}
  </div><div>
    <div class="panel"><h2>Conversación por WhatsApp</h2>
      <div class="chat" id="chat">${msgs.length ? msgs.map((m) => `<div class="bubble ${m.direction} ${m.kind === "alerta" ? "alerta" : ""} ${m.status === "fallido" ? "fallido" : ""}">${esc(m.body)}<div class="meta ${m.status === "fallido" ? "err" : ""}">${m.direction === "out" ? esc(KIND[m.kind] || m.kind) + " · " : ""}${esc(fWhen(m.sent_at || m.created_at))}${m.direction === "out" ? " · " + esc(STATUS[m.status] || m.status) : ""}${m.error ? `<br>${esc(m.error)}` : ""}</div></div>`).join("") : `<p class="muted">Todavía no hay mensajes con este paciente.</p>`}</div>
      <form class="composer" data-form="send" data-id="${id}"><div style="flex:1"><label for="msg">Escribir un mensaje</label><textarea id="msg" name="body" required ${p.consent && !p.opted_out ? "" : "disabled"}></textarea></div><button class="primary" ${p.consent && !p.opted_out ? "" : "disabled"}>Enviar</button></form>
    </div>
  </div></div>`;
}

function viewAgenda() {
  const lp = localParts(new Date());
  const monday = Date.UTC(lp.y, lp.m - 1, lp.d - (lp.dow - 1) + 7 * ui.week, 12);
  const names = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
  const todayKey = dayKey(Date.now());
  const days = [...Array(7)].map((_, i) => {
    const d = new Date(monday + i * DAY);
    const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const list = D.appointments.filter((a) => dayKey(a.starts_at) === key);
    return { i, d, key, list };
  }).filter((x) => D.settings.work_days.includes(x.i + 1) || x.list.length);
  const total = days.reduce((s, x) => s + x.list.filter((a) => a.status !== "cancelada").length, 0);
  const byF = days.reduce((s, x) => s + x.list.filter((a) => a.source === "fideliza" && a.status !== "cancelada").length, 0);
  const label = (d) => `${d.getUTCDate()} ${new Intl.DateTimeFormat("es-MX", { month: "short", timeZone: "UTC" }).format(d)}`;
  return `
  <div class="head"><div><h1>Semana del ${label(new Date(monday))} al ${label(new Date(monday + 6 * DAY))}</h1>
    <p class="muted">${total} ${total === 1 ? "cita" : "citas"}${byF ? ` · ${byF} agendadas por Fideliza` : ""}</p></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button data-act="week" data-d="-1">Semana anterior</button><button data-act="week" data-d="0">Hoy</button><button data-act="week" data-d="1">Semana siguiente</button><button class="primary" data-act="new-appt">Nueva cita</button></div></div>
  <div class="week">${days.map((x) => `<div class="day ${x.key === todayKey ? "today" : ""}"><header><span>${names[x.i]}</span><span>${x.d.getUTCDate()}</span></header>
    ${x.list.length ? x.list.map((a) => `<button class="appt ${a.status}" data-act="open-appt" data-id="${a.id}"><span class="t">${esc(fTime(a.starts_at))}</span> ${esc(pat(a.patient_id)?.name || "")}<br><span class="muted small">${esc(proc(a.procedure_id)?.name || "Valoración")}${a.status === "confirmada" ? " · confirmada" : a.status === "atendida" ? " · atendida" : ""}</span>${a.source === "fideliza" ? `<br><span class="by">Agendada por Fideliza</span>` : ""}</button>`).join("") : `<div class="empty small">Sin citas</div>`}</div>`).join("")}</div>`;
}

function viewMensajes() {
  const f = ui.msgFilter;
  const list = D.messages.filter((m) => f === "todos" || (f === "fallidos" ? m.status === "fallido" : f === "recibidos" ? m.direction === "in" : m.status === "programado")).slice(0, 200);
  const opt = (v, t) => `<option value="${v}" ${f === v ? "selected" : ""}>${t}</option>`;
  return `
  <div class="head"><div><h1>Mensajes</h1><p class="muted">Todo lo que Fideliza envió y recibió por WhatsApp.</p></div>
  <div style="min-width:220px"><label for="mf">Mostrar</label><select id="mf" data-msgfilter>${opt("todos", "Todos")}${opt("recibidos", "Recibidos de pacientes")}${opt("programados", "Programados")}${opt("fallidos", "No se enviaron")}</select></div></div>
  <div class="sheet">${list.length ? `<table><thead><tr><th>Cuándo</th><th>Paciente</th><th>Tipo</th><th>Mensaje</th><th>Estado</th></tr></thead><tbody>
  ${list.map((m) => `<tr><td style="white-space:nowrap">${esc(fWhen(m.sent_at || m.created_at))}</td><td>${m.patient_id ? `<a class="name" href="#/paciente/${m.patient_id}">${esc(pat(m.patient_id)?.name || "")}</a>` : esc((m.from_number || "").replace("whatsapp:", ""))}</td>
    <td>${m.direction === "in" ? "Respuesta del paciente" : esc(KIND[m.kind] || m.kind)}</td><td style="max-width:380px">${esc(m.body.length > 140 ? m.body.slice(0, 140) + "…" : m.body)}${m.error ? `<div class="small" style="color:var(--red)">${esc(m.error)}</div>` : ""}</td>
    <td><span class="tag ${m.status === "fallido" ? "red" : m.status === "leido" || m.status === "recibido" ? "blue" : ""}">${esc(STATUS[m.status] || m.status)}</span></td></tr>`).join("")}</tbody></table>` : `<div class="empty">No hay mensajes en esta vista.</div>`}</div>`;
}

// Configuración
const DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const fNum = (name, label, hint = "", o = {}) => `<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="number" min="${o.min ?? 0}" data-type="int" value="${esc(o.v ?? D.settings[name])}">${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
const fText = (name, label, hint = "") => `<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="text" value="${esc(D.settings[name])}">${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
const fTimeIn = (name, label) => `<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="time" value="${esc(String(D.settings[name]).slice(0, 5))}"></div>`;
const fArea = (name, label, hint = "") => `<div class="field"><label for="f-${name}">${label}</label><textarea id="f-${name}" name="${name}">${esc(D.settings[name])}</textarea>${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
const fWords = (name, label, hint = "") => `<div class="field"><label for="f-${name}">${label}</label><textarea id="f-${name}" name="${name}" data-type="words">${esc((D.settings[name] || []).join(", "))}</textarea><div class="hint">${hint || "Separadas por comas. No importan mayúsculas ni acentos."}</div></div>`;
const fDays = (name, label) => `<label>${label}</label><div class="days">${DAYS.map((d, i) => `<label><input type="checkbox" name="${name}" data-type="days" value="${i + 1}" ${D.settings[name].includes(i + 1) ? "checked" : ""}>${d}</label>`).join("")}</div>`;
const fBool = (name, label) => `<label class="check"><input type="checkbox" name="${name}" data-type="bool" ${D.settings[name] ? "checked" : ""}>${label}</label>`;
const save = `<div class="save-row"><button class="primary">Guardar cambios</button></div>`;
const VARS = "Puedes usar {nombre}, {consultorio} y {doctor}.";

function viewConfig() {
  const s = D.settings;
  const fnBase = cfg.url ? `${cfg.url}/functions/v1/fideliza` : "";
  return `
  <div class="head"><div><h1>Configuración</h1><p class="muted">Aquí decides cuándo escribe Fideliza, qué dice y cómo responde.</p></div></div>
  <div class="config"><nav aria-label="Secciones"><a href="#/config" data-jump="c-clinic">Consultorio</a><a href="#/config" data-jump="c-send">Horario de envío</a><a href="#/config" data-jump="c-proc">Procedimientos</a><a href="#/config" data-jump="c-bot">Respuestas del asistente</a><a href="#/config" data-jump="c-agenda">Agenda y citas</a><a href="#/config" data-jump="c-wa">WhatsApp</a><a href="#/config" data-jump="c-team">Equipo</a><a href="#/config" data-jump="c-sample">Datos de ejemplo</a></nav><div>

  <form class="panel" id="c-clinic" data-form="settings"><h2>Consultorio</h2><div class="grid2">${fText("clinic_name", "Nombre del consultorio", "Así se presenta en los mensajes: {consultorio}.")}${fText("doctor_name", "Nombre del médico", "Se usa como {doctor}.")}</div>
    ${fBool("bot_enabled", "Asistente encendido: envía avisos y responde automáticamente")}${save}</form>

  <form class="panel" id="c-send" data-form="settings"><h2>Horario de envío</h2><p class="muted small" style="margin-bottom:12px">Los avisos automáticos solo salen en estos días y horas. Las respuestas a un paciente que escribe salen siempre.</p>
    ${fDays("send_days", "Días en que pueden salir avisos")}<div class="grid4">${fTimeIn("send_start", "Desde")}${fTimeIn("send_end", "Hasta")}${fNum("reply_delay_seconds", "Segundos antes de responder", "Entre 0 y 20. Una pausa corta se siente más natural.")}</div>${save}</form>

  <div class="panel" id="c-proc"><h2>Procedimientos y tiempos de retoque</h2><p class="muted small" style="margin-bottom:16px">Cada procedimiento tiene su propia ventana y sus propios avisos. Todos los tiempos cuentan desde el día de la aplicación.</p>
    ${D.procedures.map((p) => `<form class="proc" data-form="proc" data-id="${p.id}">
      <div class="proc-head"><input type="text" name="name" value="${esc(p.name)}" aria-label="Nombre del procedimiento"><label class="check" style="margin:0"><input type="checkbox" name="active" ${p.active ? "checked" : ""}>Activo</label><label class="check" style="margin:0"><input type="checkbox" name="reminders_on" ${p.reminders_on ? "checked" : ""}>Avisos de retoque</label></div>
      <div class="grid4">
        <div class="field"><label>La ventana abre el día</label><input type="number" min="0" name="window_min_days" value="${p.window_min_days}"></div>
        <div class="field"><label>La ventana cierra el día</label><input type="number" min="1" name="window_max_days" value="${p.window_max_days}"></div>
        <div class="field"><label>Primer aviso el día</label><input type="number" min="0" name="first_reminder_days" value="${p.first_reminder_days}"></div>
        <div class="field"><label>Repetir cada (días)</label><input type="number" min="1" name="repeat_days" value="${p.repeat_days}"></div>
        <div class="field"><label>Máximo de avisos</label><input type="number" min="0" name="max_reminders" value="${p.max_reminders}"></div>
        <div class="field"><label>Duración de la cita (min)</label><input type="number" min="5" name="duration_min" value="${p.duration_min}"></div>
        <div class="field"><label>Precio habitual (MXN)</label><input type="number" min="0" name="price" value="${Number(p.price)}"></div>
      </div>
      <div class="field"><label>Mensaje del aviso de retoque</label><textarea name="reminder_template">${esc(p.reminder_template)}</textarea><div class="hint">${VARS} Evita nombrar el procedimiento: WhatsApp no es un canal para datos clínicos.</div></div>
      <label class="check"><input type="checkbox" name="postcare_on" ${p.postcare_on ? "checked" : ""}>Preguntar cómo se siente después del procedimiento</label>
      <div class="grid2"><div class="field"><label>Horas después de la aplicación</label><input type="text" name="postcare_hours" value="${esc((p.postcare_hours || []).join(", "))}"><div class="hint">Varias, separadas por comas. Ejemplo: 24, 168 (un día y una semana).</div></div></div>
      <div class="field"><label>Mensaje de seguimiento</label><textarea name="postcare_template">${esc(p.postcare_template)}</textarea></div>
      <div class="save-row"><button class="primary">Guardar ${esc(p.name)}</button></div></form>`).join("")}
    <div class="proc"><button data-act="new-proc">Agregar procedimiento</button></div></div>

  <form class="panel" id="c-bot" data-form="settings"><h2>Respuestas del asistente</h2>
    ${fArea("tpl_offer", "Cuando el paciente quiere cita: ofrecer horarios", VARS + " {horarios} es la lista numerada de espacios libres.")}
    ${fArea("tpl_booked", "Cuando elige un horario", VARS + " También {fecha} y {hora}.")}
    ${fArea("tpl_no_slots", "Cuando no hay espacios libres")}
    ${fArea("tpl_declined", "Cuando dice que ahora no")}
    ${fNum("snooze_days", "Si dice que no, dejar de avisarle por (días)")}
    ${fBool("fallback_on", "Responder cuando no se entiende el mensaje (una persona del consultorio lo verá en «Hoy»)")}
    ${fArea("tpl_fallback", "Cuando no se entiende el mensaje")}
    ${fArea("tpl_postcare_ok", "Cuando contesta que se siente bien")}
    ${fArea("tpl_optout", "Cuando pide ya no recibir mensajes")}
    <h3 style="margin:8px 0 12px">Palabras que entiende</h3>
    ${fWords("yes_words", "Significan «sí, quiero cita»")}${fWords("no_words", "Significan «ahora no»")}${fWords("optout_words", "Para darse de baja")}
    <h3 style="margin:8px 0 12px">Síntomas de alarma</h3>
    <p class="muted small" style="margin-bottom:12px">Si un mensaje contiene alguna de estas palabras, el asistente deja de contestar, avisa al médico y el caso aparece en rojo en «Hoy».</p>
    ${fWords("alarm_words", "Palabras de alarma", "Separadas por comas. También detecta variantes: «dolor» detecta «dolorcito».")}
    ${fArea("tpl_alarm_patient", "Respuesta al paciente")}
    ${fArea("tpl_alarm_doctor", "Aviso que recibe el médico", "Puedes usar {nombre}, {telefono} y {mensaje}.")}${save}</form>

  <form class="panel" id="c-agenda" data-form="settings"><h2>Agenda y citas</h2>
    ${fDays("work_days", "Días de consulta")}<div class="grid4">${fTimeIn("day_start", "Primera cita")}${fTimeIn("day_end", "Fin de la jornada")}${fNum("slot_minutes", "Citas cada (min)", "", { min: 5 })}${fNum("default_duration_min", "Duración por defecto (min)", "", { min: 5 })}</div>
    <div class="grid4">${fNum("slots_to_offer", "Horarios a ofrecer", "", { min: 1 })}${fNum("min_notice_hours", "Anticipación mínima (horas)")}${fNum("horizon_days", "Ofrecer hasta (días adelante)", "", { min: 1 })}</div>
    ${fBool("appt_reminder_on", "Recordar la cita y pedir confirmación")}
    <div class="grid4">${fNum("appt_reminder_hours", "Horas antes de la cita", "", { min: 1 })}</div>
    ${fArea("tpl_appt_reminder", "Mensaje de recordatorio de cita", VARS + " También {fecha} y {hora}.")}
    ${fArea("tpl_appt_confirmed", "Cuando confirma")}${fArea("tpl_appt_cancelled", "Cuando cancela (después se le ofrecen nuevos horarios)")}${save}</form>

  <form class="panel" id="c-wa" data-form="settings"><h2>WhatsApp</h2>
    <div class="grid2"><div class="field"><label for="f-alert_whatsapp">WhatsApp del médico para avisos de alarma</label><input id="f-alert_whatsapp" name="alert_whatsapp" type="tel" data-type="phone" value="${esc(s.alert_whatsapp)}"><div class="hint">10 dígitos. Ahí llega el aviso cuando un paciente reporta una molestia.</div></div>
    <div class="field"><label for="f-mx_prefix">Formato de los números de México</label><select id="f-mx_prefix" name="mx_prefix"><option value="+521" ${s.mx_prefix === "+521" ? "selected" : ""}>+521 (habitual en WhatsApp)</option><option value="+52" ${s.mx_prefix === "+52" ? "selected" : ""}>+52</option></select><div class="hint">Si los mensajes no llegan a un número mexicano, prueba el otro formato.</div></div></div>
    ${fText("sandbox_join_code", "Código de prueba de Twilio", "El texto «join …» que muestra Twilio. Solo sirve para recordárselo a quien vaya a probar.")}
    ${save}
    <div class="proc"><h3>Estado de la conexión</h3><p class="small" id="conn" style="margin:6px 0 10px">${ui.conn ? connText() : "Pulsa el botón para comprobarla."}</p><button type="button" data-act="check-conn">Comprobar conexión</button></div>
    <div class="proc"><h3>Cómo probar con un celular (modo de prueba de Twilio)</h3><ol class="steps small">
      <li>Desde el celular que va a recibir los mensajes, envía por WhatsApp <code>${esc(s.sandbox_join_code || "join tu-codigo")}</code> al <code>+1 415 523 8886</code>.</li>
      <li>Registra ese celular como paciente, marca que autorizó WhatsApp y agrégale un procedimiento con fecha de hace unos meses.</li>
      <li>En «Hoy», pulsa «Enviar aviso ahora». Responde desde el celular y verás la cita aparecer en la agenda.</li></ol>
      <p class="muted small" style="margin-top:8px">En modo de prueba, cada celular debe reenviar el código cada 3 días y solo recibe mensajes libres durante las 24 horas posteriores a su último mensaje.</p>
      ${fnBase ? `<p class="small" style="margin-top:10px">Dirección que va en Twilio, en «When a message comes in»: <code>${esc(fnBase)}/inbound</code></p>` : ""}</div></form>

  <div class="panel" id="c-team"><h2>Equipo con acceso</h2><div class="rows">${D.staff.map((x) => `<div><span>${esc(x.email)}</span>${x.email.toLowerCase() === (user?.email || "").toLowerCase() ? `<span class="muted small">Tú</span>` : `<button class="link danger" data-act="del-staff" data-id="${esc(x.email)}">Quitar acceso</button>`}</div>`).join("")}</div>
    <form data-form="staff" class="composer"><div style="flex:1"><label for="st">Dar acceso a otro correo</label><input id="st" name="email" type="email" required></div><button>Dar acceso</button></form></div>

  <div class="panel" id="c-sample"><h2>Datos de ejemplo</h2><p class="muted small" style="margin-bottom:12px">Carga ocho pacientes ficticios para enseñar la aplicación. No tienen teléfono ni autorización, así que nunca reciben mensajes.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button data-act="load-sample">Cargar pacientes de ejemplo</button>${D.patients.some((p) => p.is_sample) ? `<button class="danger" data-act="del-sample">Quitar pacientes de ejemplo</button>` : ""}</div></div>
  </div></div>`;
}
function connText() {
  const c = ui.conn;
  if (c.error) return `<span style="color:var(--red)">No se pudo comprobar: ${esc(c.error)}</span>`;
  return c.twilio_ok ? `Twilio está conectado. Los mensajes salen de <code>${esc((c.from || "").replace("whatsapp:", ""))}</code>.` : `<span style="color:var(--red)">Falta conectar Twilio: agrega el Account SID y el Auth Token en los secretos de la función.</span>`;
}

// ───────────── Navegación y pintado ─────────────
function route() {
  const [, name = "hoy", arg] = location.hash.split("/");
  return { name, arg };
}
function render() {
  const r = route();
  const view = { hoy: viewHoy, pacientes: viewPacientes, paciente: () => viewPaciente(r.arg), agenda: viewAgenda, mensajes: viewMensajes, config: viewConfig }[r.name] || viewHoy;
  const n = D.alerts.filter((a) => !a.resolved_at).length + D.patients.filter((p) => p.needs_attention).length;
  const link = (h, t, extra = "") => `<a href="#/${h}" ${r.name === h || (h === "pacientes" && r.name === "paciente") ? 'aria-current="page"' : ""}>${t}${extra}</a>`;
  $("#app").innerHTML = `
  <header class="top"><div class="top-in"><a class="brand" href="#/hoy">Fideliza</a>
    <nav class="nav" aria-label="Principal">${link("hoy", "Hoy", n ? `<span class="count">${n}</span>` : "")}${link("pacientes", "Pacientes")}${link("agenda", "Agenda")}${link("mensajes", "Mensajes")}${link("config", "Configuración")}</nav>
    <div class="who"><span>${esc(D.settings.clinic_name)}${DEMO ? " · demostración" : ""}</span>${DEMO ? "" : `<button class="link" data-act="logout">Salir</button>`}</div></div></header>
  <main>${view()}</main>`;
  const chat = $("#chat");
  if (chat) chat.scrollTop = chat.scrollHeight;
}
let toastTimer;
function toast(text, err = false) {
  const t = $("#toast");
  t.textContent = text; t.className = err ? "err" : ""; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 9000 : 4000);
}
async function refresh() { await load(); render(); }
async function softRefresh() {
  const a = document.activeElement;
  const typing = a && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName);
  if ($("#dlg").open || typing) { ui.pendingRefresh = true; await load(); return; }
  await refresh();
}
async function run(fn, okText) {
  try { const r = await fn(); if (okText) toast(okText); return r; }
  catch (e) { console.error(e); toast(e.message || "Algo falló. Intenta de nuevo.", true); }
}

// ───────────── Diálogos ─────────────
function dialog(html, onSubmit) {
  const d = $("#dlg");
  d.innerHTML = `<form method="dialog">${html}</form>`;
  $("form", d).addEventListener("submit", async (e) => {
    e.preventDefault();
    if (e.submitter?.value === "cancel") return d.close();
    const data = Object.fromEntries(new FormData(e.target).entries());
    const ok = await run(() => onSubmit(data, e.submitter?.value));
    if (ok !== undefined) { d.close(); await refresh(); }
  });
  d.showModal();
}
const procOptions = (sel, none = "") => (none ? `<option value="">${none}</option>` : "") + D.procedures.filter((p) => p.active || p.id === sel).map((p) => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}</option>`).join("");
const acts = (label) => `<div class="acts"><button value="cancel" formnovalidate>Cancelar</button><button class="primary" value="ok">${label}</button></div>`;
const todayInput = () => dayKey(Date.now());

function dlgPatient(id) {
  const p = id ? pat(id) : null;
  dialog(`<h2>${p ? "Editar datos" : "Nuevo paciente"}</h2>
    <div class="field"><label for="pn">Nombre completo</label><input id="pn" name="name" required value="${esc(p?.name || "")}"></div>
    <div class="field"><label for="pp">Celular con WhatsApp</label><input id="pp" name="phone" type="tel" inputmode="tel" value="${esc(p?.phone || "")}"><div class="hint">10 dígitos para México. Para otro país, escríbelo con + y código de país.</div></div>
    <label class="check"><input type="checkbox" name="consent" ${p?.consent ? "checked" : ""}>Autorizó recibir mensajes del consultorio por WhatsApp</label>
    ${p?.opted_out ? `<label class="check"><input type="checkbox" name="reopt">Pidió volver a recibir mensajes (quitar la baja)</label>` : ""}
    ${p ? "" : `<div class="grid2"><div class="field"><label for="pt">Procedimiento realizado</label><select id="pt" name="procedure_id">${procOptions("", "Ninguno por ahora")}</select></div><div class="field"><label for="pd">Fecha de aplicación</label><input id="pd" name="date" type="date" value="${todayInput()}" max="${todayInput()}"></div></div>`}
    <div class="field"><label for="po">Notas</label><textarea id="po" name="notes">${esc(p?.notes || "")}</textarea></div>${acts(p ? "Guardar cambios" : "Agregar paciente")}`,
  async (f) => {
    const phone = cleanPhone(f.phone);
    if (phone && !phone.startsWith("+") && phone.length !== 10) throw new Error("El celular debe tener 10 dígitos.");
    if (f.consent && !phone) throw new Error("Para autorizar WhatsApp hace falta el celular.");
    const row = { name: f.name.trim(), phone, consent: !!f.consent, notes: f.notes || "" };
    if (row.consent && !p?.consent) row.consent_at = new Date().toISOString();
    if (f.reopt) row.opted_out = false;
    if (p) { await api.update("patients", id, row); return true; }
    const created = await api.insert("patients", row);
    if (f.procedure_id) await api.insert("treatments", { patient_id: created.id, procedure_id: f.procedure_id, performed_at: fromDateInput(f.date).toISOString(), price: proc(f.procedure_id)?.price || 0 });
    location.hash = "#/paciente/" + created.id;
    return true;
  });
}
function dlgTreatment(pid) {
  dialog(`<h2>Registrar procedimiento</h2>
    <div class="field"><label for="tp">Procedimiento</label><select id="tp" name="procedure_id" required>${procOptions("")}</select></div>
    <div class="grid2"><div class="field"><label for="td">Fecha de aplicación</label><input id="td" name="date" type="date" required value="${todayInput()}" max="${todayInput()}"></div>
    <div class="field"><label for="tz">Zona o detalle</label><input id="tz" name="zone"></div></div>
    <p class="muted small" style="margin-bottom:12px">Con esta fecha Fideliza calcula la ventana de retoque y cuándo avisarle.</p>${acts("Registrar")}`,
  async (f) => { await api.insert("treatments", { patient_id: pid, procedure_id: f.procedure_id, performed_at: fromDateInput(f.date).toISOString(), zone: f.zone || "", price: proc(f.procedure_id)?.price || 0 }); return true; });
}
function dlgNewAppt(pid) {
  dialog(`<h2>Nueva cita</h2>
    <div class="field"><label for="ap">Paciente</label><select id="ap" name="patient_id" required>${D.patients.map((p) => `<option value="${p.id}" ${p.id === pid ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
    <div class="field"><label for="apr">Motivo</label><select id="apr" name="procedure_id">${procOptions("", "Valoración")}</select></div>
    <div class="grid2"><div class="field"><label for="ad">Día</label><input id="ad" name="date" type="date" required value="${todayInput()}"></div><div class="field"><label for="at">Hora</label><input id="at" name="time" type="time" required value="${esc(String(D.settings.day_start).slice(0, 5))}" step="300"></div></div>${acts("Agendar")}`,
  async (f) => {
    const [h, mi] = f.time.split(":").map(Number);
    const p = proc(f.procedure_id);
    await api.insert("appointments", { patient_id: f.patient_id, procedure_id: f.procedure_id || null, starts_at: fromDateInput(f.date, h, mi).toISOString(), duration_min: p?.duration_min || D.settings.default_duration_min, status: "agendada", source: "manual" });
    return true;
  });
}
function dlgAppt(id) {
  const a = D.appointments.find((x) => x.id === id);
  if (!a) return;
  const done = a.status === "atendida" || a.status === "cancelada";
  dialog(`<h2>${esc(pat(a.patient_id)?.name || "")}</h2>
    <p style="margin-bottom:12px">${esc(fDay(a.starts_at))}, ${esc(fTime(a.starts_at))} · ${apptTag(a)}</p>
    ${done ? "" : `<div class="field"><label for="xp">Procedimiento realizado (al marcar como atendida)</label><select id="xp" name="procedure_id">${procOptions(a.procedure_id || "", "Solo valoración, sin procedimiento")}</select><div class="hint">Al marcarla como atendida se registra el procedimiento y empieza a contar su nueva ventana.</div></div>`}
    <div class="acts"><button value="cancel" formnovalidate>Cerrar</button>${done ? "" : `<button class="danger" value="cancelada">Cancelar cita</button>${a.status === "agendada" ? `<button value="confirmada">Confirmar</button>` : ""}<button class="primary" value="atendida">Marcar como atendida</button>`}</div>`,
  async (f, action) => {
    if (action === "atendida" && f.procedure_id) {
      const p = proc(f.procedure_id);
      await api.insert("treatments", { patient_id: a.patient_id, procedure_id: p.id, performed_at: new Date().toISOString(), price: p.price || 0, source: a.source === "fideliza" ? "fideliza" : "consultorio" });
    }
    await api.update("appointments", id, { status: action, procedure_id: f.procedure_id || a.procedure_id || null });
    return true;
  });
}

// ───────────── Acciones ─────────────
const actions = {
  "new-patient": () => dlgPatient(),
  "edit-patient": (el) => dlgPatient(el.dataset.id),
  "new-treatment": (el) => dlgTreatment(el.dataset.id),
  "new-appt": (el) => dlgNewAppt(el.dataset.id),
  "open-appt": (el) => dlgAppt(el.dataset.id),
  week: (el) => { ui.week = +el.dataset.d === 0 ? 0 : ui.week + +el.dataset.d; render(); },
  logout: async () => { await sb.auth.signOut(); location.reload(); },
  async force(el) {
    el.disabled = true; el.textContent = "Enviando…";
    const r = await run(() => api.fn({ force_treatment: el.dataset.id }));
    if (r) {
      if (r.skipped) toast(r.skipped, true);
      else if (r.failed) toast(r.errors?.[0] || "El mensaje no se pudo enviar.", true);
      else if (r.sent) toast("Aviso enviado por WhatsApp.");
      else toast("No había nada que enviar.");
    }
    await refresh();
  },
  async "resolve-alert"(el) {
    const a = D.alerts.find((x) => x.id === el.dataset.id);
    await run(async () => { await api.update("alerts", a.id, { resolved_at: new Date().toISOString() }); await api.update("patients", a.patient_id, { bot_paused: false, needs_attention: false }); }, "Marcada como atendida. El asistente vuelve a contestarle.");
    await refresh();
  },
  async "clear-attention"(el) { await run(() => api.update("patients", el.dataset.id, { needs_attention: false })); await refresh(); },
  async "del-treatment"(el) { if (el.dataset.sure) { await run(() => api.remove("treatments", el.dataset.id), "Registro borrado."); await refresh(); } else { el.dataset.sure = 1; el.textContent = "Pulsa otra vez para borrar"; } },
  async "new-proc"() { await run(() => api.insert("procedures", { name: "Nuevo procedimiento", sort: D.procedures.length + 1 }), "Procedimiento agregado. Ajusta sus tiempos y guarda."); await refresh(); },
  async "del-staff"(el) { await run(() => api.remove("staff", el.dataset.id, "email"), "Acceso retirado."); await refresh(); },
  async "check-conn"() { try { ui.conn = await api.fn({}); } catch (e) { ui.conn = { error: e.message }; } $("#conn").innerHTML = connText(); },
  async "load-sample"() {
    await run(async () => {
      const s = sampleRows(D.procedures), ids = {};
      for (const [name, trs] of s.people) {
        const pt = await api.insert("patients", { name, is_sample: true, notes: "Paciente de ejemplo" });
        ids[name] = pt.id;
        for (const [pr, days, zone] of trs) if (s.p(pr)) await api.insert("treatments", { patient_id: pt.id, procedure_id: s.p(pr), performed_at: s.ago(days), zone });
      }
      for (const [name, off, h, mi, pr] of s.appts) await api.insert("appointments", { patient_id: ids[name], procedure_id: s.p(pr) || null, starts_at: s.at(off, h, mi), status: "agendada", source: "manual" });
    }, "Pacientes de ejemplo cargados.");
    await refresh();
  },
  async "del-sample"(el) {
    if (!el.dataset.sure) { el.dataset.sure = 1; el.textContent = "Pulsa otra vez para quitarlos"; return; }
    await run(async () => { for (const p of D.patients.filter((x) => x.is_sample)) await api.remove("patients", p.id); }, "Pacientes de ejemplo eliminados.");
    await refresh();
  },
};

function readSettingsForm(form) {
  const patch = {};
  for (const el of $$("[name]", form)) {
    const t = el.dataset.type;
    if (t === "days") { (patch[el.name] ||= []); if (el.checked) patch[el.name].push(+el.value); }
    else if (t === "bool") patch[el.name] = el.checked;
    else if (t === "int") patch[el.name] = Math.max(0, parseInt(el.value || "0", 10));
    else if (t === "words") patch[el.name] = el.value.split(",").map((w) => w.trim()).filter(Boolean);
    else if (t === "phone") patch[el.name] = cleanPhone(el.value);
    else patch[el.name] = el.value;
  }
  return patch;
}
const forms = {
  async settings(form) {
    const patch = readSettingsForm(form);
    if ("reply_delay_seconds" in patch) patch.reply_delay_seconds = Math.min(20, patch.reply_delay_seconds);
    await run(() => api.update("settings", 1, patch), "Cambios guardados.");
    await refresh();
  },
  async proc(form) {
    const f = Object.fromEntries(new FormData(form).entries());
    const int = (k) => Math.max(0, parseInt(f[k] || "0", 10));
    const patch = { name: f.name.trim(), active: !!f.active, reminders_on: !!f.reminders_on, postcare_on: !!f.postcare_on, window_min_days: int("window_min_days"), window_max_days: int("window_max_days"), first_reminder_days: int("first_reminder_days"), repeat_days: Math.max(1, int("repeat_days")), max_reminders: int("max_reminders"), duration_min: Math.max(5, int("duration_min")), price: Number(f.price || 0), reminder_template: f.reminder_template, postcare_template: f.postcare_template, postcare_hours: f.postcare_hours.split(",").map((x) => parseInt(x, 10)).filter((x) => x > 0) };
    if (patch.window_max_days <= patch.window_min_days) return toast("La ventana debe cerrar después del día en que abre.", true);
    await run(() => api.update("procedures", form.dataset.id, patch), `${patch.name}: cambios guardados.`);
    await refresh();
  },
  async staff(form) {
    const email = new FormData(form).get("email").trim().toLowerCase();
    await run(() => api.insert("staff", { email }), `${email} ya puede entrar con su correo.`);
    await refresh();
  },
  async send(form) {
    const body = new FormData(form).get("body").trim();
    if (!body) return;
    const r = await run(async () => { await api.insert("messages", { patient_id: form.dataset.id, direction: "out", body, kind: "manual", status: "programado" }); return api.fn({}); });
    if (r?.failed) toast(r.errors?.[0] || "El mensaje no se pudo enviar.", true);
    await refresh();
  },
};

document.addEventListener("click", (e) => {
  const jump = e.target.closest("[data-jump]");
  if (jump) { e.preventDefault(); document.getElementById(jump.dataset.jump)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  const el = e.target.closest("[data-act]");
  if (el && actions[el.dataset.act]) { e.preventDefault(); actions[el.dataset.act](el); }
});
document.addEventListener("submit", (e) => {
  const f = e.target.closest("[data-form]");
  if (f && forms[f.dataset.form]) { e.preventDefault(); forms[f.dataset.form](f); }
});
document.addEventListener("input", (e) => {
  if (e.target.matches("[data-search]")) {
    ui.search = e.target.value; render();
    const q = $("[data-search]"); q.focus(); q.setSelectionRange(q.value.length, q.value.length);
  }
});
document.addEventListener("change", (e) => { if (e.target.matches("[data-msgfilter]")) { ui.msgFilter = e.target.value; render(); } });
document.addEventListener("focusout", () => setTimeout(() => { if (ui.pendingRefresh && !$("#dlg").open && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) { ui.pendingRefresh = false; render(); } }, 50));
window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });

// ───────────── Acceso ─────────────
function gate(html) { $("#app").innerHTML = `<div class="gate"><h1>Fideliza</h1>${html}</div>`; }
function loginScreen(note = "") {
  gate(`<p class="muted">Entra con el correo que tiene acceso al consultorio.</p>${note ? `<div class="notice amber" style="margin-top:16px">${note}</div>` : ""}
    <form id="login"><div class="field"><label for="le">Correo</label><input id="le" type="email" required autocomplete="email"></div><button class="primary" style="width:100%">Enviarme el código de acceso</button></form>`);
  $("#login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#le").value.trim();
    const btn = $("button", e.target); btn.disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    btn.disabled = false;
    if (error) return toast(/rate limit|security purposes/i.test(error.message) ? "Se pidieron demasiados correos seguidos. Espera unos minutos y vuelve a intentarlo, o usa el código del último correo." : error.message, true);
    codeScreen(email);
  });
}
function codeScreen(email) {
  gate(`<p style="margin-top:8px">Te enviamos un correo a <strong>${esc(email)}</strong>. Escribe aquí el código que trae.</p>
    <form id="code"><div class="field"><label for="lc">Código de acceso</label><input id="lc" inputmode="numeric" autocomplete="one-time-code" required pattern="[0-9 ]{6,12}"><div class="hint">Usa el correo más reciente; los anteriores dejan de servir. El código dura una hora.</div></div><button class="primary" style="width:100%">Entrar</button></form>
    <p class="small" style="margin-top:16px"><button class="link" id="again">Usar otro correo o pedir un código nuevo</button></p>`);
  $("#again").addEventListener("click", () => loginScreen());
  $("#code").addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = $("#lc").value.replace(/\D/g, "");
    let r = await sb.auth.verifyOtp({ email, token, type: "email" });
    if (r.error) r = await sb.auth.verifyOtp({ email, token, type: "signup" });
    if (r.error) return toast("El código no es válido o ya venció. Revisa que sea el del correo más reciente o pide uno nuevo.", true);
    if (!user) { user = r.data.user; boot(); }
  });
}

async function start() {
  if (DEMO) { api = mockApi(); await load(); return render(); }
  sb = createClient(cfg.url, cfg.anonKey);
  api = realApi();
  const { data } = await sb.auth.getSession();
  user = data.session?.user || null;
  sb.auth.onAuthStateChange((ev, session) => { if (ev === "SIGNED_IN" && !user) { user = session.user; boot(); } });
  if (!user) {
    const h = new URLSearchParams(location.hash.slice(1));
    const failed = h.get("error_code") || h.get("error");
    if (failed) history.replaceState(null, "", location.pathname);
    return loginScreen(failed ? (failed === "otp_expired" ? "Ese enlace ya venció o ya se había usado. Pide un código nuevo." : "No se pudo entrar con ese enlace. Pide un código nuevo.") : "");
  }
  boot();
}
async function boot() {
  if (location.hash.includes("access_token")) history.replaceState(null, "", location.pathname + "#/hoy");
  try {
    const ok = await load();
    if (!ok) {
      gate(`<div class="notice red" style="margin-top:16px"><div><strong>${esc(user.email)} no tiene acceso a este consultorio.</strong><br>Pide a quien administra Fideliza que agregue tu correo en Configuración, Equipo.</div></div><button id="out">Entrar con otro correo</button>`);
      $("#out").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });
      return;
    }
  } catch (e) { return gate(`<div class="notice red" style="margin-top:16px">No se pudo cargar la información: ${esc(e.message)}</div>`); }
  render();
  let timer;
  sb.channel("fideliza").on("postgres_changes", { event: "*", schema: "public" }, () => { clearTimeout(timer); timer = setTimeout(softRefresh, 400); }).subscribe();
}
start();
