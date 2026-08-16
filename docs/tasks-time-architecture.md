# Tareas y gestión del tiempo

## Modelo

Una tarea es la única fuente de verdad. Al llevarla a la agenda se escriben
`scheduled_date` y `scheduled_time` en la misma fila; no se crea una copia.
Los compromisos sin tarea viven en `agenda_events`. Las eliminaciones desde la
interfaz son archivados lógicos para preservar el historial.

Las duraciones se expresan en minutos, en pasos de 30, con un rango recomendado
de 30 a 240 minutos. `actual_duration_min` y los campos de temporizador permiten
comparar estimación y tiempo real. `reschedule_count` alimenta las estadísticas.

Las preferencias no sensibles pueden guardarse por perfil en `suite_data`. Las
credenciales, refresh tokens y secretos de Google nunca deben guardarse allí ni
en el navegador.

## Sugerencias

El planificador es deliberadamente explicable: puntúa primero la matriz de
Eisenhower, después la cercanía de la fecha límite y finalmente busca un hueco
que acepte la duración completa. Propone como máximo tres tareas y nunca mueve
datos sin confirmación del usuario.

## Recurrencia

Al completar una tarea recurrente se genera su siguiente ocurrencia como una
tarea nueva enlazada por `recurrence_parent_id`, conservando el historial. Los
compromisos recurrentes admiten cambios en una fecha, en esa fecha y futuras, o
en toda la serie; las excepciones se guardan en `recurrence_exceptions`.

## Google Calendar

La base incluye `external_calendar_id`, `external_event_id`, `sync_status` y
marcas de actualización externa. La Edge Function `google-calendar` completa
OAuth, cifra tokens con AES-GCM y valida la sesión propia de AS Hub antes de
aceptar acciones. El callback valida `state` y PKCE antes de intercambiar el
código de Google.

Flujo previsto:

1. El backend completa OAuth y cifra/guarda los tokens fuera de tablas públicas.
2. Un primer sync importa cambios y conserva el `nextSyncToken` de Google.
3. Los sync incrementales usan ese token; un `410` obliga a hacer sync completo.
4. Un webhook de Google solo despierta el proceso; luego el backend consulta los
   cambios incrementales.
5. Conflicto: gana la edición con `updated_at` más reciente. Si las marcas no son
   comparables, `sync_status = conflict` y la interfaz pide elegir.
6. Las operaciones se vuelven idempotentes con `external_event_id`; nunca se
   duplica una tarea para representarla en el calendario.

### Configuración del cliente de Google

1. Habilitar Google Calendar API en Google Cloud.
2. Crear un cliente OAuth de tipo **Web application**.
3. Registrar exactamente este redirect URI:
   `https://derzetuipyugmrjaxcyu.supabase.co/functions/v1/google-calendar`.
4. Guardar `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en Supabase → Edge
   Functions → Secrets. Nunca añadirlos al repositorio o a variables públicas.
5. Opcional: definir `GOOGLE_TOKEN_ENCRYPTION_KEY` con un secreto aleatorio de
   al menos 32 bytes. Sin él, la función deriva la clave del secreto de servicio
   que Supabase inyecta únicamente en el servidor.
6. Definir `AS_HUB_ORIGIN=https://as-hub-orpin.vercel.app` si el dominio cambia;
   este es el valor seguro por defecto de la función.

## Notificaciones

La versión actual muestra avisos del navegador cuando la PWA está abierta. Las
notificaciones push con la app cerrada requieren suscripción Web Push y una
función protegida en servidor; no se simulan desde código cliente.
