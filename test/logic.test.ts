import assert from "node:assert/strict";
import * as L from "../supabase/functions/fideliza/logic.ts";
const s:any = { timezone:"America/Tijuana", send_days:[1,2,3,4,5,6], send_start:"10:00", send_end:"19:00",
  work_days:[1,2,3,4,5,6], day_start:"09:00", day_end:"18:00", slot_minutes:30, min_notice_hours:3, horizon_days:14, slots_to_offer:3,
  yes_words:["si","claro","ok","quiero","agendar","cita","confirmo"], no_words:["no","despues","luego","no gracias"],
  optout_words:["baja","stop"], alarm_words:["dolor","duele","hinchado","inflamado","pus","fiebre","no puedo respirar"] };
// Miércoles 7 oct 2026, 11:00 Tijuana = 18:00 UTC
const now = new Date("2026-10-07T18:00:00Z");
const lp = L.localParts(now, s.timezone);
assert.deepEqual([lp.y,lp.m,lp.d,lp.h,lp.min,lp.dow],[2026,10,7,11,0,3]);
assert.equal(L.zonedToUtc(2026,10,8,16,30,s.timezone).toISOString(),"2026-10-08T23:30:00.000Z");
// cambio de horario: 1 nov 2026 termina DST en Tijuana → 2 nov 9:00 = 17:00Z
assert.equal(L.zonedToUtc(2026,11,2,9,0,s.timezone).toISOString(),"2026-11-02T17:00:00.000Z");
assert.equal(L.inSendWindow(now,s),true);
assert.equal(L.inSendWindow(new Date("2026-10-08T03:30:00Z"),s),false); // 20:30
assert.equal(L.inSendWindow(new Date("2026-10-11T18:00:00Z"),s),false); // domingo
// slots
const appts=[{starts_at:"2026-10-07T21:00:00Z",duration_min:30,status:"agendada"}]; // 14:00
const free = L.freeSlots(now,s,appts,30);
assert.equal(L.fmtTime(free[0],s.timezone),"14:30"); // 11+3h=14:00 ocupado → 14:30
assert.ok(free.every(d=>L.localParts(d,s.timezone).dow!==7));
const picks = L.pickSlots(free,3,s.timezone);
assert.equal(picks.length,3);
console.log(L.slotsText(picks,s.timezone));
// preferencia
let pref = L.parsePreference("Sí, el jueves en la tarde",now,s.timezone);
assert.deepEqual(pref.days,[4]); assert.equal(pref.part,"pm");
const f = L.filterSlots(free,pref,s.timezone);
assert.ok(f.length && f.every(d=>{const p=L.localParts(d,s.timezone);return p.dow===4&&p.h>=12}));
pref = L.parsePreference("mañana en la mañana",now,s.timezone); assert.deepEqual(pref.days,[4]); assert.equal(pref.part,"am");
pref = L.parsePreference("en la mañana",now,s.timezone); assert.deepEqual(pref.days,[]); assert.equal(pref.part,"am");
// elección
const off=[L.zonedToUtc(2026,10,8,16,30,s.timezone),L.zonedToUtc(2026,10,8,17,30,s.timezone)];
assert.equal(L.parseChoice("1",off,s.timezone),0);
assert.equal(L.parseChoice("la segunda porfa",off,s.timezone),1);
assert.equal(L.parseChoice("a las 5:30",off,s.timezone),1);
assert.equal(L.parseChoice("3",off,s.timezone),-1);
// intención
const c=(t:string,st="idle",o:Date[]=[])=>L.classify(t,s,st,o,now).intent;
assert.equal(c("Sí, quiero cita"),"offer");
assert.equal(c("no gracias"),"no");
assert.equal(c("BAJA"),"optout");
assert.equal(c("Me duele mucho y está hinchado"),"alarm");
assert.equal(c("tengo un dolorcito"),"alarm");
assert.equal(c("me puse hielo"),"unknown");
assert.equal(c("2","ofreciendo",off),"choice");
assert.equal(c("sí","confirmando"),"yes");
assert.equal(c("no puedo","confirmando"),"no");
assert.equal(c("todo bien gracias","postcuidado"),"unknown");
assert.equal(c("¿tienen algo el viernes?"),"offer");
assert.equal(c("hola cuánto cuesta"),"unknown");
// recordatorios
const proc={active:true,reminders_on:true,first_reminder_days:90,repeat_days:3,max_reminders:2,window_min_days:90,window_max_days:120};
const d=(n:number)=>new Date(now.getTime()-n*86400e3);
assert.equal(L.reminderDue(d(89),proc,[],now),0);
assert.equal(L.reminderDue(d(91),proc,[],now),1);
assert.equal(L.reminderDue(d(200),proc,[{sent_at:d(1).toISOString()}],now),0);
assert.equal(L.reminderDue(d(200),proc,[{sent_at:d(4).toISOString()}],now),2);
assert.equal(L.reminderDue(d(200),proc,[{sent_at:d(9).toISOString()},{sent_at:d(4).toISOString()}],now),0);
assert.equal(L.windowState(d(111),proc,now).state,"ventana");
assert.equal(L.windowState(d(158),proc,now).state,"fuera");
// firma Twilio (ejemplo de la documentación de Twilio)
const sig = await L.twilioSignature("12345","https://mycompany.com/myapp.php?foo=1&bar=2",{CallSid:"CA1234567890ABCDE",Caller:"+12349013030",Digits:"1234",From:"+12349013030",To:"+18005551212"});
assert.equal(sig,"0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
assert.equal(L.waAddress({phone:"664 555 0142"},{mx_prefix:"+521"}),"whatsapp:+5216645550142");
assert.equal(L.render("Hola {nombre} {x}",{nombre:"Ana"}),"Hola Ana {x}");
console.log("OK");
