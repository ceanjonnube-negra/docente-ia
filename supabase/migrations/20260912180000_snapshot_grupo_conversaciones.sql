-- MG-B1 — snapshot estable del grupo autorizado por conversación.
--
-- Objetivo (ver diseño aprobado "MG-B — snapshot de grupo por
-- conversación" y la auditoría final de trust boundary): que cada
-- conversación del Chat IA quede vinculada, de forma permanente e
-- inmutable, al grupo real que estaba autorizado en el momento en que
-- se creó — sin depender de qué grupo esté "activo" globalmente en
-- turnos futuros, y sin que un cliente autenticado pueda falsificar
-- ese vínculo hacia otro grupo (propio o ajeno).
--
-- Esta migración NO se aplica todavía — se crea únicamente para
-- revisión (fase MG-B1). NO modifica app/api/chat/route.ts ni
-- persistencia.ts: eso corresponde a una fase posterior (MG-B2), una
-- vez aprobado este esquema.
--
-- ADITIVA sobre el esquema de conversaciones_chat: agrega 2 columnas
-- nullable y una función nueva; no modifica ni elimina ninguna policy
-- RLS existente, no toca ninguna otra tabla, no reinterpreta ninguna
-- fila ya existente. SÍ modifica privilegios INSERT/UPDATE sobre
-- conversaciones_chat (sección 2) — no es aditiva en ese sentido, es
-- una restricción deliberada de superficie de escritura.
--
-- Fail-closed deliberado (no idempotente): ni el ADD COLUMN ni el
-- CREATE FUNCTION toleran preexistencia. Si alguna columna o la
-- función ya existieran por un drift de esquema no auditado, esta
-- migración debe FALLAR explícitamente en vez de continuar
-- silenciosamente sobre un estado no verificado.

-- ============================================================
-- 1. COLUMNAS — grupo_contexto_version PRIMERO, SIN DEFAULT.
-- ============================================================
--
-- Orden crítico (ver auditoría "validar semántica Postgres"): si se
-- agregara la columna YA con DEFAULT 1 en la misma sentencia,
-- PostgreSQL 11+ usa una optimización ("fast default") que hace que
-- las filas YA EXISTENTES lean ese valor por defecto como si siempre
-- lo hubieran tenido — es decir, TODAS las conversaciones anteriores a
-- esta migración aparecerían con version=1, exactamente el backfill
-- semántico accidental que este diseño existe para evitar. Separar en
-- dos sentencias (agregar sin default, y solo DESPUÉS fijar el
-- default) garantiza que las filas existentes queden genuinamente
-- NULL, y que el default 1 solo aplique a INSERTs futuros que omitan
-- la columna.
alter table public.conversaciones_chat
  add column grupo_contexto_version smallint null;

alter table public.conversaciones_chat
  alter column grupo_contexto_version set default 1;

-- grupo_id — nullable, FK hacia grupos(id). ON DELETE RESTRICT (no
-- CASCADE, no SET NULL): un grupo con conversaciones que lo referencian
-- no puede borrarse sin decidir explícitamente qué hacer con ellas —
-- preferible a que un snapshot ya fijado pueda volver a NULL de forma
-- silenciosa (ver auditoría: SET NULL crea una ambigüedad real entre
-- "nunca se intentó fijar" y "se fijó pero el grupo referenciado ya no
-- existe", que RESTRICT evita de raíz sin necesitar una columna de
-- estado adicional). Ningún flujo de este proyecto borra grupos hoy —
-- confirmado por búsqueda exhaustiva antes de esta migración — así
-- que este RESTRICT no introduce fricción real actual.
alter table public.conversaciones_chat
  add column grupo_id uuid null references public.grupos(id) on delete restrict;

-- Sin backfill: ambas columnas quedan NULL en toda fila existente.
-- Sin índice nuevo: ningún consumidor actual busca conversaciones POR
-- grupo_id (solo se lee el grupo_id de una conversación ya
-- identificada por su propio id) — agregar un índice sin caso de uso
-- real sería complejidad prematura.

-- ============================================================
-- 2. PROTEGER LAS COLUMNAS DE ESCRITURA DIRECTA DESDE `authenticated`.
-- ============================================================
--
-- Punto crítico de PostgreSQL (ver auditoría): si `authenticated` ya
-- tiene un GRANT UPDATE/INSERT a nivel de TABLA (el patrón habitual
-- que Supabase aplica por defecto a las tablas de `public`, y que no
-- aparece como sentencia explícita en ninguna migración rastreada de
-- este proyecto porque se concede por fuera del control de versiones),
-- entonces un REVOKE UPDATE (columna) / REVOKE INSERT (columna)
-- dirigido solo a esa columna específica NO tiene ningún efecto real:
-- el privilegio de tabla completo seguiría cubriendo esa columna de
-- todas formas. La única forma correcta de restringir columnas
-- específicas cuando el rol ya tiene el privilegio a nivel de tabla es
-- revocar el privilegio de TABLA por completo y volver a concederlo
-- explícitamente solo sobre las columnas legítimas. Esto es seguro
-- sin importar cómo se haya otorgado el privilegio original (GRANT
-- explícito o privilegios por defecto de Supabase): REVOKE siempre
-- opera sobre el estado real de privilegios de la tabla, no sobre su
-- origen.
--
-- Segundo punto crítico, distinto del anterior: en PostgreSQL, un rol
-- normal (como `authenticated`) hereda automáticamente cualquier
-- privilegio concedido al pseudo-rol PUBLIC — un REVOKE dirigido
-- únicamente a `authenticated` NUNCA elimina un privilegio que además
-- esté concedido a PUBLIC, porque la comprobación de acceso es la
-- UNIÓN de "concedido al rol" y "concedido a PUBLIC". Como el estado
-- histórico exacto de GRANTs de esta tabla no pudo verificarse contra
-- information_schema/pg_catalog en las auditorías anteriores (ese
-- esquema no está expuesto en este entorno), la migración revoca de
-- AMBOS — PUBLIC y authenticated — para quedar demostrablemente
-- cerrada sin importar cuál de los dos tuviera el privilegio
-- originalmente. Esto NO afecta al dueño de la tabla (ver la función
-- SECURITY DEFINER más abajo): un dueño nunca depende de lo que se
-- conceda o revoque a PUBLIC ni a ningún otro rol. No se concede nada
-- a `anon`.
--
-- Columnas verificadas contra el código real ANTES de escribir esto
-- (búsqueda exhaustiva de todo `.from('conversaciones_chat')` en el
-- proyecto): el ÚNICO UPDATE existente es actualizarConversacionRemota
-- (lib/asistente/persistencia.ts), que escribe exactamente
-- titulo / documento_activo / material_visual_activo / actualizado_en
-- — nunca ninguna otra columna. El ÚNICO INSERT existente es
-- crearConversacionRemota, que escribe exactamente id / docente_id.
--
-- Revocar todo (de PUBLIC y de authenticated), volver a conceder solo
-- las columnas legítimas ya usadas hoy a authenticated — grupo_id y
-- grupo_contexto_version quedan deliberadamente fuera de ambas listas.
revoke insert, update on table public.conversaciones_chat from public;
revoke insert, update on table public.conversaciones_chat from authenticated;

grant update (titulo, documento_activo, material_visual_activo, actualizado_en)
  on public.conversaciones_chat to authenticated;

-- INSERT: mismo criterio. El cliente sigue pudiendo hacer exactamente
-- el INSERT {id, docente_id} que ya hace hoy — PostgreSQL solo exige
-- privilegio de columna sobre las columnas que el INSERT menciona
-- explícitamente; las columnas omitidas (incluidas
-- grupo_contexto_version y grupo_id, con sus defaults 1/NULL) reciben
-- su valor por defecto sin necesitar ningún privilegio adicional sobre
-- ellas. Esto impide, a la vez, que un cliente intente fijar
-- explícitamente grupo_contexto_version o grupo_id en el propio
-- INSERT para evadir por completo el flujo de snapshot.
grant insert (id, docente_id)
  on public.conversaciones_chat to authenticated;

-- Nunca se toca SELECT ni DELETE: ninguna de las dos tiene privilegio
-- a nivel de columna en PostgreSQL (DELETE siempre es de fila
-- completa), y leer estas columnas no es sensible — la sensibilidad
-- está exclusivamente en poder ESCRIBIRLAS con un valor elegido por el
-- cliente. Ninguna policy RLS existente se modifica ni se elimina —
-- esta protección es una capa ortogonal y adicional, nunca un
-- reemplazo de conversaciones_chat_select_propio / _insert_propio /
-- _update_propio / _delete_propio, que siguen intactas.

-- ============================================================
-- 3. RPC SECURITY DEFINER — único camino posible para fijar grupo_id.
-- ============================================================
--
-- Nunca acepta grupo_id ni docente_id como parámetro — el cliente solo
-- puede pedir "fija correctamente el grupo de MI conversación", nunca
-- elegir cuál. auth.uid() identifica al llamador real; si es NULL
-- (llamada sin sesión), no hace nada. search_path fijo a cadena vacía
-- y toda referencia a tabla completamente calificada por esquema
-- (public./auth.) — hardening estándar recomendado para funciones
-- SECURITY DEFINER, evita que un rol malicioso intente secuestrar
-- referencias no calificadas creando objetos con el mismo nombre en
-- otro esquema de su propio search_path.
--
-- Dueño de la función: no se declara ningún OWNER TO explícito — hereda,
-- por comportamiento estándar de CREATE FUNCTION, el mismo rol que
-- ejecuta esta migración, que es el mismo rol dueño de conversaciones_chat
-- y del resto de las tablas del proyecto (ninguna migración rastreada
-- declara un OWNER distinto para ninguna tabla existente). Por eso
-- puede escribir grupo_id/grupo_contexto_version aunque `authenticated`
-- ya no pueda: el dueño de una tabla nunca está sujeto a los GRANT/
-- REVOKE dirigidos a OTROS roles — esa restricción es inherente al
-- modelo de privilegios de PostgreSQL, no depende de conocer el
-- nombre exacto del rol.
--
-- IMPORTANTE — la seguridad de esta función NO depende de que RLS la
-- proteja: por defecto, el dueño de una tabla omite sus propias
-- policies de RLS a menos que la tabla tenga FORCE ROW LEVEL SECURITY
-- (esta tabla no lo tiene). Por eso TODAS las comprobaciones de
-- ownership de abajo son explícitas dentro de la función misma,
-- nunca delegadas a RLS.
create function public.fijar_grupo_conversacion(p_conversacion_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_docente_id uuid;
  v_grupo_resuelto uuid;
  v_candidatos uuid[];
begin
  v_docente_id := auth.uid();
  if v_docente_id is null then
    return; -- fail-safe: sin identidad real del llamador, no se hace nada
  end if;

  -- Localiza y BLOQUEA la fila exigiendo, en la misma condición, TODO
  -- lo que hace válida la operación: que la conversación sea del
  -- llamador, que de verdad haya nacido bajo MG-B (version=1, nunca
  -- una legacy con version NULL), y que el snapshot no se haya fijado
  -- ya antes. `for update` toma un lock de fila — una segunda llamada
  -- concurrente sobre la MISMA conversación espera a que esta
  -- transacción termine y entonces ya no encuentra la fila (grupo_id
  -- dejó de ser null), terminando en no-op sin ninguna condición de
  -- carrera.
  perform 1
  from public.conversaciones_chat
  where id = p_conversacion_id
    and docente_id = v_docente_id
    and grupo_contexto_version = 1
    and grupo_id is null
  for update;

  if not found then
    return; -- no coincide: ya fijado, legacy, ajena, o inexistente — no-op seguro
  end if;

  -- PASO A — contexto persistido (docente_contexto_activo.grupo_id),
  -- revalidado por completo: debe existir, pertenecer al mismo
  -- docente, y su ciclo escolar debe estar activo. grupos.activo
  -- NUNCA se usa (ver auditoría "semántica real de grupos.activo" —
  -- sin ningún uso operativo demostrado en el proyecto).
  --
  -- NUNCA se usa LIMIT 1 para elegir arbitrariamente entre varias
  -- filas: no se pudo demostrar estructuralmente (sin acceso a
  -- information_schema/pg_catalog en las auditorías anteriores) que
  -- docente_contexto_activo tenga exactamente una fila por docente
  -- vía PK/UNIQUE. Por eso se trae hasta 2 IDs de grupo DISTINCT (una
  -- fila duplicada que apunte al MISMO grupo nunca cuenta como un
  -- segundo candidato) y solo se acepta el contexto persistido si el
  -- resultado es inequívoco:
  --   0 grupos distintos → cae al fallback de "exactamente un grupo" (PASO B)
  --   exactamente 1 grupo distinto → se usa ese grupo
  --   2 o más grupos distintos → contexto ambiguo, también cae al
  --     fallback (que por su propia naturaleza vuelve a exigir
  --     "exactamente un grupo autorizado" a nivel global — si de
  --     verdad hay más de un grupo posible, el fallback lo rechazará
  --     igual, sin elegir ninguno arbitrariamente).
  select array_agg(c.id) into v_candidatos
  from (
    select distinct g.id
    from public.docente_contexto_activo dca
    join public.grupos g on g.id = dca.grupo_id
    join public.ciclos_escolares ce on ce.id = g.ciclo_escolar_id
    where dca.docente_id = v_docente_id
      and g.docente_id = v_docente_id
      and ce.activo = true
    limit 2
  ) c;

  if array_length(v_candidatos, 1) = 1 then
    v_grupo_resuelto := v_candidatos[1];
  end if;

  -- PASO B — solo si el contexto persistido no resolvió nada: exigir
  -- EXACTAMENTE un grupo válido del docente en ciclo activo. Nunca
  -- "más reciente" (MG-B es una identidad histórica permanente, un
  -- error aquí no se autocorrige nunca) — se comprueba con un límite
  -- de 2 para detectar ambigüedad sin traer la lista completa: si el
  -- arreglo resultante tiene más de un elemento, hay ambigüedad real y
  -- deliberadamente NO se resuelve nada.
  if v_grupo_resuelto is null then
    select array_agg(c.id) into v_candidatos
    from (
      select g.id
      from public.grupos g
      join public.ciclos_escolares ce on ce.id = g.ciclo_escolar_id
      where g.docente_id = v_docente_id
        and ce.activo = true
      limit 2
    ) c;

    if array_length(v_candidatos, 1) = 1 then
      v_grupo_resuelto := v_candidatos[1];
    end if;
  end if;

  if v_grupo_resuelto is null then
    return; -- 0 candidatos, o 2+ ambiguos: nunca inferir, dejar sin snapshot
  end if;

  -- Escritura final, atómica y condicionada de nuevo (defensa en
  -- profundidad además del lock ya tomado arriba): jamás sobrescribe
  -- un grupo_id ya fijado, jamás toca una fila legacy o ajena.
  update public.conversaciones_chat
  set grupo_id = v_grupo_resuelto
  where id = p_conversacion_id
    and docente_id = v_docente_id
    and grupo_contexto_version = 1
    and grupo_id is null;
end;
$$;

-- PostgreSQL concede EXECUTE sobre funciones nuevas a PUBLIC por
-- defecto (a diferencia de las tablas) — revocarlo explícitamente y
-- conceder solo a `authenticated` evita que el rol `anon`
-- (sin sesión) pueda siquiera intentar invocarla, aunque el propio
-- guard de auth.uid() IS NULL ya la volvería inofensiva en ese caso.
revoke execute on function public.fijar_grupo_conversacion(uuid) from public;
grant execute on function public.fijar_grupo_conversacion(uuid) to authenticated;
