-- =====================================================================
-- VUELTA ATRÁS de 20261028120000_seguridad_sesion_rls.sql
-- Deja políticas y permisos EXACTAMENTE como estaban el 2026-10-28
-- (o sea: base abierta otra vez). Usar solo si algo se rompe y hace falta
-- que la app vieja (con PIN) vuelva a funcionar mientras se arregla.
-- No toca datos.
-- =====================================================================

begin;

-- 1. Quitar las políticas "solo dueño"
do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'sessions', 'suite_data',
    'tasks', 'task_projects', 'agenda_events', 'notes',
    'finance_categories', 'finance_subcategories', 'finance_transactions',
    'budgets', 'budget_checks', 'debts', 'savings_goals',
    'finance_card_profiles', 'finance_email_inbox', 'finance_merchant_rules',
    'finance_profile_data',
    'reader_users', 'reader_books', 'reader_logs', 'reader_unlocks',
    'reader_glossary', 'reader_quotes', 'reader_push_subs', 'reader_push_sent'
  ] loop
    execute format('drop policy if exists owner_all on public.%I', t);
  end loop;
end $$;

-- 2. Políticas originales
do $$
declare t text;
begin
  foreach t in array array[
    'agenda_events', 'budget_checks', 'budgets', 'debts', 'finance_categories',
    'finance_subcategories', 'finance_transactions', 'notes', 'profiles',
    'savings_goals', 'sessions', 'task_projects', 'tasks'
  ] loop
    execute format('create policy anon_all on public.%I for all to anon, authenticated using (true) with check (true)', t);
  end loop;

  foreach t in array array['finance_card_profiles', 'finance_email_inbox', 'finance_merchant_rules'] loop
    execute format('create policy anon_all on public.%I for all to public using (true) with check (true)', t);
  end loop;

  foreach t in array array[
    'reader_books', 'reader_glossary', 'reader_logs', 'reader_push_sent',
    'reader_push_subs', 'reader_quotes', 'reader_unlocks', 'reader_users'
  ] loop
    execute format('create policy %I on public.%I for all to public using (true) with check (true)', t || '_all', t);
  end loop;
end $$;

create policy public_insert_suite_data on public.suite_data for insert to public with check (true);
create policy public_read_suite_data   on public.suite_data for select to public using (true);
create policy public_update_suite_data on public.suite_data for update to public using (true) with check (true);

-- 3. Permisos originales de anon
grant all on
  public.agenda_events, public.budget_checks, public.budgets, public.debts,
  public.finance_card_profiles, public.finance_categories, public.finance_email_inbox,
  public.finance_merchant_rules, public.finance_subcategories, public.finance_transactions,
  public.notes, public.profiles, public.savings_goals, public.sessions, public.suite_data,
  public.task_projects, public.tasks,
  public.reader_books, public.reader_glossary, public.reader_logs, public.reader_push_sent,
  public.reader_push_subs, public.reader_quotes, public.reader_unlocks, public.reader_users
to anon;
grant all on all sequences in schema public to anon;

grant execute on function public.finance_email_inbox_on_tx_delete() to public, anon, authenticated;
grant execute on function public.finance_inbox_apply(uuid, jsonb) to public, anon, authenticated;
grant execute on function public.finance_inbox_apply_batch(uuid[]) to public, anon, authenticated;
grant execute on function public.touch_updated_at() to public, anon, authenticated;
alter function public.touch_updated_at() reset search_path;

alter default privileges for role postgres in schema public grant all on tables    to anon;
alter default privileges for role postgres in schema public grant all on sequences to anon;
alter default privileges for role postgres in schema public grant execute on functions to public, anon;

-- 4. private.owners / is_owner() se dejan (no estorban). Para quitarlos del todo:
--    drop function private.is_owner(); drop table private.owners; drop schema private;

commit;
