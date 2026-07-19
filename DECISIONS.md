# Decisiones arquitectónicas — Docente IA

> Registro de decisiones importantes identificadas en el código y en las reglas del proyecto (`CLAUDE.md`), con su motivo y el impacto de modificarlas. Actualizar este archivo cuando se tome una decisión nueva o se revierta una existente.

## 1. Móvil primero, un módulo/tarea a la vez

**Decisión:** la app se diseña móvil-primero; el desarrollo avanza un módulo y una tarea pequeña a la vez, deteniéndose después de cada tarea para esperar confirmación.

**Motivo:** evitar cambios simultáneos que generen regresiones difíciles de rastrear y mantener la app usable en el dispositivo principal del docente (el celular).

**No modificar sin revisar impacto:** el orden de prioridad de sprints (actualmente Lista) y el criterio de "una tarea a la vez" — no combinar tareas de distintos módulos en un mismo cambio.

## 2. Lista como centro del seguimiento grupal e individual

**Decisión:** toda la información de asistencia, incidencias, evidencias, evaluaciones, participaciones e historial se concentra dentro del módulo **Lista**. No existe (ni debe crearse) un módulo "Seguimiento" separado.

**Motivo:** evitar capturar el mismo dato en dos lugares y evitar que el docente tenga que navegar entre módulos duplicados para ver la misma información de un alumno.

**No modificar sin revisar impacto:** no reintroducir una pantalla de "Seguimiento" independiente con funcionalidad propia. El stub `/dashboard/seguimiento` existe solo como remanente visual y debe tratarse como pendiente de retirar/redirigir, no como base para nueva funcionalidad.

## 3. Un registro se captura una sola vez y se reutiliza en todos lados

**Decisión:** cualquier dato registrado (asistencia, datos del alumno, incidencia, etc.) debe alimentar automáticamente ficha individual, seguimiento grupal, historial, estadísticas y análisis de IA, sin captura repetida.

**Motivo:** ahorrar tiempo al docente, que es el objetivo central del producto.

**No modificar sin revisar impacto:** cualquier nueva fuente de datos debe integrarse a las tablas/flujos existentes (`alumnos`, `asistencias`, `incidencias`, etc.) en vez de crear una tabla o pantalla paralela. Antes de agregar una tabla nueva, revisar si el dato ya cabe en una tabla existente.

## 4. Supabase como única fuente de persistencia, con RLS

**Decisión:** todo el estado de la aplicación vive en Supabase (Postgres + Auth + Storage). Las rutas de API que necesitan operar "como el usuario" (para que `auth.uid()` funcione dentro de RLS/RPC `SECURITY DEFINER`) crean un cliente Supabase por-request usando el `access_token` de la sesión, en vez de usar el cliente singleton o la service role key.

**Motivo:** las políticas de RLS de Supabase dependen de `auth.uid()`; usar la service role key o el cliente anónimo sin token rompería el aislamiento de datos entre docentes.

**No modificar sin revisar impacto:**
- No reemplazar el patrón de pasar `access_token` en el body/form-data de las rutas API por el cliente singleton (`lib/supabaseClient.ts`) cuando la ruta escribe datos sensibles a un usuario específico (asistencia, alumnos, datos de perfil).
- `SUPABASE_SERVICE_ROLE_KEY` solo se usa hoy para RAG (`buscar_chunks_similares`, `procesos_activos`) y subida de documentos institucionales — no se debe extender su uso a operaciones que dependan de la identidad del docente.
- El esquema de base de datos (tablas, RPCs, políticas RLS) **no está versionado en este repo**. Cualquier cambio de esquema se hace directamente en Supabase; antes de asumir que una tabla/columna/RPC existe, verificar contra el proyecto real, no solo contra el código.

## 5. Doble motor de IA: Claude para razonamiento/generación, OpenAI para visión/embeddings

**Decisión:** Anthropic Claude (`claude-sonnet-4-6`) se usa para el Chat IA, el Clasificador de Nivel 0 y la lectura de listas oficiales en `/api/importar-alumnos`. OpenAI (`gpt-4o-mini` + `text-embedding-3-small`) se usa para OCR de fotos en los flujos de asistencia (`/api/asistencia-foto`, `/api/importar-datos-alumnos`, `/api/ocr-foto`) y para embeddings de RAG.

**Motivo:** decisión de producto/costo tomada en etapas distintas del desarrollo (visible en el historial de commits); no hay evidencia en el código de que sea intercambiable sin pruebas.

**No modificar sin revisar impacto:** no unificar ambos proveedores sin antes validar calidad de OCR y costo — son flujos ya probados en producción con formatos de prompt específicos por proveedor.

## 6. Clasificador de Nivel 0 como enrutador antes de la llamada grande a Claude

**Decisión:** antes de generar una respuesta completa con Claude, `/api/chat` clasifica el mensaje del docente (`lib/clasificadorNivel0.ts`) para decidir si puede resolverse con una consulta directa a Postgres (Nivel 1: `consultar_asistencia`), si necesita contexto real inyectado (Nivel 4: `ficha_descriptiva`, `planeacion_nueva`), o si es conversación general (Nivel 3, fallback seguro).

**Motivo:** evitar que la IA "invente" datos de asistencia o del alumno, y evitar el costo/latencia de una llamada grande cuando el dato ya existe en la base de datos.

**No modificar sin revisar impacto:** el fallback ante error o baja confianza siempre debe ser `conversacion_general` (comportamiento actual sin cambios) — no reemplazar el fallback por una ejecución automática de una acción de Nivel 1/4 sin confirmación del docente.

## 7. Alias de imports `@/*` apunta a la raíz del proyecto, no a `app/`

**Decisión (implícita en `tsconfig.json`):** `"@/*": ["./*"]`, por lo que `@/utils/generarWord` resuelve a `utils/generarWord.ts` en la raíz, y **no** a `app/utils/generarWord.ts`.

**Motivo:** configuración heredada del scaffold inicial de Next.js; no documentada explícitamente en ningún commit.

**No modificar sin revisar impacto:** cambiar este alias afectaría silenciosamente qué archivo resuelve cada import `@/...` en todo el proyecto. Si se decide limpiar el duplicado `app/utils/generarWord.ts` (ver `PROJECT_MAP.md`), hacerlo eliminando el archivo huérfano, no cambiando el alias.

## 8. Sin capa de componentes compartidos (por ahora)

**Decisión (de facto, no documentada explícitamente):** cada pantalla es un `page.tsx` autocontenido; no existen carpetas `components/` ni `hooks/`.

**Motivo:** aparente prioridad de velocidad de entrega sobre reutilización en las primeras etapas del proyecto.

**No modificar sin revisar impacto:** si se decide introducir una capa de componentes compartidos, debe hacerse como una tarea explícita y acotada (regla del proyecto: no refactorizar como efecto secundario de otra tarea), no mezclada con una tarea funcional de un módulo.

## 9. Conservar el estilo visual existente

**Decisión:** no cambiar el estilo visual (Tailwind, paleta, iconografía emoji) salvo que la tarea lo pida explícitamente.

**Motivo:** consistencia de marca y evitar retrabajo de diseño no solicitado.

**No modificar sin revisar impacto:** cambios de estilo global (colores, tipografía, layout base en `globals.css`/`layout.tsx`) requieren instrucción explícita, no se infieren de una tarea funcional.

## 10. Principios arquitectónicos del CORE (declaración permanente)

**Decisión:** los siguientes diez principios rigen el diseño del núcleo de datos (CORE) de Docente IA y son permanentes — cualquier módulo, tabla o función nueva debe poder justificarse contra ellos:

1. El alumno es una entidad permanente y única — no se duplica ni se recrea al cambiar de grupo, grado o ciclo escolar.
2. La inscripción vincula alumno + grupo + ciclo escolar — es la única relación válida entre un alumno y un grupo (ver Decisión 11).
3. Ningún dato deberá capturarse dos veces (reafirma y generaliza la Decisión 3 ya existente).
4. Todo dato registrado deberá poder reutilizarse por cualquier módulo autorizado del sistema, sin recapturarlo ni duplicarlo en una tabla paralela.
5. La IA nunca almacenará información inventada; únicamente trabajará con datos reales ya registrados, o con contenido que ella misma genere y que el docente confirme explícitamente antes de tratarse como un hecho (mecanismo ya presente a nivel de esquema en `perfil_alumno_notas.estado`, aunque su flujo de escritura/confirmación todavía no está construido).
6. Toda función nueva deberá integrarse al CORE (las tablas y relaciones ya definidas) y no crear fuentes paralelas de información.
7. La Lista Inteligente es el punto principal de trabajo diario del docente (reafirma la Decisión 2 ya existente).
8. La Ficha Inteligente es el expediente único del alumno — toda la información capturada sobre un alumno debe ser visible ahí, sin importar en qué pantalla se haya capturado.
9. El Historial se genera automáticamente a partir de los registros existentes (asistencias, incidencias, evaluaciones, evidencias, notas confirmadas) — nunca como una tabla capturada de forma independiente (ya construido así hoy en `/dashboard/lista/[alumnoId]`).
10. La arquitectura debe estar preparada para soportar múltiples escuelas, miles de docentes y millones de alumnos sin modificar el modelo central — toda decisión de esquema (como la Decisión 11) se evalúa contra este criterio de escala antes de aprobarse.

**Motivo:** consolidar en un solo lugar los principios de producto y de datos definidos explícitamente por el responsable del proyecto, para que sirvan de criterio de aceptación de cualquier función nueva, no solo de las ya construidas.

**No modificar sin revisar impacto:** ningún módulo nuevo (Planeación, Reportes, Recursos, o los que sigan) debe aprobarse para desarrollo si contradice alguno de estos diez principios. Ante conflicto entre velocidad de entrega y alguno de estos principios, se detiene el desarrollo y se documenta la decisión antes de continuar (mismo criterio que ya rige en `CLAUDE.md`).

## 11. Alumno como entidad permanente; relación con Grupo vía Inscripción por ciclo escolar

**Decisión:** el alumno (`alumnos`) es una entidad permanente e independiente de cualquier grupo o ciclo escolar. Su relación con un grupo se representa exclusivamente mediante una **inscripción** (`inscripciones`), nunca mediante una FK directa en `alumnos`.

Cada inscripción representa: alumno, grupo, ciclo escolar, número de lista (propio de esa inscripción, no del alumno), fecha de alta, y estado (`activo` / `inactivo`).

Historial académico, asistencia, incidencias, evaluaciones, evidencias, necesidades de apoyo y fichas descriptivas se conservan ligados al **alumno** (vía `alumno_id`, como hoy) y además quedan **contextualizados por su inscripción** (vía una nueva columna `inscripcion_id`, que trae implícitos grupo y ciclo escolar) — así un mismo alumno conserva un solo expediente a lo largo de toda su vida escolar, y cada evento queda ubicado sin ambigüedad en el grupo/ciclo en que ocurrió.

**Motivo:** hoy conviven dos fuentes de verdad distintas para "¿en qué grupo está este alumno?": `alumnos.grupo_id` (FK directa, sin historia, usada por Lista/Ficha/importaciones) e `inscripciones` (usada solo por el Chat IA vía `lib/sesionContexto.ts`). Esta ambigüedad puede desincronizar al Chat IA del resto de la app y no permite conservar historial cuando un alumno cambia de grupo o repite ciclo.

**No modificar sin revisar impacto:**
- `alumnos.grupo_id`, `alumnos.numero_lista` y `alumnos.docente_id` quedan marcados como **campos legado** — no deben usarse como fuente de verdad en código nuevo; se conservan sin tocar hasta que se autorice una migración explícita.
- Toda tabla de evento nueva o existente que registre algo sobre un alumno en un momento dado (`incidencias`, `evaluaciones`, `evidencias`, `necesidades_apoyo`, `fichas_descriptivas`, y ya `asistencias`) debe incorporar `inscripcion_id` además de `alumno_id` cuando se implemente su alta.
- El campo de estado de la inscripción se llama `estado` (valores `activo`/`inactivo`), por instrucción explícita del responsable del proyecto — al implementar, reconciliar con la columna `estatus` ya usada hoy en `inscripciones`/`lib/sesionContexto.ts`.
- Regla de integridad recomendada para la implementación futura: un alumno solo puede tener una inscripción con `estado = 'activo'` por `ciclo_escolar_id`.
- Esta decisión no se ejecuta hasta que se autorice explícitamente tocar Supabase (crear/alterar tablas, migrar datos existentes de `alumnos.grupo_id` hacia `inscripciones`). No se generan migraciones en este paso.
