# Instalar la ingesta automática de Bancolombia (Google Apps Script)

Esto solo lo puedes hacer tú: requiere autorizar un script sobre tu propio Gmail
(as.dibujo@gmail.com). Yo ya dejé listos la migración, la tabla de mapeo y la
Edge Function en Supabase; esto conecta tu correo con esa Edge Function.

## 1. Crear el proyecto de Apps Script

1. Entra a [script.google.com](https://script.google.com) con as.dibujo@gmail.com.
2. "Nuevo proyecto".
3. Ponle de nombre **AS Hub – Ingesta Bancolombia**.
4. Borra el contenido de `Code.gs` y pega el de
   [`bancolombia-apps-script.gs`](./bancolombia-apps-script.gs) (está en este repo).
5. Guarda (Ctrl/Cmd+S).

## 2. Guardar el token secreto (sin dejarlo en el código ni en este repo)

Usa el token que te di por chat (lo generé solo para este endpoint, no se guardó en
ningún archivo del repo). Si prefieres uno tuyo, genera uno random de al menos 32
caracteres (por ejemplo con `openssl rand -base64 32` en una terminal).

1. En la función `setIngestToken`, reemplaza `PEGA_AQUI_EL_TOKEN_UNA_VEZ_Y_BORRALO_DESPUES`
   por ese token.
2. En la barra de funciones (arriba, junto a "Depurar"), elige `setIngestToken` y dale ▶ Ejecutar.
3. La primera vez pedirá autorización: "Revisar permisos" → elige tu cuenta → "Avanzado" →
   "Ir a AS Hub – Ingesta Bancolombia (no seguro)" → Permitir. Es tu propio script sobre tu
   propia cuenta, el aviso de Google es estándar para cualquier Apps Script nuevo.
4. Revisa en "Ejecuciones" (ícono de reloj con flecha, barra lateral) que diga
   "Token guardado...".
5. Ahora borra el token del código (vuelve a dejar el placeholder) y guarda otra vez —
   ya quedó guardado en las Propiedades del script, no hace falta tenerlo en texto plano.

## 3. También guarda el mismo token en Supabase

La Edge Function valida contra un secret del lado del servidor. Entra al
[dashboard de Supabase](https://supabase.com/dashboard/project/derzetuipyugmrjaxcyu/settings/functions)
→ Edge Functions → Secrets → agrega `BANCOLOMBIA_INGEST_TOKEN` con el **mismo valor**
que usaste en el paso 2 (o usa la CLI: `supabase secrets set BANCOLOMBIA_INGEST_TOKEN=<token> --project-ref derzetuipyugmrjaxcyu`).
Los dos lados (Apps Script y Supabase) deben tener exactamente el mismo valor.

## 4. Probar una vez a mano

1. Elige la función `processBancolombiaAlerts` en la barra de funciones → ▶ Ejecutar.
2. Revisa "Ejecuciones" para ver si procesó algo o si hubo errores.
3. En Gmail, busca la etiqueta **AS-procesado**: los correos que se mandaron bien quedan
   marcados ahí.
4. En AS Hub → Finanzas, si el correo se reconoció y la tarjeta ya está mapeada, el
   movimiento aparece solo (con la insignia 🤖). Si no, aparece en el botón
   **📥 Bandeja** del encabezado de Finanzas.

## 5. Programar que corra cada minuto

1. En el editor de Apps Script, ícono de reloj (⏰ "Activadores") en la barra lateral.
2. "Añadir activador".
3. Función: `processBancolombiaAlerts`. Evento: "Controlado por tiempo" →
   "Temporizador de minutos" → "Cada minuto". Guardar.

Listo — de aquí en adelante corre solo.

## 6. Mapear tu tarjeta/cuenta a tu perfil

Antes de que se cree algo automáticamente, en AS Hub → Finanzas → pestaña
**Categorías** → sección "Ingesta automática" → **+ Tarjeta o cuenta**, agrega los
últimos 4 dígitos de tu tarjeta/cuenta Bancolombia y elige tu perfil (Shori/Chori).
Sin esto, todo lo que llegue queda en la Bandeja de revisión en vez de crearse solo
(nunca se asigna un movimiento a un perfil adivinando).

## 7. Si el parser no reconoce tus correos reales

Construí el parser con los formatos públicos típicos de Bancolombia (compra, pago,
retiro, transferencia enviada/recibida), pero **no tuve un correo real tuyo para
calibrarlo**. Cuando tengas 2-3 alertas reales (tapando datos sensibles si quieres),
pásamelas y ajusto `supabase/functions/bancolombia-ingest/parser.js` — tiene pruebas
unitarias (`node --test supabase/functions/bancolombia-ingest/parser.test.js`) así que
puedo verificar el ajuste sin arriesgar los casos que ya funcionan. Mientras tanto,
todo lo que no reconozca cae en la Bandeja de revisión sin inventar nada.
