/**
 * AS HUB — ingesta de alertas Bancolombia (Google Apps Script).
 * Lee Gmail (as.dibujo@gmail.com), etiqueta lo ya procesado y manda cada
 * correo nuevo a la Edge Function `bancolombia-ingest` de Supabase.
 *
 * Instalación: ver docs/instrucciones-bancolombia-apps-script.md en el repo.
 */

const CONFIG = {
  // Las alertas reales de movimientos llegan con este asunto exacto
  // ("Alertas y Notificaciones"); así se evita capturar promociones del
  // banco que también mencionan "compra" o "transferencia" en el cuerpo.
  GMAIL_SEARCH_QUERY: 'subject:"Alertas y Notificaciones" newer_than:7d',
  LABEL_NAME: 'AS-procesado',
  ENDPOINT_URL: 'https://derzetuipyugmrjaxcyu.supabase.co/functions/v1/bancolombia-ingest',
  MAX_THREADS_PER_RUN: 20,
};

/** Ejecutar UNA vez a mano para guardar el token sin dejarlo en el código. */
function setIngestToken() {
  const TOKEN = 'PEGA_AQUI_EL_TOKEN_UNA_VEZ_Y_BORRALO_DESPUES';
  PropertiesService.getScriptProperties().setProperty('BANCOLOMBIA_INGEST_TOKEN', TOKEN);
  Logger.log('Token guardado en las Propiedades del script.');
}

function getOrCreateLabel_() {
  return GmailApp.getUserLabelByName(CONFIG.LABEL_NAME) || GmailApp.createLabel(CONFIG.LABEL_NAME);
}

/** Disparador: cada minuto. Revisa hilos nuevos y manda cada mensaje a Supabase. */
function processBancolombiaAlerts() {
  const token = PropertiesService.getScriptProperties().getProperty('BANCOLOMBIA_INGEST_TOKEN');
  if (!token) { Logger.log('Falta BANCOLOMBIA_INGEST_TOKEN: corre setIngestToken() primero.'); return; }

  const label = getOrCreateLabel_();
  const query = `${CONFIG.GMAIL_SEARCH_QUERY} -label:${CONFIG.LABEL_NAME}`;
  const threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS_PER_RUN);
  if (!threads.length) return;

  threads.forEach((thread) => {
    let ok = true;
    thread.getMessages().forEach((message) => {
      const payload = {
        gmail_message_id: message.getId(),
        raw_text: message.getPlainBody(),
        received_at: message.getDate().toISOString(),
        subject: message.getSubject(),
      };
      try {
        const res = UrlFetchApp.fetch(CONFIG.ENDPOINT_URL, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-ingest-token': token },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true,
        });
        const code = res.getResponseCode();
        if (code >= 300) { ok = false; Logger.log(`Error ${code} en mensaje ${message.getId()}: ${res.getContentText()}`); }
      } catch (err) {
        ok = false;
        Logger.log(`Excepcion en mensaje ${message.getId()}: ${err}`);
      }
    });
    // Solo se etiqueta el hilo si TODOS sus mensajes se mandaron bien;
    // si algo falló, se reintenta en la próxima corrida (el servidor ya
    // descarta duplicados por gmail_message_id, así que reintentar es seguro).
    if (ok) thread.addLabel(label);
  });
}
