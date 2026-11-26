-- ============================================================
-- Migración: Word y PDF por versión de planeación (Hito 2, etapa 4).
--
-- planeacion_versiones ya tiene documento_word_archivo_id y
-- documento_pdf_archivo_id (FK al registro de archivos del MISMO docente) y
-- su disparador de inmutabilidad permite llenarlas UNA sola vez (de null a
-- un valor). Esta migración agrega solo lo necesario para hacerlo de forma
-- segura bajo demanda:
--
-- - planeacion_version_archivos: una fila por (versión, formato) con el
--   mismo patrón que turnos_chat (adquisición atómica, ejecucion_id y
--   plazo): una sola generación a la vez por versión y formato, entre
--   dispositivos y reintentos; una generación cuya función murió vence sola
--   y se puede volver a intentar (recuperable, sin turnos eternos).
-- - reservar / vincular / fallar: SECURITY DEFINER, search_path vacío y
--   EXECUTE solo para service_role (la ejecución confiable de /api/chat que
--   generó el archivo desde el snapshot canónico). El docente nunca puede
--   vincular un archivo por su cuenta.
-- - archivos_generados.version_id / version_formato / version_ejecucion_id
--   (opcionales, null en todos los archivos históricos y en los demás
--   generadores): la identidad exacta de la ejecución que produjo el
--   archivo de una versión, escrita en el registro inicial ('subiendo') y
--   nunca modificable después.
-- - Vincular comprueba propiedad (docente), grupo (el de la planeación,
--   del docente), formato (tipo MIME), estado (activo), procedencia exacta
--   (el archivo declara ESTA versión, ESTE formato y ESTA ejecución, que es
--   la de la reserva vigente y no vencida) y que no esté ligado a ninguna
--   otra versión. Nunca sustituye una referencia ya fijada.
--
-- Sin cambios en hojas de evaluación, resultados ni versiones existentes.
-- Rollback: drop de las 3 funciones, de la tabla, del disparador y de las
-- 3 columnas de archivos_generados (sin datos académicos).
-- ============================================================

begin;

create table public.planeacion_version_archivos (
  version_id uuid not null references public.planeacion_versiones(id) on delete cascade,
  formato text not null check (formato in ('word', 'pdf')),
  docente_id uuid not null references public.perfiles_docentes(id),
  estado text not null check (estado in ('generando', 'vinculado', 'fallido')),
  ejecucion_id uuid,
  reservado_en timestamptz not null default now(),
  vence_en timestamptz,
  archivo_id uuid,
  intentos integer not null default 1,
  error text,
  actualizado_en timestamptz not null default now(),
  primary key (version_id, formato),
  constraint planeacion_version_archivos_generando check (estado <> 'generando' or (ejecucion_id is not null and vence_en is not null)),
  constraint planeacion_version_archivos_vinculado check (estado <> 'vinculado' or archivo_id is not null)
);

alter table public.planeacion_version_archivos enable row level security;
create policy "planeacion_version_archivos_select" on public.planeacion_version_archivos for select using (docente_id = auth.uid());
revoke insert, update, delete, truncate on public.planeacion_version_archivos from anon, authenticated;
revoke all on public.planeacion_version_archivos from anon;

-- Origen de un archivo de versión: los tres datos juntos o ninguno, y el
-- formato coherente con el tipo MIME. Retrocompatible: columnas nulas.
alter table public.archivos_generados
  add column version_id uuid,
  add column version_formato text,
  add column version_ejecucion_id uuid,
  add constraint archivos_generados_origen_version_completo check (
    (version_id is null and version_formato is null and version_ejecucion_id is null)
    or (version_id is not null and version_ejecucion_id is not null and (
      (version_formato = 'word' and tipo_mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      or (version_formato = 'pdf' and tipo_mime = 'application/pdf'))));

-- El origen se fija al registrar el archivo y no cambia nunca después.
create or replace function public._trg_archivos_generados_origen_inmutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.version_id, new.version_formato, new.version_ejecucion_id) is distinct from (old.version_id, old.version_formato, old.version_ejecucion_id) then
    raise exception 'ORIGEN_INMUTABLE: el origen de un archivo de versión no se modifica.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger archivos_generados_origen_inmutable
  before update on public.archivos_generados
  for each row execute function public._trg_archivos_generados_origen_inmutable();

-- ------------------------------------------------------------
-- reservar_archivo_version
-- resultado: existente (ya tiene archivo) | reservado (+ ejecucion_id) |
--   en_proceso (otra generación vigente) | version_invalida | parametros_invalidos
-- ------------------------------------------------------------
create or replace function public.reservar_archivo_version(
  p_docente_id uuid,
  p_version_id uuid,
  p_formato text,
  p_plazo_segundos integer default 150
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.planeacion_versiones;
  r public.planeacion_version_archivos;
  v_existente uuid;
begin
  if p_docente_id is null or p_version_id is null or p_formato is null or p_formato not in ('word', 'pdf')
     or p_plazo_segundos is null or p_plazo_segundos not between 30 and 600 then
    return jsonb_build_object('resultado', 'parametros_invalidos');
  end if;
  -- La versión del docente, de una planeación de un grupo suyo.
  select pv.* into v from public.planeacion_versiones pv
    join public.planeaciones p on p.id = pv.planeacion_id and p.docente_id = pv.docente_id and p.grupo_id = pv.grupo_id
    join public.grupos g on g.id = pv.grupo_id and g.docente_id = pv.docente_id
   where pv.id = p_version_id and pv.docente_id = p_docente_id
   for share of pv;
  if not found then
    return jsonb_build_object('resultado', 'version_invalida');
  end if;
  v_existente := case p_formato when 'word' then v.documento_word_archivo_id else v.documento_pdf_archivo_id end;
  if v_existente is not null then
    return jsonb_build_object('resultado', 'existente', 'archivo_id', v_existente);
  end if;

  insert into public.planeacion_version_archivos (version_id, formato, docente_id, estado, ejecucion_id, reservado_en, vence_en)
  values (p_version_id, p_formato, p_docente_id, 'generando', gen_random_uuid(), now(), now() + make_interval(secs => p_plazo_segundos))
  on conflict (version_id, formato) do nothing
  returning * into r;
  if found then
    return jsonb_build_object('resultado', 'reservado', 'ejecucion_id', r.ejecucion_id);
  end if;

  select * into r from public.planeacion_version_archivos where version_id = p_version_id and formato = p_formato for update;
  if r.estado = 'generando' and r.vence_en > now() then
    return jsonb_build_object('resultado', 'en_proceso');
  end if;
  -- Fallida o vencida (la función que generaba murió): se vuelve a reservar.
  update public.planeacion_version_archivos
     set estado = 'generando', ejecucion_id = gen_random_uuid(), reservado_en = now(),
         vence_en = now() + make_interval(secs => p_plazo_segundos), archivo_id = null, error = null,
         intentos = intentos + 1, actualizado_en = now()
   where version_id = p_version_id and formato = p_formato
   returning * into r;
  return jsonb_build_object('resultado', 'reservado', 'ejecucion_id', r.ejecucion_id);
end;
$$;

-- ------------------------------------------------------------
-- vincular_archivo_version
-- resultado: vinculado | existente (otra ejecución ya lo fijó: + archivo_id) |
--   rechazado (la reserva es de otra ejecución) | vencido (esta ejecución
--   rebasó su plazo: queda fallida) | archivo_invalido
-- ------------------------------------------------------------
create or replace function public.vincular_archivo_version(
  p_docente_id uuid,
  p_version_id uuid,
  p_formato text,
  p_ejecucion_id uuid,
  p_archivo_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.planeacion_version_archivos;
  v public.planeacion_versiones;
  a public.archivos_generados;
  v_existente uuid;
begin
  select * into r from public.planeacion_version_archivos
   where version_id = p_version_id and formato = p_formato and docente_id = p_docente_id
   for update;
  if not found or r.estado <> 'generando' or r.ejecucion_id is distinct from p_ejecucion_id then
    return jsonb_build_object('resultado', 'rechazado');
  end if;
  -- Ejecución vencida (aún no sustituida): nunca vincula; se libera.
  if r.vence_en <= now() then
    update public.planeacion_version_archivos set estado = 'fallido', error = 'vencida', actualizado_en = now()
     where version_id = p_version_id and formato = p_formato;
    return jsonb_build_object('resultado', 'vencido');
  end if;

  select pv.* into v from public.planeacion_versiones pv
    join public.planeaciones p on p.id = pv.planeacion_id and p.docente_id = pv.docente_id and p.grupo_id = pv.grupo_id
    join public.grupos g on g.id = pv.grupo_id and g.docente_id = pv.docente_id
   where pv.id = p_version_id and pv.docente_id = p_docente_id
   for update of pv;
  if not found then
    return jsonb_build_object('resultado', 'rechazado');
  end if;
  v_existente := case p_formato when 'word' then v.documento_word_archivo_id else v.documento_pdf_archivo_id end;
  if v_existente is not null then
    update public.planeacion_version_archivos set estado = 'vinculado', archivo_id = v_existente, actualizado_en = now()
     where version_id = p_version_id and formato = p_formato;
    return jsonb_build_object('resultado', 'existente', 'archivo_id', v_existente);
  end if;

  -- Procedencia exacta: el archivo declara desde su registro ESTA versión,
  -- ESTE formato y ESTA ejecución (la de la reserva vigente).
  select * into a from public.archivos_generados where id = p_archivo_id for update;
  if not found
     or a.version_id is distinct from p_version_id
     or a.version_formato is distinct from p_formato
     or a.version_ejecucion_id is distinct from r.ejecucion_id
     or a.docente_id <> p_docente_id
     or a.estado <> 'activo'
     or a.clase <> 'conservar'
     or a.bucket <> 'documentos-generados-ia'
     or split_part(a.ruta, '/', 1) <> p_docente_id::text
     or a.tipo_mime <> (case p_formato when 'word' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' else 'application/pdf' end)
     or exists (select 1 from public.planeacion_versiones x where x.documento_word_archivo_id = a.id or x.documento_pdf_archivo_id = a.id) then
    return jsonb_build_object('resultado', 'archivo_invalido');
  end if;

  if p_formato = 'word' then
    update public.planeacion_versiones set documento_word_archivo_id = a.id where id = v.id and documento_word_archivo_id is null;
  else
    update public.planeacion_versiones set documento_pdf_archivo_id = a.id where id = v.id and documento_pdf_archivo_id is null;
  end if;
  update public.planeacion_version_archivos
     set estado = 'vinculado', archivo_id = a.id, error = null, actualizado_en = now()
   where version_id = p_version_id and formato = p_formato;
  return jsonb_build_object('resultado', 'vinculado', 'archivo_id', a.id);
end;
$$;

-- ------------------------------------------------------------
-- fallar_archivo_version: la misma ejecución marca su reserva como fallida
-- (se puede volver a intentar después sin aprobar de nuevo).
-- ------------------------------------------------------------
create or replace function public.fallar_archivo_version(
  p_docente_id uuid,
  p_version_id uuid,
  p_formato text,
  p_ejecucion_id uuid,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.planeacion_version_archivos
     set estado = 'fallido', error = left(p_error, 500), actualizado_en = now()
   where version_id = p_version_id and formato = p_formato and docente_id = p_docente_id
     and estado = 'generando' and ejecucion_id = p_ejecucion_id;
  return jsonb_build_object('resultado', case when found then 'fallido' else 'rechazado' end);
end;
$$;

revoke all on function public._trg_archivos_generados_origen_inmutable() from public, anon, authenticated;
revoke all on function public.reservar_archivo_version(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.vincular_archivo_version(uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.fallar_archivo_version(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.reservar_archivo_version(uuid, uuid, text, integer) to service_role;
grant execute on function public.vincular_archivo_version(uuid, uuid, text, uuid, uuid) to service_role;
grant execute on function public.fallar_archivo_version(uuid, uuid, text, uuid, text) to service_role;

commit;
