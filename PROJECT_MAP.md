# Mapa del proyecto — Docente IA

> Generado a partir de una exploración completa del repositorio (solo lectura). Refleja el estado del código al 2026-07-14, commit `74e0ea1`.

## 1. Arquitectura general

**Stack:** Next.js 16 (App Router) + React 19 + TypeScript + Tailwind v4. Móvil-primero.

**Backend as a service:** Supabase (Postgres + Auth + Storage + RPC). El esquema de base de datos **no está versionado** en el repo (no existe carpeta `supabase/` ni migraciones SQL) — vive únicamente en el proyecto remoto de Supabase.

**IA:**
- Anthropic Claude (`@anthropic-ai/sdk`, modelo `claude-sonnet-4-6`) — chat, clasificación de intención, generación de documentos, lectura de listas oficiales.
- OpenAI (`gpt-4o-mini` + `text-embedding-3-small`) — OCR/visión de fotos y embeddings para RAG de documentos institucionales.

No existen carpetas `components/` ni `hooks/`: cada pantalla es un `page.tsx` autocontenido con JSX inline, sin extracción de UI compartida.

Dos capas de acceso a datos conviven:
1. **Directa:** la mayoría de pantallas usan `lib/supabaseClient.ts` (anon key) para `select/insert/update` directo desde el navegador, protegido por RLS (definido fuera del repo).
2. **Motor de Contexto (`lib/motorContexto.ts`) + Clasificador Nivel 0 (`lib/clasificadorNivel0.ts`):** capa más nueva, usada solo por `/api/chat`. Clasifica la intención del mensaje con Claude y, si aplica, llama RPCs de Postgres pasando el token de sesión real del docente (para que `auth.uid()` funcione en RLS/SECURITY DEFINER).

## 2. Estructura de carpetas

```
app/
  api/
    asistencia-foto/route.ts
    asistencia-guardar/route.ts
    chat/route.ts
    importar-alumnos/route.ts
    importar-datos-alumnos/route.ts
    ocr-foto/route.ts                 ⚠️ huérfano, sin uso
    periodos-evaluacion/route.ts
    upload-documento/route.ts
  dashboard/
    page.tsx                         (home "rueda")
    asistencia/page.tsx
    calendario/page.tsx
    chat/page.tsx
    grupos/nuevo/page.tsx
    grupos/[id]/configuracion-inicial/page.tsx
    grupos/[id]/importar/page.tsx
    historial/page.tsx
    lista/page.tsx
    lista/[alumnoId]/page.tsx
    periodos-evaluacion/page.tsx
    planeacion/page.tsx              (stub "Próximamente")
    seguimiento/page.tsx             (stub "Próximamente")
  documentos/page.tsx
  login/page.tsx
  registro/page.tsx
  onboarding/page.tsx
  page.tsx                           (landing)
  utils/generarWord.ts               ⚠️ código muerto (ver sección 9)
  layout.tsx / globals.css
lib/
  supabaseClient.ts
  motorContexto.ts
  sesionContexto.ts
  clasificadorNivel0.ts
utils/
  generarWord.ts                     ← el que realmente se usa
public/                              assets estáticos
```

No hay carpetas `components/`, `hooks/`, ni `supabase/` (migraciones).

## 3. Pantallas existentes

| Ruta | Estado |
|---|---|
| `/` (landing) | Funcional |
| `/login`, `/registro`, `/onboarding` | Funcionales |
| `/dashboard` | Home tipo "rueda" (Planeación, Calendario, Seguimiento, Asistencia, Chat) |
| `/dashboard/chat` | Funcional; drawer de navegación propio que duplica parte del home |
| `/dashboard/asistencia` | Funcional — flujo legado de captura por foto |
| `/dashboard/lista` | Funcional — lista con filtros, conteos, importar datos por foto |
| `/dashboard/lista/[alumnoId]` | Funcional — Ficha Inteligente del Alumno con 9 pestañas: Resumen, Datos, Asistencia, Incidencias, Evaluaciones, Evidencias, Necesidades de apoyo, Fichas descriptivas, Historial (todas de lectura sobre datos reales; alta/edición solo existe hoy para Datos y Asistencia). Rediseño visual (dos pasadas) aplicado, sin commit todavía. |
| `/dashboard/periodos-evaluacion` | Funcional, agregada recientemente |
| `/dashboard/calendario` | Funcional |
| `/dashboard/historial` | Funcional (documentos generados) |
| `/dashboard/grupos/nuevo` | Funcional — alta de grupo (institución/ciclo/nivel/grado) |
| `/dashboard/grupos/[id]/configuracion-inicial` | Funcional, pero un botón enlaza a `alumnos/nuevo`, que **no existe** (ruta rota) |
| `/dashboard/grupos/[id]/importar` | Funcional — importar lista oficial (foto/Excel/PDF/Word) |
| `/documentos` | Funcional — subir documentos institucionales (RAG) |
| `/dashboard/planeacion` | Stub "Próximamente" |
| `/dashboard/seguimiento` | Stub "Próximamente" |

⚠️ **Ninguna pantalla de navegación (rueda de `/dashboard` ni drawer de `/dashboard/chat`) enlaza a `/dashboard/lista` ni a `/dashboard/periodos-evaluacion`.**

## 4. APIs (`app/api/*/route.ts`)

- `POST /api/chat` — orquesta Clasificador Nivel 0 + Motor de Contexto + RAG + streaming de Claude.
- `POST /api/asistencia-foto` — OCR (OpenAI) de foto de lista → upsert en `alumnos` (flujo legado, usado por `/dashboard/asistencia`).
- `POST /api/asistencia-guardar` — guarda asistencia del día (booleano `presente`) vía RLS con token de usuario.
- `POST /api/importar-alumnos` — analiza foto/Excel/PDF/Word con Claude → devuelve preview (no escribe DB); usado por `/dashboard/grupos/[id]/importar`.
- `POST /api/importar-datos-alumnos` — OCR de foto → *match* difuso por nombre → actualiza CURP/sexo/fecha de nacimiento/número de lista de alumnos existentes; usado por `/dashboard/lista`.
- `GET/PUT /api/periodos-evaluacion` — CRUD simple de fechas de periodo.
- `POST /api/upload-documento` — sube documento, extrae texto, genera chunks + embeddings (RAG).
- `POST /api/ocr-foto` — OCR genérico de texto en imagen. **No se llama desde ninguna pantalla.**

## 5. Flujo de datos

1. El docente se autentica (Supabase Auth) → `perfiles_docentes`.
2. Onboarding guarda `nombre/escuela/grado/grupo/estado/municipio` como texto plano en `perfiles_docentes` (modelo legado).
3. En paralelo existe un modelo relacional más nuevo: `grupos` (institución + ciclo escolar + nivel + grado + grupo), poblado por `/dashboard/grupos/nuevo`.
4. Los alumnos se asocian a un `grupo_id` (modelo nuevo) y también cargan `docente_id` directo (modelo legado, redundante).
5. Asistencia, incidencias e importaciones leen/escriben directo sobre `alumnos`/`asistencias`/`incidencias` con lógica booleana simple.
6. El Chat IA, en cambio, pasa por el Clasificador Nivel 0 y el Motor de Contexto, que asumen un modelo de asistencia más rico (`falta`/`retardo`/`justificada` vía RPC) que la UI de Asistencia real no expone.
7. Los documentos generados por el Chat se guardan en `documentos_generados` y se pueden exportar a Word (`utils/generarWord.ts`).
8. Los documentos institucionales (`/documentos`) se trocean y se embeben para búsqueda semántica (RAG) usada por `/api/chat`.

## 6. Supabase y tablas identificadas (inferidas por uso; no hay migraciones en el repo)

- `perfiles_docentes` (id, nombre, escuela, grado, grupo, estado, municipio, institucion_id, campo_formativo)
- `instituciones` (id, nombre)
- `docente_instituciones` (docente_id, institucion_id)
- `docente_contexto_activo` (docente_id, institucion_id, ciclo_escolar_id, grupo_id, actualizado_en)
- `ciclos_escolares` (id, nombre, institucion_id, activo, creado_en)
- `grupos` (id, nombre_grupo, institucion_id, docente_id, ciclo_escolar_id, nivel_educativo, grado, grupo, creado_en)
- `alumnos` (id, nombre, docente_id, grupo_id, institucion_id, numero_lista, curp, sexo, fecha_nacimiento) — **`grupo_id`, `numero_lista` y `docente_id` son campos legado según Decisión 11 de `DECISIONS.md` (Alumno permanente + Inscripción); no usar como fuente de verdad en código nuevo, sin migrar todavía.**
- `inscripciones` (hoy en uso: `alumno_id`, `grupo_id`, `estatus`) — **esquema objetivo según Decisión 11:** `alumno_id`, `grupo_id`, `ciclo_escolar_id`, `numero_lista`, `fecha_alta`, `estado` (`activo`/`inactivo`). Es la fuente de verdad decidida para alumno↔grupo; implementación pendiente de autorización (no se ha tocado Supabase).
- `asistencias` (alumno_id, fecha, presente, grupo_id)
- `incidencias` (id, alumno_id, fecha, tipo, descripcion, seguimiento)
- `evaluaciones` (id, alumno_id, campo_formativo, periodo, calificacion, rubrica, creado_en)
- `evidencias` (id, alumno_id, tipo, descripcion, archivo_url, creado_en)
- `necesidades_apoyo` (id, alumno_id, tipo, descripcion, activa, creado_en)
- `fichas_descriptivas` (id, alumno_id, periodo, contenido, creado_en)
- `perfil_alumno_notas` (id, alumno_id, tipo, contenido, fuente_modulo, estado, fecha) — pensada como memoria de IA no confirmada (`estado != 'pendiente_confirmar'` se filtra al leer en la Ficha); **no existe en el código ningún flujo que escriba en esta tabla ni UI de confirmación** — es un mecanismo a medio construir.
- `periodos_evaluacion` (id, numero_periodo, nombre, fecha_inicio, fecha_fin) — no vinculada todavía a `evaluaciones`.
- `documentos_generados` (id, user_id, tipo, titulo, contenido, campo_formativo, grado, grupo, created_at)
- `documentos_institucionales` (id, nombre_archivo, tipo, contenido_texto, categoria, descripcion, institucion_id, estado, tamano_bytes, hash_archivo, storage_path, version, num_embeddings)
- `documento_chunks` (documento_id, chunk_index, chunk_texto, embedding)
- `procesos_activos` (id, user_id, tipo_proceso, contexto, estado, updated_at)
- `calendario_eventos` (id, user_id, titulo, fecha, tipo, color, descripcion, es_sep)

> Nota: en tablas de evento (`incidencias`, `evaluaciones`, `evidencias`, `necesidades_apoyo`, `fichas_descriptivas`) la Decisión 11 de `DECISIONS.md` define agregar `inscripcion_id` a cada una cuando se implemente, para contextualizarlas por grupo/ciclo sin perder su vínculo directo con `alumno_id`.

**RPCs (Postgres, llamadas desde `lib/motorContexto.ts`):**
`contexto_alumno`, `contexto_grupo`, `contexto_docente`, `registrar_asistencia_masiva`, `consultar_asistencia_alumno`, `actualizar_datos_alumno`, `compartir_grupo_con_docente`, `buscar_chunks_similares`.

## 7. Componentes y utilidades

- No hay componentes UI compartidos; cada pantalla repite header, tarjetas de estadísticas, inputs y llamadas a `supabase.auth.getUser()/getSession()`.
- Única utilidad reutilizada de verdad: `utils/generarWord.ts` (generación de documento Word), usada por `dashboard/chat` y `dashboard/historial`.
- `lib/motorContexto.ts`, `lib/sesionContexto.ts`, `lib/clasificadorNivel0.ts` son la única capa de lógica de negocio compartida, y solo la consume `/api/chat`.

## 8. Duplicidades

1. **Tres flujos distintos para "leer alumnos desde foto/archivo"**, cada uno con lógica de emparejamiento diferente: `/api/asistencia-foto` (upsert por nombre+docente_id), `/api/importar-datos-alumnos` (match difuso + actualización de campos), `/api/importar-alumnos` (preview + insert desde cliente).
2. **Dos "home" de navegación**: la rueda de `/dashboard` y el drawer lateral de `/dashboard/chat`, con listados de accesos parcialmente distintos y ninguno enlaza a Lista ni Periodos de evaluación.
3. **Dos modelos de "grupo"**: el legado (`perfiles_docentes.grado/grupo` como texto plano, usado por Chat/Word) y el relacional nuevo (`grupos`, `instituciones`, `ciclos_escolares`, usado por Lista/Importar). No parece haber una migración completa de uno a otro.
4. **`alumnos.docente_id` redundante** con `grupos.docente_id` (ya que `alumnos.grupo_id` apunta a `grupos`) — vestigio del flujo legado de asistencia.
5. **Alumno↔Grupo con dos fuentes de verdad**: `alumnos.grupo_id` (FK directa, la usa toda la app real) vs `inscripciones` (la usa solo `lib/sesionContexto.ts` para el Chat IA). **Resuelto a nivel de decisión** en `DECISIONS.md` (Decisión 11: Alumno permanente + Inscripción por ciclo escolar) — implementación todavía pendiente de autorización.

## 9. Código muerto

- **`app/utils/generarWord.ts`**: implementación distinta y completa del generador de Word, pero **nunca se importa**. El alias `@/*` (definido en `tsconfig.json`) apunta a la raíz del proyecto, así que `@/utils/generarWord` siempre resuelve a `utils/generarWord.ts` (raíz), no a `app/utils/generarWord.ts`.
- **`app/api/ocr-foto/route.ts`**: endpoint funcional pero no se llama desde ninguna pantalla del proyecto.
- **Enlace roto**: el botón "Capturar alumnos manualmente" en `/dashboard/grupos/[id]/configuracion-inicial` apunta a `/dashboard/grupos/[id]/alumnos/nuevo`, ruta que no existe.

## 10. Riesgos

- **Esquema de base de datos no versionado**: cualquier cambio hecho directamente en Supabase no queda documentado ni es reproducible desde git; riesgo de "verdad" viviendo solo en la nube.
- **Lista (el módulo prioritario del Sprint 1 según las reglas del proyecto) no es alcanzable desde ninguna navegación principal** — solo por URL directa o enlace profundo.
- **Inconsistencia de modelo de asistencia**: el Motor de Contexto/RPC asume `falta/retardo/justificada`, pero la UI real de Asistencia solo maneja `presente: boolean`, por lo que las respuestas del Chat IA sobre retardos/justificantes pueden no reflejar datos reales.
- **Ficha individual de alumno no filtra por ciclo escolar** al leer `asistencias` (a diferencia del Motor de Contexto, que sí usa `ciclo_escolar_id`), lo que puede mezclar datos de distintos ciclos si un alumno repite grupo o el docente reutiliza el registro entre ciclos. **Ruta de solución decidida** (Decisión 11): agregar `inscripcion_id` a las tablas de evento, que trae el ciclo escolar implícito.
- **Dos endpoints de importación con distinta lógica de emparejamiento** aumentan el riesgo de datos duplicados o inconsistentes de alumnos si se usan indistintamente.
- **`docente_contexto_activo` solo se escribe en un lugar** (`/dashboard/grupos/nuevo`, al crear un grupo) — no existe pantalla para que un docente con varios grupos/ciclos cambie explícitamente cuál está activo.
- **Memoria de IA a medio construir**: `perfil_alumno_notas.estado` ya se filtra al leer (`!= 'pendiente_confirmar'`), pero no existe ningún flujo que escriba en la tabla ni UI de confirmación/descarte por el docente.

## 11. Recomendaciones

1. Agregar acceso a **Lista** en la navegación principal (rueda de `/dashboard` y drawer de `/dashboard/chat`).
2. Arreglar o eliminar el enlace roto a `alumnos/nuevo`.
3. Eliminar `app/utils/generarWord.ts` y `app/api/ocr-foto/route.ts` si se confirma que no se van a usar.
4. Unificar los flujos de importación/actualización de alumnos por foto/archivo en un solo endpoint con una única lógica de emparejamiento.
5. Definir y documentar un único modelo de "grupo" (retirar `perfiles_docentes.grado/grupo` en favor de la tabla `grupos`, o viceversa) para que Chat/Word y Lista lean la misma fuente de verdad.
6. Versionar el esquema de Supabase (migraciones SQL) dentro del repo para que quede trazable en git.
7. Alinear el modelo de asistencia entre la UI (`presente: boolean`) y el Motor de Contexto (`falta/retardo/justificada`) antes de seguir construyendo funciones de IA sobre asistencia.

## 12. Estado actual del desarrollo

- **Sprint 1 (módulo Lista)** está funcionalmente avanzado: lista con filtros/conteos, Ficha Inteligente del Alumno con 9 pestañas (Resumen, Datos, Asistencia, Incidencias, Evaluaciones, Evidencias, Necesidades de apoyo, Fichas descriptivas, Historial) y dos pasadas de rediseño visual ya aplicadas, asistencia, importación de listas oficiales, periodos de evaluación — pero sin entrada de navegación visible. Todo esto vive sin commit en el working tree al momento de este documento.
- Alta/edición (no solo lectura) desde la Ficha solo existe hoy para **Datos** y **Asistencia**; Incidencias/Evaluaciones/Evidencias/Necesidades de apoyo/Fichas descriptivas son de solo lectura.
- **Planeación y Seguimiento** son solo placeholders "Próximamente", consistente con la decisión de no trabajarlos aún.
- La app está a medio camino entre el modelo legado (perfil docente plano) y el modelo relacional nuevo (instituciones/ciclos/grupos), con ambos coexistiendo en distintas pantallas.
- La integración de IA (Chat, Clasificador Nivel 0, Motor de Contexto) es la parte más nueva y sofisticada del código, pero todavía no está completamente alineada con los datos reales que produce el módulo Lista.
- **Arquitectura del CORE**: se documentó formalmente en `DECISIONS.md` (Decisiones 10 y 11) el conjunto de principios permanentes del CORE y la decisión de Alumno permanente + Inscripción por ciclo escolar como resolución al problema de las dos fuentes de verdad de alumno↔grupo. Es una decisión de diseño; su implementación (esquema de Supabase, migración de datos, ajuste de `lib/sesionContexto.ts` y de las pantallas que hoy usan `alumnos.grupo_id`) está pendiente de autorización explícita.
