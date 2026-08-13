-- PASO 1 (autorizado por separado) de "Corrección de datos de alumnos
-- desde el Chat IA" — ver auditoría/diseño previo. Esta migración
-- SOLO crea la tabla de trazabilidad; ningún flujo del Chat IA la usa
-- todavía (eso corresponde a pasos posteriores, no autorizados aún).
--
-- 100% ADITIVA: solo CREATE TABLE nueva (correcciones_alumno). No
-- modifica, no renombra ni borra ninguna columna de ninguna tabla
-- existente (alumnos, perfiles_docentes, conversaciones_chat,
-- mensajes_chat, perfil_alumno_notas, etc.) — cero riesgo para datos
-- reales ya guardados. NO se corrige ningún dato de ningún alumno con
-- esta migración.
--
-- Tipos verificados directamente contra el esquema real antes de
-- escribir esta migración (information_schema.columns):
--   alumnos.id              uuid
--   alumnos.docente_id      uuid   (columna real y directa — la MISMA
--                                   que ya usa la política RLS de
--                                   alumnos, "Docentes ven sus
--                                   alumnos": docente_id = auth.uid())
--   perfiles_docentes.id    uuid
--   conversaciones_chat.id  uuid
--   mensajes_chat.id        text   (corregido en 20260811185000 — nunca uuid)
--
-- ENDURECIMIENTO (esta versión, sobre la primera creada) — 4 cambios,
-- solo en este archivo, todavía sin aplicar a Supabase:
--   1. alumno_id: ON DELETE CASCADE → ON DELETE RESTRICT.
--   2. CHECK accion/correccion_original_id: ahora simétrico y exhaustivo.
--   3. INSERT: además de docente_id = auth.uid(), verifica con un EXISTS
--      real que ese alumno_id pertenezca de verdad a ese docente.
--   4. Columna nueva fuente_detalle jsonb, opcional.
--
-- APPEND-ONLY POR DISEÑO, no solo por convención: esta tabla NO tiene
-- política RLS de UPDATE ni de DELETE para el rol autenticado — sin
-- esas políticas, RLS deniega esas operaciones por completo para
-- cualquier docente, incluso si un bug futuro en la aplicación
-- intentara actualizarla o borrarla. La única forma de "corregir" un
-- error de trazabilidad es agregar una fila nueva, nunca tocar una
-- existente.
--
-- "Deshacer" (ver diseño previo, punto 10): una fila con
-- accion='deshacer' apunta, vía correccion_original_id, a la fila
-- 'correccion' que está revirtiendo — la original NUNCA se modifica
-- ni se borra, queda intacta como evidencia permanente de lo que
-- pasó. Restaurar el dato real en `alumnos` es responsabilidad de un
-- paso posterior (no de esta migración); esta tabla solo garantiza
-- que, cuando eso ocurra, quede un registro trazable y verificable.
--
-- alumno_id ON DELETE RESTRICT (nunca CASCADE): una tabla de
-- auditoría existe precisamente para sobrevivir a los eventos que
-- audita. Si algún día se intenta eliminar físicamente un alumno con
-- historial de correcciones, Postgres RECHAZA ese DELETE en vez de
-- borrar en silencio la auditoría junto con él — el error resultante
-- es una señal explícita de que hace falta decidir qué hacer con ese
-- historial primero, nunca un borrado accidental. No se toca la
-- tabla alumnos ni su lógica de baja lógica/eliminación existente.
--
-- Idempotente: create table/index if not exists, drop policy if
-- exists antes de cada create policy — puede reejecutarse sin fallar
-- y sin destruir datos ya insertados.

create table if not exists public.correcciones_alumno (
  id uuid primary key default gen_random_uuid(),

  alumno_id uuid not null references public.alumnos(id) on delete restrict,
  docente_id uuid not null references public.perfiles_docentes(id),

  -- Lista blanca explícita — mismo campo que ya usa
  -- consultar_dato_alumno (campo_alumno_solicitado en
  -- lib/clasificadorNivel0.ts). Ampliar esta lista requiere una
  -- migración nueva a propósito: nunca un campo arbitrario. Por ahora
  -- solo los 3 campos ya probados en el flujo de solo lectura —
  -- calificaciones/asistencia/etc. se agregan después, cuando el
  -- flujo individual esté probado.
  campo text not null check (campo in ('curp', 'sexo', 'fecha_nacimiento')),

  -- jsonb (no text plano) para conservar con fidelidad texto, número,
  -- fecha o null sin perder el tipo original ni necesitar una columna
  -- distinta por tipo de dato — mismo criterio ya usado en este
  -- proyecto para datos flexibles (ver mensajes_chat.contenido). Un
  -- valor ausente/desconocido se guarda como el escalar JSON null,
  -- distinguible de "columna NULL" si hiciera falta en el futuro.
  valor_anterior jsonb,
  valor_nuevo jsonb,

  -- De dónde vino la corrección — nunca inferido, siempre el canal
  -- real por el que llegó el valor nuevo.
  fuente text not null check (fuente in ('documento', 'imagen', 'texto', 'voz', 'manual')),

  -- Detalle técnico OPCIONAL del origen — nombre de archivo, tipo de
  -- documento, id interno del recurso, confianza de lectura, página,
  -- o cualquier otra referencia técnica útil (ver ejemplo en el
  -- diseño: {"archivo": "LISTA_OFICIAL_DE_ALUMNOS.docx", "confianza":
  -- "alta"}). Sin CHECK de forma a propósito — es flexible por
  -- diseño, y nunca obligatorio: una corrección que vino directo del
  -- texto o la voz del docente (fuente='texto'|'voz') normalmente no
  -- tiene nada que poner aquí y simplemente lo deja NULL.
  fuente_detalle jsonb,

  -- Referencias a la conversación/mensaje de origen, cuando existan.
  -- ON DELETE SET NULL a propósito (nunca CASCADE): si la
  -- conversación o el mensaje de origen se borran después (ver
  -- eliminarConversacionRemota), el registro de auditoría de que el
  -- dato SÍ se corrigió debe sobrevivir — solo se pierde el enlace a
  -- dónde se conversó, nunca el hecho de la corrección en sí.
  conversacion_id uuid references public.conversaciones_chat(id) on delete set null,
  mensaje_id text references public.mensajes_chat(id) on delete set null,

  accion text not null check (accion in ('correccion', 'deshacer')),

  -- Autorreferencia: apunta, SOLO cuando accion='deshacer', a la fila
  -- 'correccion' original que se está revirtiendo. Nunca se borra ni
  -- se actualiza la fila referenciada (ver nota de append-only
  -- arriba).
  correccion_original_id uuid references public.correcciones_alumno(id),

  -- Regla exhaustiva y simétrica, sin combinaciones ambiguas
  -- posibles: 'correccion' EXIGE que este campo sea NULL (una
  -- corrección nunca "deshace" nada); 'deshacer' EXIGE que no lo sea
  -- (un deshacer siempre debe señalar exactamente qué está
  -- revirtiendo). Como 'accion' ya está restringido por el CHECK de
  -- arriba a solo estos dos valores, este CHECK cubre el 100% de los
  -- casos posibles.
  check (
    (accion = 'correccion' and correccion_original_id is null)
    or
    (accion = 'deshacer' and correccion_original_id is not null)
  ),

  creado_en timestamptz not null default now()
);

-- Índices — solo los necesarios para los patrones de consulta reales
-- ya previstos en el diseño: historial de un docente (mismo patrón
-- que ya usa trabajos_documento), última corrección de un
-- alumno+campo (para "deshaz la última corrección de Dylan"), y
-- localizar si una corrección específica ya fue deshecha.
create index if not exists correcciones_alumno_docente_idx
  on public.correcciones_alumno (docente_id, creado_en desc);
create index if not exists correcciones_alumno_alumno_campo_idx
  on public.correcciones_alumno (alumno_id, campo, creado_en desc);
create index if not exists correcciones_alumno_original_idx
  on public.correcciones_alumno (correccion_original_id)
  where correccion_original_id is not null;

alter table public.correcciones_alumno enable row level security;

-- Solo SELECT e INSERT — deliberadamente SIN política de UPDATE ni de
-- DELETE (ver nota de append-only arriba): un cliente autenticado
-- normal no tiene absolutamente ningún camino de RLS para modificar
-- ni eliminar un registro histórico ya insertado, sin importar qué
-- intente enviar la aplicación.
drop policy if exists "correcciones_alumno_select_propio" on public.correcciones_alumno;
create policy "correcciones_alumno_select_propio" on public.correcciones_alumno
  for select using (docente_id = auth.uid());

-- INSERT — doble verificación, no solo docente_id = auth.uid():
-- además exige, con un EXISTS real contra la tabla alumnos (la MISMA
-- relación directa alumno→docente que ya usa la política RLS propia
-- de alumnos), que el alumno_id de la fila realmente pertenezca a ese
-- docente. Cierra por completo la posibilidad de que un docente
-- registre trazabilidad para un alumno de otro docente aunque conozca
-- su UUID exacto — antes de este endurecimiento, docente_id=auth.uid()
-- solo, por sí solo, no lo impedía (un docente podía escribir
-- cualquier alumno_id ajeno junto con su propio docente_id real).
drop policy if exists "correcciones_alumno_insert_propio" on public.correcciones_alumno;
create policy "correcciones_alumno_insert_propio" on public.correcciones_alumno
  for insert with check (
    docente_id = auth.uid()
    and exists (
      select 1 from public.alumnos a
      where a.id = alumno_id and a.docente_id = auth.uid()
    )
  );

-- Rollback documentado (nunca ejecutado automáticamente — esto SÍ es
-- destructivo, no confundir con volver a correr esta migración, que
-- no lo es):
--   begin;
--   drop table if exists public.correcciones_alumno;
--   commit;
