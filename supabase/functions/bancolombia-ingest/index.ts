import { createClient } from 'npm:@supabase/supabase-js@2';
import { parseBancolombiaAlert } from './parser.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-ingest-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

// Bogota es UTC-5: la fecha del correo en UTC puede ya ser "manana" en Bogota
// cerca de medianoche, asi que transaction_date se calcula en zona Bogota.
const bogotaDateISO = (d: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Metodo no soportado' }, 405);

  const expectedToken = Deno.env.get('BANCOLOMBIA_INGEST_TOKEN');
  if (!expectedToken) return json({ error: 'Token de ingesta no configurado en el servidor' }, 500);
  if (req.headers.get('x-ingest-token') !== expectedToken) return json({ error: 'Token invalido' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'JSON invalido' }, 400);
  }

  const gmailMessageId = String(body.gmail_message_id || '').trim();
  const rawText = String(body.raw_text || '').trim();
  const receivedAt = String(body.received_at || '').trim();
  const subject = String(body.subject || '').trim();
  if (!gmailMessageId || !rawText || !receivedAt) {
    return json({ error: 'Faltan campos: gmail_message_id, raw_text, received_at son obligatorios' }, 400);
  }
  const receivedDate = new Date(receivedAt);
  if (Number.isNaN(receivedDate.getTime())) return json({ error: 'received_at invalido' }, 400);

  const db = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

  // Antiduplicados: el message id de Gmail es la clave unica de la bandeja.
  const { data: inboxRow, error: insertErr } = await db.from('finance_email_inbox')
    .insert({ gmail_message_id: gmailMessageId, received_at: receivedDate.toISOString(), subject, raw_text: rawText })
    .select().single();

  if (insertErr) {
    if (insertErr.code === '23505') return json({ ok: true, duplicate: true });
    console.error('insert finance_email_inbox failed', insertErr);
    return json({ error: 'No se pudo guardar el correo en la bandeja' }, 500);
  }

  const parsed = parseBancolombiaAlert(rawText);

  let profileId: string | null = null;
  if (parsed?.last4) {
    const { data: mapped, error: mapErr } = await db.from('finance_card_profiles')
      .select('profile_id').eq('last4', parsed.last4).eq('active', true);
    if (mapErr) console.error('lookup finance_card_profiles failed', mapErr);
    const distinct = [...new Set((mapped || []).map((m) => m.profile_id))];
    if (distinct.length === 1) profileId = distinct[0];
    // 0 coincidencias = tarjeta sin mapear; 2+ = ambiguo. En ambos casos queda pendiente de revision.
  }

  if (!parsed || !profileId) {
    const { error: updErr } = await db.from('finance_email_inbox')
      .update({ parsed: parsed ?? null, profile_id: profileId })
      .eq('id', inboxRow.id);
    if (updErr) console.error('update finance_email_inbox (pending) failed', updErr);
    return json({ ok: true, status: 'pending_review', reason: parsed ? 'tarjeta_no_mapeada' : 'formato_no_reconocido' });
  }

  const { data: cat, error: catErr } = await db.from('finance_categories')
    .select('id').eq('name', 'Varios / Ocasionales').limit(1).single();
  if (catErr) console.error('lookup categoria Varios/Ocasionales failed', catErr);
  let subId: string | null = null;
  if (cat?.id) {
    const { data: sub } = await db.from('finance_subcategories')
      .select('id').eq('category_id', cat.id).eq('name', 'Sin clasificar').limit(1).single();
    subId = sub?.id ?? null;
  }

  const { data: tx, error: txErr } = await db.from('finance_transactions').insert({
    profile_id: profileId,
    type: parsed.type,
    amount: parsed.amount,
    transaction_date: bogotaDateISO(receivedDate),
    occurred_at: receivedDate.toISOString(),
    category_id: cat?.id ?? null,
    subcategory_id: subId,
    spend_type: parsed.type === 'income' ? 'income' : 'variable',
    description: parsed.description,
    source: 'automatico',
    source_message_id: gmailMessageId,
    source_raw_text: rawText,
  }).select().single();

  if (txErr) {
    console.error('insert finance_transactions failed', txErr);
    await db.from('finance_email_inbox').update({ parsed }).eq('id', inboxRow.id);
    return json({ ok: true, status: 'pending_review', reason: 'error_al_crear_movimiento' });
  }

  const { error: appliedErr } = await db.from('finance_email_inbox')
    .update({ status: 'applied', parsed, profile_id: profileId, transaction_id: tx.id })
    .eq('id', inboxRow.id);
  if (appliedErr) console.error('update finance_email_inbox (applied) failed', appliedErr);

  return json({ ok: true, status: 'applied', transaction_id: tx.id });
});
