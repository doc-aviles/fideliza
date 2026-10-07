# Fideliza

Seguimiento y retención de pacientes por WhatsApp para consultorios de medicina estética.

- `docs/` — la aplicación web (se publica con GitHub Pages).
- `supabase/schema.sql` — base de datos, permisos y procedimientos iniciales.
- `supabase/functions/fideliza/` — función de servidor: recibe y envía WhatsApp (Twilio) y calcula qué aviso toca.
  `deploy.ts` es la versión de un solo archivo que se pega en Supabase.
- `test/` — pruebas de la lógica (`node test/logic.test.ts`).

Este repositorio no contiene contraseñas, tokens ni datos de pacientes.
