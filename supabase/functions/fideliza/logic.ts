// Fideliza · lógica pura (sin red ni base de datos) para poder probarla.

export function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasWord(text: string, words: string[]): boolean {
  const t = norm(text);
  const tokens = t.split(" ");
  for (const raw of words || []) {
    const w = norm(raw);
    if (!w) continue;
    if (w.includes(" ")) {
      if ((" " + t + " ").includes(" " + w + " ")) return true;
    } else if (tokens.includes(w)) return true;
  }
  return false;
}

// Las palabras de alarma también se buscan como raíz ("dolorcito", "hinchada").
export function hasAlarm(text: string, words: string[]): boolean {
  const t = norm(text);
  for (const raw of words || []) {
    const w = norm(raw);
    if (!w) continue;
    if (w.includes(" ")) { if (t.includes(w)) return true; }
    else if (t.split(" ").some((tok) => (w.length <= 3 ? tok === w : tok.startsWith(w)))) return true;
  }
  return false;
}

export function digits10(phone: string): string {
  return (phone || "").replace(/\D/g, "").slice(-10);
}

export function firstName(name: string): string {
  return (name || "").trim().split(/\s+/)[0] || "";
}

export function render(tpl: string, vars: Record<string, string>): string {
  return (tpl || "").replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// ───────────── Fechas en la zona horaria del consultorio ─────────────
const DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, dow: DOW[p.weekday] };
}

export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const p = localParts(new Date(guess), tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return new Date(guess - (asUtc - guess));
}

function hm(t: string): number {
  const [h, m] = (t || "0:0").split(":").map(Number);
  return h * 60 + (m || 0);
}

export function inSendWindow(now: Date, s: any): boolean {
  const p = localParts(now, s.timezone);
  if (!(s.send_days || []).includes(p.dow)) return false;
  const cur = p.h * 60 + p.min;
  return cur >= hm(s.send_start) && cur < hm(s.send_end);
}

export function fmtDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(d);
}
export function fmtTime(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${p.h}:${String(p.min).padStart(2, "0")}`;
}

// ───────────── Horarios libres ─────────────
export function freeSlots(now: Date, s: any, appts: any[], durationMin: number): Date[] {
  const out: Date[] = [];
  const tz = s.timezone;
  const today = localParts(now, tz);
  const earliest = now.getTime() + (s.min_notice_hours || 0) * 3600e3;
  const busy = (appts || [])
    .filter((a) => a.status !== "cancelada")
    .map((a) => {
      const st = new Date(a.starts_at).getTime();
      return [st, st + (a.duration_min || 30) * 60e3];
    });
  const step = Math.max(5, s.slot_minutes || 30);
  for (let off = 0; off <= (s.horizon_days || 14); off++) {
    const base = new Date(Date.UTC(today.y, today.m - 1, today.d + off, 12));
    const y = base.getUTCFullYear(), m = base.getUTCMonth() + 1, d = base.getUTCDate();
    const dow = ((base.getUTCDay() + 6) % 7) + 1;
    if (!(s.work_days || []).includes(dow)) continue;
    for (let t = hm(s.day_start); t + durationMin <= hm(s.day_end); t += step) {
      const start = zonedToUtc(y, m, d, Math.floor(t / 60), t % 60, tz);
      const a = start.getTime(), b = a + durationMin * 60e3;
      if (a < earliest) continue;
      if (busy.some(([x, z]) => a < z && b > x)) continue;
      out.push(start);
    }
  }
  return out;
}

const DAY_WORDS: Record<string, number> = {
  lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 7,
};

// Lo que el paciente pidió: día de la semana, hoy/mañana, mañana/tarde.
export function parsePreference(text: string, now: Date, tz: string) {
  const t = norm(text);
  const tokens = t.split(" ");
  const days = new Set<number>();
  for (const k in DAY_WORDS) if (tokens.includes(k)) days.add(DAY_WORDS[k]);
  const today = localParts(now, tz).dow;
  let part: "am" | "pm" | null = null;
  if (/\b(en|por|a|de) la manana\b/.test(t) || tokens.includes("temprano")) part = "am";
  if (tokens.includes("tarde") || tokens.includes("tardes") || tokens.includes("noche")) part = "pm";
  const withoutPart = t.replace(/\b(en|por|a|de) la manana\b/g, "");
  if (tokens.includes("hoy")) days.add(today);
  if (/\bmanana\b/.test(withoutPart) && !tokens.includes("pasado")) days.add((today % 7) + 1);
  return { days: [...days], part, any: days.size > 0 || part !== null };
}

export function filterSlots(slots: Date[], pref: any, tz: string): Date[] {
  if (!pref || !pref.any) return slots;
  return slots.filter((d) => {
    const p = localParts(d, tz);
    if (pref.days.length && !pref.days.includes(p.dow)) return false;
    if (pref.part === "am" && p.h >= 12) return false;
    if (pref.part === "pm" && p.h < 12) return false;
    return true;
  });
}

// Elige n horarios repartidos (no tres seguidos de la misma mañana).
export function pickSlots(slots: Date[], n: number, tz: string): Date[] {
  const picked: Date[] = [];
  const seen = new Set<string>();
  for (const d of slots) {
    const p = localParts(d, tz);
    const bucket = `${p.y}-${p.m}-${p.d}-${p.h < 12 ? "am" : p.h < 15 ? "md" : "pm"}`;
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    picked.push(d);
    if (picked.length >= n) return picked;
  }
  for (const d of slots) {
    if (picked.length >= n) break;
    if (!picked.includes(d)) picked.push(d);
  }
  return picked.sort((a, b) => a.getTime() - b.getTime());
}

export function slotsText(slots: Date[], tz: string): string {
  return slots.map((d, i) => `${i + 1}. ${fmtDate(d, tz)}, ${fmtTime(d, tz)}`).join("\n");
}

// ¿Cuál de los horarios ofrecidos eligió?
export function parseChoice(text: string, slots: Date[], tz: string): number {
  const t = norm(text);
  const tokens = t.split(" ");
  const ord: Record<string, number> = { primero: 1, primera: 1, uno: 1, segundo: 2, segunda: 2, dos: 2, tercero: 3, tercera: 3, tres: 3, cuarto: 4, cuarta: 4, cuatro: 4 };
  const time = t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (time) {
    const h = +time[1], mi = +time[2];
    const idx = slots.findIndex((d) => {
      const p = localParts(d, tz);
      return p.min === mi && (p.h === h || p.h === h + 12);
    });
    if (idx >= 0) return idx;
  }
  for (const tok of tokens) {
    if (/^\d$/.test(tok)) {
      const n = +tok;
      if (n >= 1 && n <= slots.length) return n - 1;
    }
    if (ord[tok] && ord[tok] <= slots.length) return ord[tok] - 1;
  }
  return -1;
}

// ───────────── Qué quiso decir el paciente ─────────────
export type Intent = "optout" | "alarm" | "choice" | "offer" | "yes" | "no" | "unknown";

export function classify(text: string, s: any, state: string, offered: Date[], now: Date): { intent: Intent; choice?: number; pref?: any } {
  if (hasWord(text, s.optout_words)) return { intent: "optout" };
  if (hasAlarm(text, s.alarm_words)) return { intent: "alarm" };
  if (state === "ofreciendo" && offered.length) {
    const c = parseChoice(text, offered, s.timezone);
    if (c >= 0) return { intent: "choice", choice: c };
  }
  const pref = parsePreference(text, now, s.timezone);
  const yes = hasWord(text, s.yes_words);
  const no = hasWord(text, s.no_words);
  if (state === "confirmando") {
    if (yes && !no) return { intent: "yes" };
    if (no) return { intent: "no" };
  }
  if (pref.any) return { intent: "offer", pref };
  if (yes && !no) return { intent: state === "postcuidado" ? "yes" : "offer", pref };
  if (no) return { intent: "no" };
  return { intent: "unknown" };
}

// ───────────── Cuándo toca cada recordatorio ─────────────
const DAY = 86400e3;

export function windowState(performedAt: Date, proc: any, now: Date) {
  const days = Math.floor((now.getTime() - performedAt.getTime()) / DAY);
  let state = "antes";
  if (days >= proc.window_max_days) state = "fuera";
  else if (days >= proc.window_min_days) state = "ventana";
  return { days, state };
}

// Devuelve el número de recordatorio que toca enviar ahora, o 0 si no toca.
export function reminderDue(performedAt: Date, proc: any, sent: { sent_at: string }[], now: Date): number {
  if (!proc.active || !proc.reminders_on) return 0;
  const n = sent.length;
  if (n >= proc.max_reminders) return 0;
  const first = performedAt.getTime() + proc.first_reminder_days * DAY;
  if (now.getTime() < first) return 0;
  if (n > 0) {
    const last = Math.max(...sent.map((m) => new Date(m.sent_at).getTime()));
    if (now.getTime() < last + Math.max(1, proc.repeat_days) * DAY) return 0;
  }
  return n + 1;
}

// Firma de Twilio: HMAC-SHA1(url + parámetros ordenados) en base64.
export async function twilioSignature(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function waAddress(patient: any, s: any): string {
  const raw = (patient.phone || "").trim();
  if (raw.startsWith("+")) return "whatsapp:+" + raw.replace(/\D/g, "");
  return "whatsapp:" + (s.mx_prefix || "+521") + digits10(raw);
}

// Los celulares de México pueden estar dados de alta como +52 o como +521: se prueban ambos.
export function mxVariants(to: string): string[] {
  const m = to.match(/^whatsapp:\+52(1?)(\d{10})$/);
  if (!m) return [to];
  return [to, "whatsapp:+52" + (m[1] ? "" : "1") + m[2]];
}
