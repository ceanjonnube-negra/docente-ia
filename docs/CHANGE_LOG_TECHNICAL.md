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
