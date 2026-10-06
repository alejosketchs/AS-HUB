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

// Clave para emparejar reglas de comercio: mayusculas, espacios colapsados.
const normMerchant = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');

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

  const parsed = parseBancolombiaAlert(rawText);
  // Sin "$" en el correo no es una transaccion (extracto, aviso de seguridad,
  // promocion...): se guarda para el antiduplicados pero nunca se muestra en
  // la bandeja de revision.
  const looksLikeTransaction = /\$\s*[0-9]/.test(rawText);
  const initialStatus = looksLikeTransaction ? 'pending_review' : 'ignored';

  // Antiduplicados: el message id de Gmail es la clave unica de la bandeja.
  const { data: inboxRow, error: insertErr } = await db.from('finance_email_inbox')
    .insert({
      gmail_message_id: gmailMessageId, received_at: receivedDate.toISOString(), subject, raw_text: rawText,
      status: initialStatus,
    })
    .select().single();

  if (insertErr) {
    if (insertErr.code === '23505') return json({ ok: true, duplicate: true });
    console.error('insert finance_email_inbox failed', insertErr);
    return json({ error: 'No se pudo guardar el correo en la bandeja' }, 500);
  }

  if (!looksLikeTransaction) return json({ ok: true, status: 'ignored', reason: 'sin_monto' });

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

  const txDate = bogotaDateISO(receivedDate);

  // Ya lo registraste a mano antes de que llegara el correo: no crear otro
  // movimiento, solo enlazar el correo al que ya existe. Si hay mas de una
  // coincidencia no se adivina cual es (podrian ser dos compras reales del
  // mismo monto el mismo dia) y se sigue el flujo normal.
  const { data: dupes, error: dupeErr } = await db.from('finance_transactions')
    .select('id').eq('profile_id', profileId).eq('source', 'manual')
    .eq('transaction_date', txDate).eq('type', parsed.type).eq('amount', parsed.amount);
  if (dupeErr) console.error('lookup duplicate finance_transactions failed', dupeErr);
  if (dupes && dupes.length === 1) {
    const { error: linkErr } = await db.from('finance_email_inbox')
      .update({ status: 'applied', parsed, profile_id: profileId, transaction_id: dupes[0].id })
      .eq('id', inboxRow.id);
    if (linkErr) console.error('link duplicate finance_email_inbox failed', linkErr);
    return json({ ok: true, status: 'applied', duplicate_of_manual: dupes[0].id });
  }

  let catId: string | null = null;
  let subId: string | null = null;
  if (parsed.description) {
    const { data: rule } = await db.from('finance_merchant_rules')
      .select('category_id, subcategory_id').eq('profile_id', profileId)
      .eq('merchant_key', normMerchant(parsed.description)).maybeSingle();
    if (rule) { catId = rule.category_id; subId = rule.subcategory_id; }
  }
  if (!catId) {
    const { data: cat, error: catErr } = await db.from('finance_categories')
      .select('id').eq('name', 'Varios / Ocasionales').limit(1).single();
    if (catErr) console.error('lookup categoria Varios/Ocasionales failed', catErr);
    catId = cat?.id ?? null;
    if (catId) {
      const { data: sub } = await db.from('finance_subcategories')
        .select('id').eq('category_id', catId).eq('name', 'Sin clasificar').limit(1).single();
      subId = sub?.id ?? null;
    }
  }

  const { data: tx, error: txErr } = await db.from('finance_transactions').insert({
    profile_id: profileId,
    type: parsed.type,
    amount: parsed.amount,
    transaction_date: txDate,
    occurred_at: receivedDate.toISOString(),
    category_id: catId,
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
