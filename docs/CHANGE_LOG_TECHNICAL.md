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

---

## 2026-08-01 — C-001C

ID: C-001C
Acción realizada: Registro de verificación de la migración de Seguimiento. El usuario reportó haber verificado directamente en Supabase, mediante una consulta de solo lectura a `information_schema.tables`, que las 4 tablas de `migrations/seguimiento_fase3.sql` ya existen en la base de datos real. Este bloque (Terminal 1, control/documentación) registra esa confirmación en `docs/PROJECT_CONTROL.md` y aquí, marca la migración como CONFIRMADA/APLICADA, deja constancia de que no debe volver a ejecutarse, y define (sin ejecutar) el bloque C-004 recomendado para consolidar y probar funcionalmente el módulo Seguimiento.
Archivos modificados: docs/PROJECT_CONTROL.md (actualizado: módulo Seguimiento, módulo Base de datos, prioridad P0/P1, riesgos restantes de C-002/C-003, matriz de acciones que no deben repetirse, nueva sección "Estado de la migración seguimiento_fase3.sql", nueva sección "Siguiente bloque propuesto — C-004", "Próximo bloque permitido"), docs/CHANGE_LOG_TECHNICAL.md (esta entrada).
Verificaciones ejecutadas por esta terminal antes de escribir: `git fetch` + `git status` (sin cambios remotos nuevos), `git log --oneline -5` y `git show --stat` sobre los commits `b201ba4` y `ed901b9` para confirmar que corresponden a C-002 y C-003 ya ejecutados y documentados por otra terminal (autor: el mismo usuario del repositorio, sin push, sin commit de C-001C todavía), lectura completa de las secciones "C-002" y "C-003" ya presentes en docs/PROJECT_CONTROL.md, lectura del diff completo de ambos commits sobre los endpoints de Seguimiento para confirmar que el patrón aplicado (`autenticarRequestApi`, verificación explícita de pertenencia, códigos 400/401/403/404) coincide con lo definido en el bloque C-002 original.
Resultado:
- Migración `migrations/seguimiento_fase3.sql`: CONFIRMADA/APLICADA. Tablas verificadas: `proyectos_seguimiento`, `hojas_evaluacion`, `seguimiento_resultados`, `seguimiento_versiones`. Verificación hecha por el usuario directamente en Supabase (fuera de este entorno de desarrollo, que sigue sin credenciales reales configuradas) — esta terminal no ejecutó la consulta, solo registra el resultado reportado.
- Regla dura registrada: `migrations/seguimiento_fase3.sql` NO debe volver a ejecutarse bajo ninguna circunstancia — ya está aplicada.
- Se detectó (no ejecutado por esta terminal) que otra terminal ya había completado y documentado C-002 (corrección de IDOR en POST de los 2 endpoints de Seguimiento) y C-003 (corrección de IDOR de lectura en GET, cerrando ACC-018 nuevo), ambos con `tsc --noEmit` y `eslint` limpios, ambos sin commit ni push. Esta terminal no modificó ni repitió ese trabajo, solo lo referenció para mantener P0/P1 y los riesgos restantes consistentes con la realidad del código.
- P0 actualizado: ambos puntos que eran P0 (IDOR de Seguimiento, estado de la migración) quedan marcados como resueltos en código/confirmados — el IDOR sigue pendiente de commit y prueba funcional real, ya no de corrección.
- Bloque C-004 definido (consolidación y prueba funcional de Seguimiento: commitear C-002/C-003, prueba funcional real de los 3 endpoints, separar ACC-017, decidir etiqueta Evaluación/Seguimiento, verificar RLS real) — NO ejecutado.
Pruebas: ninguna prueba funcional ni de código ejecutada por esta terminal — solo lectura de commits/diffs ya existentes y actualización de documentación.
Incidencias: ninguna.
Sin modificaciones funcionales: confirmado — no se tocó ningún endpoint, no se ejecutó la migración ni ninguna otra, no se abrió C-004, no se hizo commit todavía (pendiente de autorización explícita del usuario).

---

## 2026-08-01 — C-004

ID: C-004
Acción realizada: Consolidación y prueba funcional del módulo Seguimiento. Diagnóstico completo de integración de los 9 archivos del módulo (flujo pantalla→API→tablas→Storage), pruebas técnicas (`tsc`, `eslint`, intento de `build`), prueba en vivo de los guards de autenticación de los 3 endpoints contra un servidor local (sin datos reales), 1 corrección técnica aplicada, y decisión (sin ejecutar) sobre la ficha del alumno.
Archivos revisados (sin modificar salvo el indicado abajo): `app/api/proyectos-seguimiento/route.ts`, `app/api/proyectos-seguimiento/sugerir-indicadores/route.ts`, `app/api/proyectos-seguimiento/[id]/hoja/route.ts`, `app/dashboard/lista/proyectos/page.tsx`, `app/dashboard/lista/proyectos/nuevo/page.tsx`, `lib/seguimiento/tipos.ts`, `lib/identificadorHoja.ts`, `lib/documentGen/generarHojaSeguimientoPdf.ts`, `lib/documentGen/almacenamiento.ts`, `migrations/seguimiento_fase3.sql` (solo lectura, no ejecutada), `app/dashboard/lista/[alumnoId]/page.tsx` (solo para decidir si pertenece al bloque — no modificado).
Archivo modificado: `app/api/proyectos-seguimiento/route.ts` — únicamente el handler `GET`, envuelto en `try/catch` (mismo patrón que ya usaban los 2 `POST` del mismo archivo desde C-002/C-003); ningún cambio de lógica de negocio, ninguna función nueva.
Verificaciones ejecutadas: `npx tsc --noEmit` (proyecto completo, sin errores, antes y después de la corrección), `npx eslint` sobre los 9 archivos del bloque (1 error preexistente en todo el proyecto — `no-html-link-for-pages` en `app/dashboard/lista/proyectos/page.tsx:126`, mismo patrón que `[alumnoId]/page.tsx:587` y 10+ archivos más, no corregido por no ser una regresión del bloque), `npm run build` (no completó — falla preexistente y ajena en `/api/realtime-token` por `OPENAI_API_KEY` vacío, no relacionada con Seguimiento), verificación de que `.env.local` de este entorno tiene `NEXT_PUBLIC_SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` vacíos (solo la URL de Supabase tiene valor real), `npm run dev` + `curl` directo a los 3 endpoints de Seguimiento sin sesión real (sin crear ni tocar ningún dato) para confirmar los 401 esperados y reproducir el error sin manejar del `GET`, repetición de la misma prueba después de la corrección para confirmar la respuesta JSON limpia.
Resultado:
- Flujo de integración confirmado end-to-end por lectura de código: lista de proyectos → crear proyecto → sugerir indicadores (opcional) → generar hoja → PDF en Storage privado (`hojas-seguimiento`) → URL firmada de descarga. Sin enlaces rotos entre pantallas.
- Corrección aplicada: `GET /api/proyectos-seguimiento` no tenía `try/catch` (a diferencia de los 2 `POST` del mismo archivo) — cualquier error no anticipado (ej. una key de Supabase mal configurada) salía como error sin manejar de Next.js en vez de un JSON `{error: ...}` consistente con el resto del módulo. Corregido envolviendo el cuerpo del handler en `try/catch`. Verificado en vivo antes/después.
- Hallazgo nuevo (ACC-019, P2, EXPERIENCIA DE USUARIO): la pestaña "Seguimiento" de la ficha del alumno promete que "los resultados se registrarán al cargar la hoja de evaluación de un proyecto", pero ningún código escribe todavía en `seguimiento_resultados` (esa fase de captura por foto/OCR está fuera de alcance de C-004) — expectativa falsa para el docente. No corregido en este bloque (es un cambio de copy, no de seguridad ni de bloqueo funcional).
- Hallazgo nuevo (ACC-020, P3, inofensivo): el frontend (`nuevo/page.tsx`) sigue enviando `docente_id` en el body de sus 2 POST, pero el backend ya lo ignora completamente desde C-002 — campo muerto, sin efecto en la autorización real. No corregido (limpieza, no urgente).
- Decisión sobre `app/dashboard/lista/[alumnoId]/page.tsx`: recomendación Opción A (dejar fuera de este commit) — no modificado, ver razones completas en `docs/PROJECT_CONTROL.md`.
- Prueba funcional real (crear proyecto, generar hoja, descargar PDF con datos reales) NO se pudo ejecutar — bloqueada por falta de credenciales reales de Supabase en este entorno de desarrollo, no por falta de autorización. Se ejecutó en su lugar una prueba segura de los guards de autenticación de los 3 endpoints (sin crear ningún dato), confirmando los 401 esperados y validando la corrección aplicada.
Pruebas: ver "Verificaciones ejecutadas" arriba. Ninguna prueba funcional contra datos reales de Supabase (bloqueada por entorno).
Incidencias: ninguna durante la ejecución del bloque; la limitación de credenciales se descubrió y documentó en vez de simularse o ignorarse.
Sin modificaciones fuera de alcance: confirmado — no se tocó Lista, CURP, Planeación, Voz, Incidencias ni Chat IA; no se ejecutó `migrations/seguimiento_fase3.sql` ni ninguna otra migración; no se implementó fotografía, OCR, acumulación trimestral, reportes ni fichas descriptivas; no se agregaron funciones nuevas; no se modificó `app/dashboard/lista/[alumnoId]/page.tsx`; no se hizo commit ni push; no se abrió C-005.

---

## 2026-08-01 — C-004 (continuación: prueba manual, pantalla en blanco, bloqueo de autenticación)

ID: C-004 (continuación)
Acción realizada: retomada la prueba funcional manual guiada de Seguimiento tras resolver el bloqueo de credenciales. Se encontró y corrigió una pantalla en blanco al abrir la app desde la IP de red local; se verificó (sin exponer secretos) que el proyecto y tipo de clave de Supabase coinciden entre local y producción; se descubrió que el proyecto no tiene flujo de recuperación de contraseña, lo que bloqueó el acceso local antes de poder crear el proyecto de prueba de Seguimiento.
Archivos modificados: `next.config.ts` (agregado `allowedDevOrigins: ["192.168.1.10"]`), `docs/PROJECT_CONTROL.md`, `docs/CHANGE_LOG_TECHNICAL.md`. (`app/api/proyectos-seguimiento/route.ts` ya se había modificado en la primera mitad de C-004, sin cambios adicionales en esta continuación.)
Verificaciones ejecutadas: reproducción del error real de consola reportado por el usuario (`WebSocket connection to ws://192.168.1.10:3000/_next/webpack-hmr ... failed: cannot parse response`), lectura de `next.config.ts`, aplicación del cambio, reinicio completo de `npm run dev`, `npx tsc --noEmit` (sin errores), `npx eslint next.config.ts` (sin errores), `curl` a `localhost:3000/dashboard` y `192.168.1.10:3000/dashboard` (200 en ambos, sin el warning de cross-origin en el log), confirmación del usuario en Safari real (Mac e iPhone) de que la pantalla en blanco desapareció; comparación de proyecto/clave de Supabase entre local y producción descargando y analizando los chunks JS públicos de `docente-ia-gules.vercel.app` (mismo proyecto, mismo tipo de clave `sb_publishable_`, distinta clave por checksum); prueba de aceptación de la clave local contra `POST /auth/v1/token?grant_type=password` con credenciales de prueba falsas (`HTTP 400 invalid_credentials`, confirma clave/proyecto correctos); búsqueda exhaustiva en el repo de cualquier flujo de recuperación de contraseña (`forgot password`, `resetPasswordForEmail`, `updateUser`, `recovery`, rutas relacionadas) — ninguna coincidencia.
Resultado:
- Pantalla en blanco en red local: CORREGIDA (`allowedDevOrigins`), confirmada por el usuario en 2 navegadores/dispositivos reales.
- Configuración de Supabase local: CORRECTA — mismo proyecto que producción, clave del formato nuevo válida y aceptada por el endpoint de auth (distinta de la de producción, lo cual es válido).
- Incidente menor: un comando de diagnóstico (`cat -v`) imprimió por accidente el valor completo de `NEXT_PUBLIC_SUPABASE_ANON_KEY` local en la salida de terminal — no es una clave `service_role` ni verdaderamente secreta (es `NEXT_PUBLIC_*`, ya embebida por diseño en el bundle público), pero incumplió la instrucción explícita de no imprimir valores. Reconocido de inmediato al usuario, no se repitió, no se realizó ninguna acción adicional con ese valor.
- Bloqueo real encontrado: NO existe ningún flujo de recuperación/actualización de contraseña en el proyecto — el correo de recuperación de Supabase redirige a una ruta local inexistente (404). Registrado como ACC-022 (P1).
- Hallazgo de experiencia de usuario adicional: el acceso a Seguimiento desde Lista es solo un ícono de copa sin texto — registrado como ACC-021 (P2), explícitamente fuera de alcance para rediseñar dentro de C-004.
- Confirmado por observación en producción: con una sesión real, el docente, su grupo y sus alumnos cargan correctamente — descarta que el bug de "No se pudo identificar al maestro" fuera un problema de lógica de la aplicación; fue exclusivamente de sesión local aislada por origen.
- La prueba funcional real de Seguimiento (crear proyecto → indicadores → guardar → generar hoja → descargar PDF) SIGUE SIN EJECUTARSE — no se llegó a crear el proyecto de prueba en ningún momento.
Pruebas: ver "Verificaciones ejecutadas" arriba. Ninguna prueba funcional de Seguimiento con datos reales todavía.
Incidencias: 1 — impresión accidental de una clave `NEXT_PUBLIC_*` en salida de terminal (ver arriba); reconocida y no repetida; no afecta el estado del código ni de los datos.
Sin modificaciones fuera de alcance: confirmado — no se intentaron más inicios de sesión con credenciales reales, no se modificaron enlaces de recuperación, no se cambió ninguna contraseña, no se crearon usuarios, no se creó el proyecto de prueba de Seguimiento, no se usó `service_role`, no se ejecutó ninguna migración, no se hizo commit ni push, no se abrió C-005.

---

## 2026-08-01 — C-004 (cierre definitivo)

ID: C-004 (cierre)
Acción realizada: cierre documental definitivo de C-004. Tras la prueba funcional exitosa de login/recuperación de contraseña/sincronización de sesión (docente, grupo y 28 alumnos cargando correctamente), se implementó y verificó por código un endpoint `DELETE` para proyectos de Seguimiento como paso previo a la prueba funcional del formulario manual. Antes de ejecutar esa prueba, el usuario aprobó una decisión arquitectónica: Seguimiento deja de ser un módulo independiente accesible desde Lista y pasa a depender de Planeación, con un flujo definitivo de captura por fotografía en vez de formulario manual. En consecuencia, C-004 se cierra con el alcance de autenticación/sesión completo, y el objetivo original de probar el formulario manual de Seguimiento queda formalmente CANCELADO (no pendiente) — ese formulario deja de ser el flujo definitivo.
Archivos modificados en este cierre: docs/PROJECT_CONTROL.md (cierre definitivo de C-004, decisión arquitectónica Seguimiento→Planeación registrada en detalle, tabla de código conservado sin commit, definición de C-005), docs/CHANGE_LOG_TECHNICAL.md (esta entrada).
Verificaciones ejecutadas antes de escribir: `git log --oneline` (4 commits locales sin push: 51d5a5e, bd37e2e, d64ae39, e02712d), `git status --short` y `git status -sb` (confirmando el mismo inventario de archivos sin commit ya conocido, sin cambios inesperados), revisión de que ninguno de los 4 commits ya hechos depende del formulario manual de Seguimiento ni se ve afectado por la nueva decisión arquitectónica.
Resultado:
- C-004 CERRADO. Cumplido: recuperación de contraseña (ACC-022 cerrado), sincronización de sesión tras magic link, identificación correcta de docente/grupo/alumnos, correcciones técnicas (GET try/catch, allowedDevOrigins). Cancelado, no pendiente: prueba funcional del formulario manual de Seguimiento.
- Decisión arquitectónica registrada: Seguimiento pertenece a Planeación (Planeación → Proyecto → Hoja final → impresión/llenado manual → fotografía → reconocimiento automático → confirmación de lecturas dudosas → historial individual → concentrado trimestral → reporte de evaluación → ficha descriptiva). La copa de Lista se retira solo cuando el flujo nuevo esté completo, no antes. El formulario "Nuevo proyecto de seguimiento" deja de ser el flujo principal.
- Todo el código de Seguimiento ya construido (API, tablas, generación de PDF, Storage, endpoint DELETE nuevo) se conserva sin commit, sin revertir, sin archivar aparte — reutilizable para C-005 en adelante.
- Riesgo abierto registrado: el endpoint DELETE construido en este bloque nunca se probó de extremo a extremo con un proyecto real.
- Siguiente bloque definido (NO iniciado): C-005 — Construcción del módulo Planeación, Fase 1 (modelo de datos y estructura funcional base). Confirmado por búsqueda en el repo: no existe hoy ninguna tabla de planeaciones ni modelo de datos estructurado — Planeación hoy solo genera documentos sueltos vía Chat IA.
Pruebas: ninguna prueba funcional ni de código ejecutada en este cierre — solo verificación de Git y actualización de documentación.
Incidencias: ninguna.
Sin modificaciones funcionales: confirmado — no se modificó código, no se borró ninguna función ni archivo, no se ejecutó ninguna migración, no se hizo push, no se hizo commit todavía (pendiente de autorización explícita del usuario), no se abrió C-005.

---

## 2026-08-03 — C-005 (infraestructura de base de datos)

ID: C-005 (infraestructura de base de datos)
Acción realizada: instalación y vinculación de Supabase CLI (`npm install supabase --save-dev`, `npx supabase login` en terminal interactiva real del usuario, `npx supabase init`, `npx supabase link --project-ref abdtrkdfobrkramerrrc`); auditoría de solo lectura del esquema remoto real que reveló una tabla `planeaciones` preexistente y parcial (7/13 columnas, origen desconocido, con una política RLS `FOR ALL` ajena a este repositorio) y que las 4 tablas de Seguimiento tenían RLS deshabilitada pese a que `seguimiento_fase3.sql` las creó completas; diseño, dry-run y ejecución de 2 migraciones correctivas idempotentes vía `npx supabase db push`; verificación final por el usuario contra `pg_policies`/`pg_class` confirmando el estado correcto.
Archivos creados: `supabase/config.toml`, `supabase/.gitignore` (por `supabase init`), `supabase/migrations/20260802150000_reparacion_seguimiento_planeacion.sql`, `supabase/migrations/20260803090000_eliminar_politicas_all_heredadas.sql`. `migrations/seguimiento_fase3.sql` y `migrations/planeacion_fase1.sql` (raíz del repo) permanecen intactos, sin modificar, sin mover.
Archivo modificado: `package.json` (agregado `"supabase": "^2.111.0"` a devDependencies), `package-lock.json` (234 líneas de resolución de dependencias).
Verificaciones ejecutadas: múltiples rondas de lectura directa vía PostgREST (existencia y tipo `uuid` de columnas, en las 6 tablas, sin `service_role`, sin bypass de RLS); `npx supabase db push --dry-run` antes de cada ejecución real, confirmando en ambos casos que solo la migración esperada sería aplicada; `npx supabase migration list` después de cada push, confirmando el historial remoto; verificación visual del usuario en el panel de Supabase (Database → Tables, Database → Policies) y consultas de solo lectura del usuario contra `pg_class`/`pg_policies` (catálogos del sistema, fuera del alcance de PostgREST sin `service_role`, por lo que no pude ejecutarlas yo mismo — el usuario las corrió directamente).
Resultado:
- `planeaciones`: completada de 7 a 13 columnas (`ciclo_escolar_id`, `periodo_evaluacion_id`, `nombre`, `proposito`, `estado`, `version` agregadas vía `ALTER TABLE ADD COLUMN IF NOT EXISTS`, sin tocar las 7 columnas ni datos existentes).
- `planeacion_proyectos`: creada completa (no existía).
- RLS habilitada en las 6 tablas (`planeaciones`, `planeacion_proyectos`, `proyectos_seguimiento`, `hojas_evaluacion`, `seguimiento_resultados`, `seguimiento_versiones`) — confirmado por el usuario contra `pg_class.relrowsecurity = true` en las 6.
- Políticas heredadas `FOR ALL` (`proyectos_seguimiento_titular`, `hojas_evaluacion_titular`, `seguimiento_resultados_titular`, `seguimiento_versiones_titular`, `"docentes gestionan sus propias planeaciones"`) eliminadas por nombre exacto en la segunda migración correctiva, tras detectarse que la primera no las había eliminado (discrepancia de nombres entre los `DROP POLICY IF EXISTS` nuevos y los nombres reales viejos).
- Estado final verificado por el usuario contra `pg_policies`: 18 políticas totales, exactamente 1 SELECT + 1 INSERT + 1 UPDATE por tabla en las 6 tablas, 0 ALL, 0 DELETE, 0 duplicadas.
- `migrations/planeacion_fase1.sql` nunca se ejecutó tal cual (hubiera sido un no-op silencioso sobre la `planeaciones` parcial) — queda como referencia histórica del diseño original.
- Historial remoto de migraciones: 2 entradas (las 2 correctivas), local/remote coincidentes en ambas. `seguimiento_fase3.sql` y `planeacion_fase1.sql` siguen sin registrar en ese historial (aplicados/diseñados fuera de este flujo), pendiente no urgente.
- Riesgo sin resolver: origen real de la `planeaciones` parcial preexistente y su política ajena, todavía desconocido.
Pruebas: `npx tsc --noEmit`/`npx eslint` no aplicaron en este bloque (sin cambios de código de aplicación); validación estática de ambos archivos SQL (balance de paréntesis, `begin;`/`commit;` únicos, ausencia confirmada de `DROP TABLE`/`TRUNCATE`/`DELETE FROM`/`FOR ALL`/`FOR DELETE`/`SECURITY DEFINER`/`service_role` en instrucciones ejecutables) antes de cada ejecución; `git diff --check` limpio en ambos archivos.
Incidencias: 1 — la primera migración correctiva no eliminó las políticas heredadas por una discrepancia de nombres en sus `DROP POLICY IF EXISTS`; detectada por el usuario, corregida con una segunda migración específica.
Sin modificaciones funcionales: confirmado — no se modificó ningún archivo de la interfaz ni de los endpoints ya existentes (`app/api/planeaciones/*`, `app/dashboard/planeacion/page.tsx`), no se ejecutó `migration repair`, no se ejecutó `db reset`, no se perdió ningún dato, no se hizo commit ni push.

---

## 2026-08-03 — C-005, Paso 1 (cálculo determinista de fechas)

ID: C-005 — Paso 1
Acción realizada: durante la prueba funcional real de Planeación, antes de crear cualquier registro, se detectó que el flujo de creación manual ("+ Nueva") contradice la arquitectura aprobada (creación principal vía Chat IA) y que existe una duplicación de accesos manuales de creación en Seguimiento/ficha del alumno/Planeación (registrada como ACC UI-024, no implementada). Se suspendió la prueba manual y se entregó un diagnóstico completo (sin modificar código) de la integración Chat IA → Planeación, dividida en pasos pequeños. Con autorización explícita, se implementó únicamente el Paso 1: una función aislada y determinista para calcular fechas y días efectivos de clase.
Archivos creados: `lib/planeacion/calculoFechasHabiles.ts` (función `calcularFechasPlaneacion()`), `scripts/verificar-calculo-fechas-planeacion.ts` (pruebas, mismo patrón que `scripts/verificar-analisis-calendario.ts`).
Archivos modificados: ninguno de código — `docs/PROJECT_CONTROL.md` (esta misma actualización).
Verificaciones ejecutadas: `npx tsx scripts/verificar-calculo-fechas-planeacion.ts` (14 casos, 28 aserciones), `npx tsc --noEmit`, `npx eslint` sobre ambos archivos nuevos, `git diff --check`, `git status --short`.
Resultado:
- 28/28 aserciones aprobadas en la primera corrida completa (tras corregir 1 error de eslint — `let` que debía ser `const`, sin efecto funcional, detectado y corregido antes de este registro).
- Casos cubiertos: dos semanas normales; cruce de fin de semana; inicio en sábado (se mueve al siguiente día hábil con advertencia); un día inhábil dentro del periodo; una semana completa de vacaciones; dos suspensiones separadas; fechas exactas del docente; duración sin fecha inicial; rango sin ningún día efectivo (conflicto); fecha final anterior a la inicial (conflicto); duración cero o negativa (conflicto); cambio de mes; cambio de año; cierre de trimestre (evento_sin_clases arbitrario).
- "Dos semanas" se resuelve como 10 días efectivos por defecto (`duracionSemanas × diasEfectivosPorSemana`, configurable) — la función nunca interpreta lenguaje natural, solo recibe el número ya resuelto.
- Límite de seguridad de 400 días naturales de búsqueda hacia adelante, para no entrar en un bucle si los días no laborables cubrieran un tramo absurdo.
- `app/api/chat/route.ts` y `lib/clasificadorNivel0.ts` NO se tocaron — confirmado, el Paso 1 es 100% aislado.
- Paso 2 (funciones puras de persistencia en `lib/planeacion/`) definido en el diagnóstico previo, pero NO iniciado.
Pruebas: ver "Verificaciones ejecutadas" arriba — todas limpias, sin errores.
Incidencias: 1 menor — un `let`/`const` detectado por eslint, corregido de inmediato, sin impacto funcional.
Sin modificaciones funcionales fuera de alcance: confirmado — no se tocó Chat IA, el clasificador de intenciones, la interfaz de Planeación, Seguimiento, Calendario, Lista, Asistencia ni la base de datos; no se crearon registros de prueba; no se ejecutó ninguna migración; no se modificaron políticas RLS; no se hizo commit ni push; no se inició el Paso 2.

---

## 2026-08-03 — C-005, Paso 2 (capa aislada de persistencia)

ID: C-005 — Paso 2
Acción realizada: con autorización explícita y diseño mostrado y aprobado previamente, se implementaron 5 funciones puras de persistencia para Planeación en `lib/planeacion/`, reutilizables tanto por los endpoints HTTP ya existentes (`app/api/planeaciones/*`) como por el futuro flujo del Chat IA (Paso 3, no iniciado).
Archivos creados: `lib/planeacion/persistencia.ts` (`crearPlaneacion`, `listarPlaneaciones`, `obtenerPlaneacionPorId`, `actualizarPlaneacion`, `archivarPlaneacion`), `scripts/verificar-persistencia-planeacion.ts` (pruebas con un doble en memoria de `SupabaseClient`, mismo patrón `verificar()` del resto del proyecto).
Archivos modificados: ninguno de código — `lib/planeacion/tipos.ts` se revisó y no requirió cambios, se reutilizó tal cual.
Verificaciones ejecutadas: `npx tsx scripts/verificar-persistencia-planeacion.ts` (12 escenarios, 24 aserciones), `npx tsc --noEmit`, `npx eslint` sobre ambos archivos nuevos, `git diff --check`, `git status --short` — repetidas antes del commit, todas limpias.
Resultado:
- 24/24 aserciones aprobadas: creación válida; campos faltantes; listado por grupo; listado por trimestre; consulta por ID válida e inexistente; actualización parcial sin sobrescribir campos no incluidos (con incremento de `version`); protección de `docente_id` y de `grupo_id` frente a datos ajenos; archivado sin borrado físico y sin incrementar `version`; error controlado de Supabase devuelto como resultado tipado sin lanzar excepción; confirmación estática de ausencia de `service_role` y de creación de cliente propio.
- Cada función recibe un `SupabaseClient` ya autenticado con la sesión real del docente (nunca crea uno propio, nunca usa `service_role`); RLS se aplica por el token real, y además cada función resuelve `docenteId` por su cuenta vía `auth.getUser()` como defensa adicional, sin confiar en un `docente_id` recibido como dato.
- `actualizarPlaneacion` excluye `docente_id`/`grupo_id` de su tipo de entrada a nivel de TypeScript — no solo en tiempo de ejecución.
- `archivarPlaneacion` usa `UPDATE` del campo `estado` únicamente, sin `DELETE`, sin incrementar `version`.
- `app/api/chat/route.ts`, `lib/clasificadorNivel0.ts`, la interfaz de Planeación, Seguimiento, Lista, Calendario y Asistencia NO se tocaron — confirmado, el Paso 2 es 100% aislado.
- Paso 3 (integración con Chat IA: nuevos intents, cambios en `app/api/chat/route.ts` y en el Clasificador de Nivel 0, persistencia automática al aprobar) definido en el diagnóstico previo, pero NO iniciado.
Commit funcional aislado: `c4b1fbce2112de5ca86d451eb19bd25c505fca3e` — exactamente los 2 archivos listados arriba, sin push.
Pruebas: ver "Verificaciones ejecutadas" arriba — todas limpias, sin errores.
Incidencias: 1 menor — la primera corrida de eslint marcó una advertencia por un parámetro del doble de pruebas intencionalmente sin usar (`_columnas` en el `select()` simulado); corregida referenciándolo explícitamente (`void _columnas`), sin efecto funcional.
Sin modificaciones funcionales fuera de alcance: confirmado — no se tocó Chat IA, el clasificador de intenciones, la interfaz de Planeación, Seguimiento, Calendario, Lista, Asistencia ni la base de datos; no se ejecutó ninguna migración; no se modificaron políticas RLS; no se incluyó ningún archivo ajeno en el commit; no se hizo push; no se inició el Paso 3.

---

## 2026-08-03 — C-005, Paso 3A (consulta de planeaciones desde el Chat IA)

ID: C-005 — Paso 3A
Acción realizada: con autorización explícita y diseño mostrado y aprobado previamente (archivos exactos, cambios en el clasificador, punto de integración en `app/api/chat/route.ts`, estrategia de docente/grupo activos, reutilización de `listarPlaneaciones`/`obtenerPlaneacionPorId`, casos de prueba, riesgos de regresión), se integró la intención `planeacion_consultar` al único Chat IA, reutilizando exclusivamente la capa de persistencia del Paso 2. La sesión sufrió un corte de conexión a mitad de la implementación ("Connection closed mid-response"); se realizó una auditoría de recuperación completa (`git status`/`git diff`/timestamps por archivo) antes de continuar, confirmando que ningún cambio se había perdido y que solo faltaba el script de pruebas, que se completó a continuación.
Archivos modificados: `app/api/chat/route.ts` (1 línea aditiva: agrega `canal` al contexto ya existente que se pasa a `ejecutarHerramientaDeModulo`), `lib/clasificadorNivel0.ts` (nueva intención `planeacion_consultar`, 4 campos nuevos opcionales, nueva regla 20 al final; reglas 1-19 sin alterar), `lib/motorContexto.ts` (función de solo lectura nueva `periodosEvaluacionDelCiclo()`), `lib/asistente/herramientasModulo.ts` (nueva Herramienta `planeacion_consultar`, registrada en el mismo `REGISTRO` determinista que ya usan `consultar_documentos`/`consultar_apoyo`/`consultar_asistencia_grupo`; campo opcional `canal` agregado a `ContextoEjecucionHerramienta`, aditivo, no rompe las herramientas existentes).
Archivos creados: `scripts/verificar-planeacion-consultar.ts` (pruebas, doble en memoria de `SupabaseClient` extendido del Paso 2 con `periodos_evaluacion`, clasificaciones simuladas — nunca se llama a Claude para probar la clasificación real, misma limitación que ya existe para el resto del clasificador, ningún test la cubre de forma determinista).
Verificaciones ejecutadas: `npx tsx scripts/verificar-planeacion-consultar.ts` (16 escenarios, 18 aserciones), `npx tsx scripts/verificar-persistencia-planeacion.ts` y `npx tsx scripts/verificar-calculo-fechas-planeacion.ts` (regresión de los Pasos 1 y 2, ambos sin cambios), `npx tsc --noEmit`, `npx eslint` sobre los 5 archivos propios del paso, `git diff --check`, `git status --short` — repetidas antes del commit, todas limpias salvo 2 avisos preexistentes fuera de alcance (ver Resultado).
Resultado:
- 18/18 aserciones aprobadas: listado general; consulta sin registros; una planeación; varias planeaciones; filtro por trimestre; filtro por estado archivado; planeación actual; última planeación; búsqueda exacta por nombre; varias coincidencias por nombre (pide aclaración, nunca elige arbitrariamente); planeación inexistente por nombre (mensaje distinto de "no tienes ninguna" cuando sí existen otras — corrección de precisión aplicada durante la implementación); protección entre docentes; protección entre grupos; confirmación de cero escrituras; respuesta breve en canal de voz (detalle y lista, sin saltos de línea ni viñetas); frase pedagógica que menciona "planeación" sin pedir datos guardados (el dispatcher no la intercepta, `ejecutarHerramientaDeModulo` regresa `null`).
- Reutiliza exclusivamente `listarPlaneaciones`/`obtenerPlaneacionPorId` de `lib/planeacion/persistencia.ts` (Paso 2) — cero lógica de seguridad nueva; ambas funciones ya resuelven el docente real desde el cliente autenticado y ya filtran por `docente_id`/`grupo_id`. Cero `INSERT`/`UPDATE`/`DELETE` en el código nuevo (confirmado por revisión y por la prueba dedicada del caso 14). Sin `service_role`, sin cliente administrativo — se reutiliza siempre el cliente ya autenticado de la solicitud.
- 2 avisos de `eslint` detectados al validar los 5 archivos, ambos preexistentes y confirmados fuera de los hunks de este paso (por diff y por timestamp de archivo): `app/api/chat/route.ts:60` (`any` en código de RAG ya existente) y `lib/motorContexto.ts:625` (variable sin usar en `ejecutarRegistroEscolar`) — no se tocaron, fuera del alcance de esta tarea.
- Integración 100% aditiva: `ficha_descriptiva`, `planeacion_nueva`, `consultar_calendario`, asistencia, incidencias, consultas SEP y respuestas generales no se modificaron — confirmado por diff (único hunk en `route.ts` es la línea aditiva) y por revisión de las reglas 1-19 del clasificador (sin cambios).
- Paso 3B (creación de planeaciones desde el Chat IA, persistencia automática al aprobar) definido, pero NO iniciado.
Commit funcional aislado: `bb5f5f58b87d2d601d099e7c69edc49db0c3b276` — exactamente los 5 archivos listados arriba, sin push.
Pruebas: ver "Verificaciones ejecutadas" arriba — todas limpias, sin errores.
Incidencias: 1 — corte de conexión a mitad de la implementación; resuelto con una auditoría de recuperación completa antes de continuar (sin pérdida de trabajo, sin reversión, sin reinicio desde cero). 1 corrección de precisión aplicada durante la implementación (no un error posterior): el caso "búsqueda por nombre sin coincidencias" inicialmente reutilizaba el mismo mensaje que "sin ninguna planeación guardada" — se separó en un mensaje distinto para no ser engañoso cuando sí existen otras planeaciones.
Sin modificaciones funcionales fuera de alcance: confirmado — no se tocó Seguimiento, Lista, Calendario, Asistencia, la interfaz de Planeación, la base de datos ni políticas RLS; no se creó ningún registro real; no se ejecutó ninguna migración; no se incluyó ningún archivo ajeno en el commit; no se hizo push; no se inició el Paso 3B.
