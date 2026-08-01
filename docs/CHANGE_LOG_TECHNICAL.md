# Change log técnico — Docente IA

Historial apéndice. Nunca se reescribe, solo se agrega al final. Una entrada por bloque de trabajo cerrado.

---

## 2026-07-31 — C-001

ID: C-001
Acción realizada: Consolidación y protección del estado actual (push de commits pendientes, aislamiento de trabajo no consolidado en tres grupos, respaldo externo del módulo Seguimiento, verificación de estado de migración, revisión de seguridad de los tres endpoints nuevos, decisión sobre la etiqueta Evaluación/Seguimiento, creación de los archivos de control permanente)
Archivos creados: docs/PROJECT_CONTROL.md, docs/CHANGE_LOG_TECHNICAL.md, más el respaldo externo en ~/Desktop/RESPALDO_DOCENTE_IA_SEGUIMIENTO_2026-07-31/ (fuera del repositorio)
Verificaciones ejecutadas: git status, git log, git fetch + comparación fresca contra origin/main, verificación de existencia de los 3 commits objetivo, lectura completa de los 3 endpoints nuevos del módulo Seguimiento, verificación de que la pestaña "Seguimiento" de la ficha del alumno sigue leyendo la tabla evaluaciones sin conexión al módulo nuevo, verificación de ausencia de credenciales reales en los archivos copiados al respaldo
Resultado:
- Push exitoso de 63b9e0a a origin/main (be73e15..63b9e0a). Corrección al reporte de auditoría previo: 0cede69 y be73e15 ya estaban en origin/main antes de este bloque, solo 63b9e0a seguía pendiente.
- Clasificación de pendientes en 3 grupos confirmada, con una excepción real: app/dashboard/lista/page.tsx mezcla contenido de Grupo B y Grupo A en el mismo diff sin commitear.
- Respaldo externo del módulo Seguimiento creado y verificado completo (9 archivos nuevos + 3 diffs, incluyendo el diff mezclado de lista/page.tsx con advertencia explícita).
- Estado de la migración seguimiento_fase3.sql: NO se pudo verificar (sin credenciales reales de Supabase en este entorno — NEXT_PUBLIC_SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY vacíos).
- Hallazgo de seguridad crítico: POST /api/proyectos-seguimiento y POST /api/proyectos-seguimiento/[id]/hoja aceptan docente_id del cliente sin verificarlo contra el access_token real — mismo patrón de vulnerabilidad ya corregido antes en este proyecto para otro endpoint.
- Recomendación sobre la etiqueta: revertir temporalmente a "Evaluación" — la pestaña no tiene ninguna conexión real con el módulo Seguimiento todavía, mostrarla como "Seguimiento" generaría una expectativa falsa en el docente.
Pruebas: ninguna prueba funcional ejecutada (fuera del alcance autorizado de este bloque) — solo verificaciones de lectura no destructivas.
Incidencias: ninguna durante la ejecución del bloque.
Sin modificaciones funcionales: confirmado — no se tocó lógica de la aplicación, no se ejecutó la migración, no se eliminó ningún archivo, no se usó git clean ni git reset, no se mezclaron los grupos en ningún commit (no se hizo ningún commit de Grupo A, B ni C durante este bloque, solo el push de commits ya existentes de antes de C-001).

---

## 2026-08-01 — C-001B

ID: C-001B
Acción realizada: Cierre documental e inventario maestro — verificación del resultado de C-001 (git, respaldo, archivos de control), inventario completo de 23 módulos con evidencia de código, consolidación de la lista maestra de pendientes (ACC-001 a ACC-017), priorización P0–P3, definición (sin ejecución) del bloque C-002, organización de terminales, clasificación de cambios sin consolidar en 4 grupos, y corrección de una imprecisión del registro de C-001 sobre qué endpoint de importación fue realmente corregido.
Archivos modificados: docs/PROJECT_CONTROL.md (ampliado, sin borrar contenido previo — secciones superadas marcadas como tales), docs/CHANGE_LOG_TECHNICAL.md (esta entrada, agregada al final).
Verificaciones ejecutadas: git status, git log -1, git fetch + comparación contra origin/main (sincronizado, sin cambios remotos pendientes), confirmación de existencia y tamaño del respaldo externo en ~/Desktop/RESPALDO_DOCENTE_IA_SEGUIMIENTO_2026-07-31/ (108K; carpetas diffs/ y nuevos/ más INVENTARIO.txt), lectura completa de docs/PROJECT_CONTROL.md y docs/CHANGE_LOG_TECHNICAL.md existentes, confirmación de que /tmp/AUDITORIA_DOCENTE_IA.md ya no existe (detalle original de varios ACC no recuperable), grep dirigido de patrones de autenticación (auth.getUser, docente_id) en los 3 endpoints de proyectos-seguimiento y en los 2 endpoints de importación de alumnos, lectura completa de app/api/importar-datos-alumnos/route.ts, exploración de código de los 23 módulos del inventario mediante un subagente de solo lectura.
Resultado:
- Git: rama main, commit 63b9e0a, sincronizado con origin/main (sin push necesario). Sin stashes ni ramas adicionales.
- Respaldo de Seguimiento: confirmado existente y completo.
- docs/PROJECT_CONTROL.md y docs/CHANGE_LOG_TECHNICAL.md: existían desde C-001 pero incompletos para los requisitos de C-001B (sin inventario de 23 módulos, sin lista maestra de pendientes con campos completos, sin priorización P0-P3, sin definición de C-002, sin organización explícita de terminales, sin clasificación de grupos de cambios) — completados en este bloque.
- Corrección importante al registro de C-001: el texto anterior afirmaba que el patrón de vulnerabilidad de Seguimiento "ya fue corregido antes... para app/api/importar-datos-alumnos/route.ts". Verificado como impreciso: ese archivo fue descontinuado (retorna 410, sin consumidores confirmados), no corregido. El endpoint que sí tiene la corrección real de autorización es app/api/importar-alumnos/route.ts (sin "-datos-"), vía lib/server/authApi.ts. Ver ACC-014.
- Vulnerabilidad de Seguimiento reconfirmada con línea exacta: app/api/proyectos-seguimiento/route.ts:88 y app/api/proyectos-seguimiento/[id]/hoja/route.ts:69,116. app/api/proyectos-seguimiento/sugerir-indicadores/route.ts:53 confirmado SIN el mismo problema (usa auth.getUser()).
- Nuevo hallazgo NO VERIFICADO (no confirmado como vulnerabilidad, requiere lectura completa antes de dar por cerrado el alcance de seguridad general): app/api/periodos-evaluacion/route.ts y app/api/ocr-foto/route.ts sin patrón de autenticación visible en grep superficial — registrado como ACC-015.
- 17 identificadores de pendientes consolidados (ACC-001 a ACC-017); ACC-001, ACC-002, ACC-009 y ACC-012 quedan marcados como "detalle original no recuperable" — sus IDs se conservan pero no se inventó contenido.
- C-002 queda definido (objetivo, endpoints exactos, archivos permitidos/prohibidos, pruebas, criterios de aceptación, riesgos de regresión, dependencia con la migración) pero NO ejecutado.
Pruebas: ninguna prueba funcional ejecutada — solo lectura de código y verificación de Git/archivos (fuera de alcance autorizado para C-001B).
Incidencias: ninguna durante la ejecución del bloque.
Sin modificaciones funcionales: confirmado — no se tocó lógica de la aplicación, no se ejecutó ninguna migración, no se corrigió ningún endpoint, no se hizo push, no se realizó ningún commit todavía (pendiente de autorización explícita del usuario, según regla del bloque).

---

## 2026-08-01 — C-002

ID: C-002
Acción realizada: Corrección de seguridad (IDOR) de los dos endpoints críticos de Seguimiento identificados en C-001/C-001B. Se reemplazó la confianza en `docente_id` enviado por el cliente por resolución server-side vía `autenticarRequestApi()` (`lib/server/authApi.ts`), reutilizando el mismo patrón ya corregido en `app/api/importar-alumnos/route.ts`. Se agregó verificación explícita de pertenencia del recurso (grupo/proyecto) al docente autenticado, con códigos de estado diferenciados (400/401/403/404).
Archivos modificados: `app/api/proyectos-seguimiento/route.ts` (handler `POST`; `docente_id` eliminado de `BodyPost` y resuelto como `auth.user.id`; validación de formato UUID de `grupo_id`; verificación explícita `grupo.docente_id === docenteId` con 403/404 diferenciados), `app/api/proyectos-seguimiento/[id]/hoja/route.ts` (handler `POST`; mismo patrón — `docente_id` ya no se lee del body, se resuelve como `auth.user.id`; validación de formato UUID de `proyectoId`; verificación explícita `proyecto.docente_id === docenteId` con 403/404 diferenciados; el `docenteId` resuelto se usa tanto para la consulta a `perfiles_docentes` como para la ruta de Storage del PDF).
Archivos NO modificados (confirmado): `lib/server/authApi.ts` (reutilizado tal cual, sin cambios), `app/api/proyectos-seguimiento/sugerir-indicadores/route.ts` (ya tenía el patrón correcto), cualquier archivo de Lista, Chat IA, Asistencia, Incidencias, CURP, Voz, generación de PDF, pantallas de Seguimiento (`app/dashboard/lista/proyectos/*`), `migrations/`.
Verificaciones ejecutadas: `npx tsc --noEmit` (sin errores), `npx eslint app/api/proyectos-seguimiento/route.ts "app/api/proyectos-seguimiento/[id]/hoja/route.ts"` (sin errores), lectura del código de ambos endpoints confirmando los 4 casos de autorización (sin sesión → 401; sesión válida con recurso ajeno → 403; recurso inexistente → 404; recurso propio → continúa sin regresión) y el caso de ID con formato inválido → 400, `git status` antes y después confirmando que ningún archivo fuera de `app/api/proyectos-seguimiento/` cambió, lectura de las 2 pantallas frontend consumidoras (`app/dashboard/lista/proyectos/page.tsx`, `.../nuevo/page.tsx`) para confirmar que el flujo legítimo (que ya manda `access_token` de la sesión real) no se rompe al dejar de leer `docente_id` del body.
Resultado:
- Los dos endpoints (`POST /api/proyectos-seguimiento`, `POST /api/proyectos-seguimiento/[id]/hoja`) ya no confían en ningún dato de identidad enviado por el cliente — el docente se resuelve exclusivamente desde `auth.getUser()` sobre el `access_token` real de la sesión.
- IDOR confirmado en C-001/C-001B eliminado en código: ya no es posible insertar un proyecto a nombre de otro docente, leer el perfil de otro docente, ni generar/almacenar un PDF bajo la ruta de Storage de otro docente a través de estos dos endpoints.
- Hallazgo nuevo, fuera del alcance autorizado de C-002, NO corregido: `GET /api/proyectos-seguimiento` (mismo archivo `route.ts`) tampoco valida que `grupo_id` (query param) pertenezca al docente autenticado — mismo patrón de IDOR, alcance de solo lectura. Propuesto como ACC-018, sin bloque asignado, requiere autorización explícita antes de tocarlo.
- Sin push, sin commit — ambos endpoints quedan como cambios locales sin consolidar dentro de Grupo A (Seguimiento), pendientes de prueba funcional real contra Supabase antes de proponer commit.
Pruebas: `tsc --noEmit` y `eslint` dirigido pasaron sin errores; sin prueba funcional en vivo (sin credenciales reales de Supabase en este entorno, mismo bloqueo ya documentado para el módulo Base de datos).
Incidencias: ninguna durante la ejecución del bloque.
Sin modificaciones fuera de alcance: confirmado — no se tocaron pantallas, no se tocó generación de PDF, no se tocó Lista/Planeación/Voz/Incidencias/CURP, no se ejecutó ninguna migración, no se modificó `lib/server/authApi.ts`, no se tocó `sugerir-indicadores/route.ts`, no se hizo commit ni push.

---

## 2026-08-01 — C-003

ID: C-003
Acción realizada: Corrección de ACC-018 — IDOR de lectura en `GET /api/proyectos-seguimiento` (documentado como hallazgo nuevo al cierre de C-002, fuera de su alcance en ese momento). El `GET` consultaba `proyectos_seguimiento` filtrando solo por `grupo_id` de query param, sin sesión verificada ni comprobación de que el grupo perteneciera al docente autenticado.
Archivo modificado: `app/api/proyectos-seguimiento/route.ts` (únicamente el handler `GET`; se reemplazó la lectura manual del header Authorization y el cliente Supabase sin `getUser()` por `autenticarRequestApi(extraerBearerToken(req))`, mismo patrón de `lib/server/authApi.ts` ya usado en el `POST` de este archivo desde C-002; se agregó validación de formato UUID de `grupo_id` y verificación explícita `grupo.docente_id === docenteId` contra la tabla `grupos` antes de consultar `proyectos_seguimiento`; se eliminó la función `getClient()` y el import de `createClient`/`SupabaseClient`, ya sin uso). El handler `POST` del mismo archivo no se modificó.
Archivos NO modificados: `app/api/proyectos-seguimiento/[id]/hoja/route.ts`, `app/api/proyectos-seguimiento/sugerir-indicadores/route.ts`, `lib/server/authApi.ts`, cualquier pantalla de Seguimiento/Lista/Chat IA/CURP, `migrations/`.
Verificaciones ejecutadas: `npx tsc --noEmit` (sin errores), `npx eslint app/api/proyectos-seguimiento/route.ts` (sin errores), lectura de código confirmando los 5 casos exigidos (401 sin sesión; grupo propio → solo proyectos de ese grupo; grupo ajeno → 403 si existe, 404 si no existe; sin `grupo_id` → 400 antes de tocar la base, ninguna fuga posible; `grupo_id` con formato inválido → 400), `git status` confirmando que ningún otro archivo cambió, confirmación de que el `POST` quedó byte-idéntico a como salió de C-002.
Resultado:
- `GET /api/proyectos-seguimiento` ya no permite listar proyectos de un grupo ajeno — el docente se resuelve exclusivamente desde `auth.getUser()`, y el grupo se verifica explícitamente contra ese docente antes de cualquier lectura de `proyectos_seguimiento`.
- ACC-018 queda CERRADO.
- Sin push, sin commit — el archivo queda como cambio local sin consolidar dentro de Grupo A (Seguimiento), igual que el resto de C-002.
Pruebas: `tsc --noEmit` y `eslint` dirigido pasaron sin errores; sin prueba funcional en vivo (sin credenciales reales de Supabase en este entorno, mismo bloqueo ya documentado).
Incidencias: ninguna durante la ejecución del bloque.
Sin modificaciones fuera de alcance: confirmado — no se tocó el `POST` de este archivo, no se tocó `[id]/hoja/route.ts`, no se tocaron pantallas, no se ejecutó ninguna migración, no se hizo commit ni push, no se abrió C-004.
