# Seguridad de AS Suite (Supabase "Suite Personal")

## Cómo está protegido

- **La puerta real es la sesión de Supabase Auth** (correo + contraseña).
  Sin sesión, la base responde "sin permiso" a todo.
- **Solo los dueños entran.** La lista vive en `private.owners` (fuera de la API).
  La función `private.is_owner()` dice si quien llama está en esa lista.
- **Cada tabla de `public`** tiene RLS activa y una sola política, `owner_all`:
  rol `authenticated` + `is_owner()`. El rol `anon` no tiene ningún permiso.
- **El PIN** es solo un bloqueo rápido en el dispositivo (elegir Shori/Toli).
  No protege la base.
- **El service role** (llave secreta) solo vive en el servidor: en la edge
  function `bancolombia-ingest` y en el cron de AS Reader. Nunca en el
  frontend ni en el repo. La llave *publicable* de `js/config.js` sí es pública
  y por sí sola no abre nada.
- **Edge functions**: `bancolombia-ingest` exige el header `x-ingest-token`
  (un secreto que solo conocen Supabase y el Apps Script). Toda función nueva
  debe pedir un secreto así o un JWT de un dueño (`verify_jwt = true`).

Código: un solo cliente en `js/supabase.js`; la entrada está en `js/session.js`.

## Agregar una tabla nueva de forma segura

Copia esto en una migración nueva (`supabase/migrations/AAAAMMDDhhmmss_nombre.sql`):

```sql
create table public.mi_tabla (
  id uuid primary key default gen_random_uuid(),
  profile_id text references public.profiles (id),
  created_at timestamptz not null default now()
  -- ...tus columnas
);

alter table public.mi_tabla enable row level security;

create policy owner_all on public.mi_tabla
  for all to authenticated
  using ((select private.is_owner()))
  with check ((select private.is_owner()));
```

Reglas:

1. **Nunca** uses `using (true)` ni `to anon` / `to public`.
2. No hace falta `revoke ... from anon`: la migración de seguridad ya dejó
   los permisos por defecto sin anon para las tablas que crees como `postgres`
   (el SQL Editor). Si la creas desde el Table Editor, corre igual
   `revoke all on public.mi_tabla from anon;` por si acaso.
3. Funciones nuevas: `set search_path = ''` (o `= public`) y
   `security invoker` salvo que de verdad necesites `definer`. Si es una RPC
   para la app: `grant execute on function ... to authenticated;`.
4. Después corre el linter (Supabase → Advisors → Security) y
   `node scripts/check-rls.mjs` agregando la tabla a la lista `TABLES`.

## Dar acceso a otra persona (si algún día hace falta)

1. Crea su usuario en Supabase → Authentication → Users → *Add user*.
2. En el SQL Editor:
   ```sql
   insert into private.owners (user_id, email)
   select id, email from auth.users where email = 'su-correo@ejemplo.com';
   ```
   Verá **todo** lo mismo que tú. Para quitarle el acceso: `delete from private.owners where email = '...';`

## Comprobar que sigue bien

```bash
node scripts/check-rls.mjs
```

Con tu sesión también (escribe tu correo y contraseña solo en tu terminal):

```bash
AS_EMAIL=tu-correo AS_PASSWORD='tu-contraseña' node scripts/check-rls.mjs
```

## Ajustes de Supabase Auth que deben quedar así

- Authentication → Sign In / Providers → **Allow new users to sign up: OFF**.
- Authentication → Attack Protection → **Leaked password protection: ON**
  (puede pedir un plan pago; si no está disponible, usa una contraseña larga y única).
- Authentication → URL Configuration → Redirect URLs: la URL de AS HUB y la de AS Reader
  (para el enlace de "olvidé mi contraseña").
