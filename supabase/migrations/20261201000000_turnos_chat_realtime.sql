-- ============================================================
-- Migración: turnos duraderos — avisos en tiempo real.
--
-- Agrega public.turnos_chat a la publicación supabase_realtime para que el
-- cliente sepa al instante cuándo termina un turno que está recuperando
-- (lib/asistente/AsistenteService.ts: un canal por conversación, abierto
-- solo mientras hay una recuperación en curso). Las consultas espaciadas
-- siguen como respaldo.
--
-- Aislamiento: Realtime aplica la RLS de lectura de la tabla
-- (turnos_chat_select: docente_id = auth.uid()); cada docente solo recibe
-- sus turnos. Sin cambios de datos, políticas ni permisos.
-- Idempotente. Rollback: alter publication supabase_realtime drop table public.turnos_chat;
-- ============================================================

begin;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'falta la publicación supabase_realtime';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'turnos_chat') then
    alter publication supabase_realtime add table public.turnos_chat;
  end if;
end $$;

commit;
