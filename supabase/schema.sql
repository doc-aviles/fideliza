-- Fideliza · esquema de base de datos (Supabase / Postgres)
-- Pegar completo en el SQL Editor del proyecto y ejecutar una sola vez.

create extension if not exists pgcrypto;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ───────────── Quién puede entrar ─────────────
create table if not exists staff (
  email text primary key,
  name text default '',
  created_at timestamptz not null default now()
);

create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
$$;

-- ───────────── Configuración del consultorio (una sola fila) ─────────────
create table if not exists settings (
  id int primary key default 1 check (id = 1),
  clinic_name text not null default 'Mi consultorio',
  doctor_name text not null default '',
  timezone text not null default 'America/Tijuana',
  -- WhatsApp
  bot_enabled boolean not null default true,
  alert_whatsapp text not null default '',
  mx_prefix text not null default '+521',
  sandbox_join_code text not null default '',
  -- Cuándo pueden salir mensajes automáticos
  send_start time not null default '10:00',
  send_end time not null default '19:00',
  send_days int[] not null default '{1,2,3,4,5,6}',
  reply_delay_seconds int not null default 4,
  -- Agenda
  work_days int[] not null default '{1,2,3,4,5,6}',
  day_start time not null default '09:00',
  day_end time not null default '18:00',
  slot_minutes int not null default 30,
  default_duration_min int not null default 30,
  min_notice_hours int not null default 3,
  horizon_days int not null default 14,
  slots_to_offer int not null default 3,
  snooze_days int not null default 30,
  -- Recordatorio de cita
  appt_reminder_on boolean not null default true,
  appt_reminder_hours int not null default 24,
  -- Palabras que entiende el asistente
  yes_words text[] not null default '{si,claro,ok,okay,va,dale,porfa,por favor,quiero,me interesa,agendar,agenda,agendame,cita,adelante,perfecto,de acuerdo,confirmo,confirmado}',
  no_words text[] not null default '{no,ahorita no,despues,luego,mas adelante,no gracias,no puedo,otro dia}',
  optout_words text[] not null default '{baja,alto,stop,no me escriban,cancelar mensajes}',
  alarm_words text[] not null default '{dolor,duele,hinchado,hinchazon,inflamado,inflamacion,moreton,morado,sangrado,sangre,fiebre,infeccion,pus,alergia,ronchas,no puedo respirar,vision,veo borroso,parpado caido,asimetria,urgencia,emergencia,mareo,vomito}',
  -- Textos de respuesta
  tpl_offer text not null default 'Con gusto, {nombre}. Tengo estos horarios:
{horarios}
Responde con el número del que prefieras.',
  tpl_no_slots text not null default '{nombre}, por ahora no veo espacios libres en esos días. En un momento te escribe alguien del consultorio para buscarte un horario.',
  tpl_booked text not null default 'Listo, {nombre}. Tu cita quedó para el {fecha} a las {hora}. Te esperamos en {consultorio}.',
  tpl_declined text not null default 'Sin problema, {nombre}. Cuando gustes agendar, solo escríbenos por aquí.',
  fallback_on boolean not null default true,
  tpl_fallback text not null default 'Gracias por tu mensaje, {nombre}. En un momento te responde alguien del consultorio.',
  tpl_alarm_patient text not null default '{nombre}, gracias por avisar. Ya le notifiqué a {doctor} y se comunicará contigo lo antes posible. Si sientes que es una urgencia, acude a urgencias o llama al 911.',
  tpl_alarm_doctor text not null default 'AVISO Fideliza: {nombre} ({telefono}) reportó una molestia: "{mensaje}"',
  tpl_optout text not null default 'Listo, {nombre}. Ya no recibirás mensajes automáticos de {consultorio}.',
  tpl_appt_reminder text not null default 'Hola {nombre}, te recordamos tu cita en {consultorio} el {fecha} a las {hora}. Responde SÍ para confirmar o NO si necesitas cambiarla.',
  tpl_appt_confirmed text not null default 'Gracias, {nombre}. Tu cita quedó confirmada.',
  tpl_appt_cancelled text not null default 'Entendido, {nombre}. Cancelé esa cita.',
  tpl_postcare_ok text not null default 'Qué bueno, {nombre}. Cualquier duda, aquí estamos.',
  updated_at timestamptz not null default now()
);
insert into settings (id) values (1) on conflict do nothing;

-- Secreto interno para el reloj automático (no visible desde la app)
create table if not exists app_secrets (
  id int primary key default 1 check (id = 1),
  cron_secret text not null default encode(gen_random_bytes(24), 'hex')
);
insert into app_secrets (id) values (1) on conflict do nothing;

-- ───────────── Procedimientos y sus reglas ─────────────
create table if not exists procedures (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  reminders_on boolean not null default true,
  window_min_days int not null default 90,
  window_max_days int not null default 120,
  first_reminder_days int not null default 90,
  repeat_days int not null default 3,
  max_reminders int not null default 2,
  reminder_template text not null default 'Hola {nombre}, te escribe {consultorio}. Ya es buen momento para tu revaloración. ¿Te aparto un espacio esta semana?',
  duration_min int not null default 30,
  price numeric not null default 0,
  postcare_on boolean not null default true,
  postcare_hours int[] not null default '{24}',
  postcare_template text not null default 'Hola {nombre}, te escribe {consultorio}. ¿Cómo te has sentido después de tu visita? Cuéntanos si todo va bien o si tienes alguna molestia.',
  sort int not null default 0,
  created_at timestamptz not null default now()
);

-- ───────────── Pacientes ─────────────
create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null default '',
  wa_address text,
  consent boolean not null default false,
  consent_at timestamptz,
  opted_out boolean not null default false,
  bot_paused boolean not null default false,
  needs_attention boolean not null default false,
  conv_state text not null default 'idle',
  conv_context jsonb not null default '{}',
  notes text not null default '',
  is_sample boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists patients_phone_idx on patients (right(regexp_replace(phone, '\D', '', 'g'), 10));

create table if not exists treatments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients (id) on delete cascade,
  procedure_id uuid not null references procedures (id),
  performed_at timestamptz not null default now(),
  zone text not null default '',
  price numeric not null default 0,
  source text not null default 'consultorio',
  snoozed_until timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists treatments_patient_idx on treatments (patient_id, procedure_id, performed_at desc);

create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients (id) on delete cascade,
  procedure_id uuid references procedures (id),
  treatment_id uuid references treatments (id) on delete set null,
  starts_at timestamptz not null,
  duration_min int not null default 30,
  status text not null default 'agendada',
  source text not null default 'manual',
  notes text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists appointments_starts_idx on appointments (starts_at);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references patients (id) on delete cascade,
  direction text not null,
  body text not null,
  kind text not null default 'manual',
  status text not null default 'programado',
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz,
  twilio_sid text,
  treatment_id uuid references treatments (id) on delete set null,
  appointment_id uuid references appointments (id) on delete set null,
  dedupe_key text unique,
  error text,
  from_number text,
  created_at timestamptz not null default now()
);
create index if not exists messages_patient_idx on messages (patient_id, created_at);
create index if not exists messages_due_idx on messages (status, scheduled_for);
create index if not exists messages_sid_idx on messages (twilio_sid);

create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- ───────────── Seguridad: solo el equipo del consultorio ─────────────
do $$
declare t text;
begin
  foreach t in array array['staff','settings','procedures','patients','treatments','appointments','messages','alerts','app_secrets']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
  foreach t in array array['staff','settings','procedures','patients','treatments','appointments','messages','alerts']
  loop
    execute format('drop policy if exists equipo on %I', t);
    execute format('create policy equipo on %I for all to authenticated using (is_staff()) with check (is_staff())', t);
  end loop;
end $$;
-- app_secrets queda sin políticas a propósito: nadie la lee desde la app.

-- ───────────── Actualización en vivo ─────────────
do $$
declare t text;
begin
  foreach t in array array['patients','appointments','messages','alerts']
  loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ───────────── Procedimientos iniciales (se editan en Configuración) ─────────────
insert into procedures (name, window_min_days, window_max_days, first_reminder_days, repeat_days, max_reminders, duration_min, price, postcare_hours, sort)
select * from (values
  ('Toxina botulínica', 90, 120, 90, 3, 2, 30, 0, '{24}'::int[], 1),
  ('Ácido hialurónico', 270, 365, 270, 7, 2, 45, 0, '{24,168}'::int[], 2),
  ('Hilos tensores', 365, 540, 365, 14, 2, 90, 0, '{24,168}'::int[], 3),
  ('Control GLP-1', 7, 9, 6, 2, 1, 20, 0, '{}'::int[], 4)
) as v
where not exists (select 1 from procedures);
update procedures set postcare_on = false where name = 'Control GLP-1' and postcare_hours = '{}';

-- ───────────── Primer acceso ─────────────
insert into staff (email, name) values ('doc.aviles@gmail.com', 'Manuel Avilés') on conflict do nothing;
