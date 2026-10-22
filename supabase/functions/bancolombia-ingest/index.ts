import { createClient } from 'npm:@supabase/supabase-js@2';
import { pickManualTwin, planNewAlert, planReplay } from './decide.js';

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

async function profileForLast4(db: ReturnType<typeof createClient>, last4: string | null) {
  if (!last4) return null;
  const { data: mapped, error: mapErr } = await db.from('finance_card_profiles')
    .select('profile_id').eq('last4', last4).eq('active', true);
  if (mapErr) console.error('lookup finance_card_profiles failed', mapErr);
  const distinct = [...new Set((mapped || []).map((m: { profile_id: string }) => m.profile_id))];
  return distinct.length === 1 ? distinct[0] : null;
}

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

  const plan = planNewAlert(rawText);
  // ignored solo si el correo no trae monto. Un abono, un reverso o un pago
  // de la tarjeta queda pending_review: no se crea solo, pero se puede revisar.
  const initialStatus = plan.status === 'ignored' ? 'ignored' : 'pending_review';

  // Antiduplicados: el message id de Gmail es la clave unica de la bandeja.
  // Si ya existe, no se crea movimiento: esa fila entra al aprobarla, o ya
  // quedó applied. Nunca por las dos vías.
  const insertRow: Record<string, unknown> = {
    gmail_message_id: gmailMessageId, received_at: receivedDate.toISOString(), subject, raw_text: rawText,
    status: initialStatus,
    parsed: plan.parsed,
  };

  const { data: inboxRow, error: insertErr } = await db.from('finance_email_inbox')
    .insert(insertRow)
    .select().single();

  if (insertErr) {
    if (insertErr.code === '23505') {
      const { data: existing } = await db.from('finance_email_inbox')
        .select('status').eq('gmail_message_id', gmailMessageId).maybeSingle();
      const replay = planReplay(existing || { status: 'pending_review' });
      return json({ ok: true, duplicate: true, status: replay.status, reason: replay.reason, createTransaction: false });
    }
    console.error('insert finance_email_inbox failed', insertErr);
    return json({ error: 'No se pudo guardar el correo en la bandeja' }, 500);
  }

  const parsed = plan.parsed;
  // 0 coincidencias = tarjeta sin mapear; 2+ = ambiguo. En ambos casos queda pendiente de revision.
  const profileId = await profileForLast4(db, parsed?.last4 ?? null);

  if (!plan.createTransaction) {
    if (parsed) {
      const { error: updErr } = await db.from('finance_email_inbox')
        .update({ parsed, profile_id: profileId })
        .eq('id', inboxRow.id);
      if (updErr) console.error('update finance_email_inbox (revision) failed', updErr);
    }
    return json({ ok: true, status: plan.status, reason: plan.reason });
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
  // movimiento, solo enlazar el correo al que aún no tiene alerta. Si ese
  // manual ya está enlazado a otro correo, no se reutiliza: sería la segunda
  // compra del mismo monto el mismo día. Dos libres tampoco se adivinan.
  const { data: dupes, error: dupeErr } = await db.from('finance_transactions')
    .select('id').eq('profile_id', profileId).eq('source', 'manual')
    .eq('transaction_date', txDate).eq('type', parsed.type).eq('amount', parsed.amount);
  if (dupeErr) console.error('lookup duplicate finance_transactions failed', dupeErr);
  const dupeIds = (dupes || []).map((d: { id: string }) => d.id);
  let linkedIds: string[] = [];
  if (dupeIds.length) {
    const { data: links, error: linkLookupErr } = await db.from('finance_email_inbox')
      .select('transaction_id').in('transaction_id', dupeIds);
    if (linkLookupErr) console.error('lookup linked manuals failed', linkLookupErr);
    linkedIds = (links || []).map((l: { transaction_id: string }) => l.transaction_id);
  }
  const twin = pickManualTwin(dupes || [], linkedIds);
  if (twin) {
    const { error: linkErr } = await db.from('finance_email_inbox')
      .update({ status: 'applied', parsed, profile_id: profileId, transaction_id: twin.id })
      .eq('id', inboxRow.id);
    if (linkErr) console.error('link duplicate finance_email_inbox failed', linkErr);
    return json({ ok: true, status: 'applied', duplicate_of_manual: twin.id });
  }

  // Si este correo ya originó un movimiento (por ejemplo lo aprobaron en la
  // bandeja), no se inserta otro: se enlaza la fila a ese.
  const { data: already, error: alreadyErr } = await db.from('finance_transactions')
    .select('id').eq('source_message_id', gmailMessageId).order('created_at').limit(1);
  if (alreadyErr) console.error('lookup source_message_id failed', alreadyErr);
  if (already && already.length) {
    const { error: linkErr } = await db.from('finance_email_inbox')
      .update({ status: 'applied', parsed, profile_id: profileId, transaction_id: already[0].id })
      .eq('id', inboxRow.id);
    if (linkErr) console.error('link existing finance_email_inbox failed', linkErr);
    return json({ ok: true, status: 'applied', transaction_id: already[0].id, already: true });
  }

  let catId: string | null = null;
  let subId: string | null = null;
  let note: string | null = null;
  if (parsed.description) {
    const { data: rule } = await db.from('finance_merchant_rules')
      .select('category_id, subcategory_id, note').eq('profile_id', profileId)
      .eq('merchant_key', normMerchant(parsed.description)).maybeSingle();
    if (rule) { catId = rule.category_id; subId = rule.subcategory_id; note = rule.note; }
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
    description: note || parsed.description,
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
