-- Seguridad — cerrar la autovinculación indebida a grupos ajenos
-- mediante `docente_grupos` (ver auditoría aprobada "Seguridad de
-- docente_grupos").
--
-- CAUSA RAÍZ — dos vías independientes:
--   1. Directa: la policy INSERT `docente_grupos_insert_propio` solo
--      exigía `docente_id = auth.uid()`. Cualquier docente autenticado
--      que conociera el UUID de un grupo ajeno podía insertarse como
--      'titular' (o 'apoyo', o con un `compartido_por` falso). Esa fila
--      habilita 10 policies RLS (asistencia_registro, inscripciones,
--      perfil_alumno_*, perfil_grupo_*) y 7 funciones SECURITY DEFINER
--      (contexto_*, asistencia, actualizar_datos_alumno, compartir_*).
--   2. Indirecta: `compartir_grupo_con_docente` (SECURITY DEFINER, sin
--      search_path, EXECUTE para PUBLIC/anon/authenticated) autoriza
--      solo con `docente_instituciones.rol in ('director',
--      'admin_institucional')`, y la policy ALL de
--      `docente_instituciones` permite a cualquier docente
--      autodeclararse 'director' de cualquier institución. Esa función
--      se salta RLS, así que endurecer solo la policy (vía 1) no la
--      cierra.
--
-- POR QUÉ EXISTE LA POLICY INSERT: `trg_sync_docente_grupo` (AFTER
-- INSERT OR UPDATE OF docente_id ON grupos, FOR EACH ROW) ejecuta
-- `fn_sync_docente_grupo()`, que es SECURITY INVOKER: inserta
-- (new.docente_id, new.id, 'titular') ON CONFLICT DO NOTHING con la
-- sesión del docente que crea el grupo, y por tanto debe pasar esta
-- policy. La nueva condición acepta EXACTAMENTE ese caso: al ser un
-- trigger AFTER, la fila nueva de `grupos` ya es visible dentro de la
-- misma transacción, y la subconsulta (sujeta a la RLS de `grupos`,
-- docente_id = auth.uid()) la encuentra.
--
-- QUÉ HACE ESTA MIGRACIÓN (atómica: BEGIN … COMMIT):
--   a. Precondición: aborta sin cambiar nada si existe alguna fila de
--      `docente_grupos` que no sea 'titular' del propietario actual con
--      compartido_por NULL (hoy: 0 filas así; las 2 existentes son
--      legítimas). Verifica también que la policy y la función
--      existan.
--   b. ALTER POLICY docente_grupos_insert_propio: el autoservicio solo
--      permite al docente vincularse como 'titular' de un grupo que le
--      pertenece AHORA (grupos.docente_id = auth.uid()), sin
--      compartido_por.
--   c. REVOKE EXECUTE de compartir_grupo_con_docente para PUBLIC, anon
--      y authenticated. postgres (propietario) y service_role conservan
--      su EXECUTE: quedan como vía administrativa legítima. No se
--      vuelve a habilitar compartir grupos para clientes hasta que
--      exista un modelo verificable de roles institucionales.
--
-- QUÉ NO HACE: no inserta, actualiza ni borra ninguna fila; no toca
-- fn_sync_docente_grupo, el trigger, las 10 policies consumidoras, las
-- demás funciones, docente_instituciones, perfiles_docentes, alumnos ni
-- inscripciones. Las filas existentes se conservan tal cual (la policy
-- solo actúa sobre INSERT futuros).
--
-- COMPATIBILIDAD:
--   - Crear un grupo desde la app (app/dashboard/grupos/nuevo) sigue
--     funcionando: el trigger inserta el titular del propio grupo.
--   - Varios grupos por docente: cada grupo propio crea su fila.
--   - Cambio de titular por un administrador (service_role/postgres,
--     ambos BYPASSRLS): el trigger no pasa por esta policy.
--   - compartirGrupoConDocente (lib/motorContexto.ts) no tiene ningún
--     llamador; tras esta migración recibe "permission denied".
--
-- RIESGO RESIDUAL CONOCIDO (fase posterior): cuando un administrador
-- cambia grupos.docente_id, fn_sync agrega el titular nuevo pero no
-- retira la fila del propietario anterior, que conserva acceso vía las
-- policies consumidoras. No es explotable desde un cliente.
--
-- ROLLBACK (si hiciera falta):
--   alter policy docente_grupos_insert_propio on public.docente_grupos
--     with check (docente_id = auth.uid());
--   grant execute on function public.compartir_grupo_con_docente(uuid, uuid, text)
--     to public, anon, authenticated;

begin;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'docente_grupos'
      and p.policyname = 'docente_grupos_insert_propio'
      and p.cmd = 'INSERT'
  ) then
    raise exception 'PRECONDICION_FALLIDA: no existe la policy INSERT docente_grupos_insert_propio.';
  end if;

  if to_regprocedure('public.compartir_grupo_con_docente(uuid, uuid, text)') is null then
    raise exception 'PRECONDICION_FALLIDA: no existe public.compartir_grupo_con_docente(uuid, uuid, text).';
  end if;

  if exists (
    select 1
    from public.docente_grupos dg
    left join public.grupos g on g.id = dg.grupo_id
    where g.id is null
       or dg.docente_id <> g.docente_id
       or dg.rol <> 'titular'
       or dg.compartido_por is not null
  ) then
    raise exception 'PRECONDICION_FALLIDA: docente_grupos contiene filas que no son el titular actual de su grupo; revisar antes de endurecer.';
  end if;
end;
$$;

alter policy docente_grupos_insert_propio on public.docente_grupos
  with check (
    docente_id = auth.uid()
    and rol = 'titular'
    and compartido_por is null
    and exists (
      select 1
      from public.grupos g
      where g.id = docente_grupos.grupo_id
        and g.docente_id = auth.uid()
    )
  );

revoke execute on function public.compartir_grupo_con_docente(uuid, uuid, text) from public;
revoke execute on function public.compartir_grupo_con_docente(uuid, uuid, text) from anon;
revoke execute on function public.compartir_grupo_con_docente(uuid, uuid, text) from authenticated;

commit;
