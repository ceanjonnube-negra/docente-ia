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
