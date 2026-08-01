# Control del proyecto — Docente IA

Archivo de control permanente. Creado en el bloque C-001 (Consolidación y protección del estado actual), 2026-07-31. Ampliado en el bloque C-001B (Cierre documental e inventario maestro), 2026-08-01. Se actualiza al abrir y cerrar cada bloque de trabajo — nunca se reescribe desde cero; las secciones que quedan superadas se marcan como tales en vez de borrarse.

## Visión central de Docente IA

Aplicación móvil y web para docentes de educación básica en México. Objetivo: concentrar, organizar y aprovechar toda la información del grupo para ahorrar tiempo, evitar capturas repetidas y facilitar el seguimiento grupal e individual. Un dato se registra una sola vez y se reutiliza automáticamente en historial, estadísticas, reportes, fichas e IA. Lista es el centro del seguimiento grupal e individual. La IA usa datos reales de la aplicación, nunca inventa información.

## Regla de un solo Chat IA

El Chat IA es el cerebro central de la aplicación. Toda acción real que ejecuta pasa por uno de dos mecanismos, nunca un tercero sin justificación documentada:
1. **Clasificador de Nivel 0** (`lib/clasificadorNivel0.ts`) — determinista, para mensajes de texto. Cada intención nueva se agrega como una regla numerada ahí, con su handler en `app/api/chat/route.ts` (escrituras) o `lib/asistente/herramientasModulo.ts` (solo lectura, patrón `definir()`).
2. **Herramienta nativa de Claude** (`lib/registroEscolarTool.ts`, intent `registrar_dato_escolar`) — solo se activa cuando hay una imagen adjunta en el turno. No compite con el Clasificador de Nivel 0: el propio código documenta que texto plano siempre pasa por el Clasificador.

Antes de crear un tercer mecanismo, revisar si el caso realmente no cabe en los dos anteriores.

## Estado de Git (última verificación: C-001B, 2026-08-01)

- Rama: main
- Último commit: 63b9e0a — sincronizado con origin/main (verificado de nuevo con `git fetch` en C-001B, sin cambios remotos pendientes, no fue necesario otro push)
- Cambios sin commitear: ver "Control de cambios no consolidados" (Grupos A–D) más abajo
- Sin stashes, sin ramas adicionales

## Verificación de los archivos de control (C-001B)

- `docs/PROJECT_CONTROL.md`: existía desde C-001 (95 líneas), rastreado como no trackeado por Git (`??` en `git status`, nunca commiteado todavía), sin cambios pendientes de commit propios porque nunca se ha hecho el primer commit. Reflejaba el estado de cierre de C-001 pero no cumplía los requisitos de C-001B (sin inventario completo de módulos, sin lista maestra de pendientes con campos completos, sin priorización P0–P3, sin definición de C-002, sin organización explícita de Terminales 1–4, sin clasificación en Grupos A–D). Completado en este bloque.
- `docs/CHANGE_LOG_TECHNICAL.md`: existía desde C-001 (22 líneas, una sola entrada), también no trackeado por Git, sin cambios pendientes de commit propios. Reflejaba correctamente C-001. Se le agrega en este bloque una entrada nueva para C-001B (nunca se reescribe, solo se agrega al final).
- Ninguno de los dos archivos está commiteado todavía — ambos aparecen en `docs/` dentro de `Untracked files` en `git status`. El commit de ambos queda pendiente de autorización explícita (ver "Control de cambios no consolidados", Grupo D).

## Inventario maestro de módulos (C-001B)

Nota: la tabla breve "Estado de cada módulo conocido" que existía desde C-001 (más abajo) queda superada por este inventario, que es el exigido por C-001B. Se conserva la tabla anterior sin borrar, marcada como superada, por trazabilidad.

---

**Módulo:** Inicio y navegación
**Estado:** FUNCIONAL
**Funciones confirmadas:** `/dashboard` abre directo el panel del Chat IA (decisión arquitectónica deliberada, documentada en el propio código); la portada "Inicio" sigue disponible en `/dashboard/inicio` desde el menú lateral; alias legado `/dashboard/chat` redirige vía `next.config.ts`.
**Funciones parciales:** ninguna detectada.
**Errores conocidos:** ninguno detectado.
**Archivos principales:** `app/dashboard/page.tsx`, `app/dashboard/inicio/*`, `next.config.ts`.
**Datos o tablas utilizadas:** ninguna directa.
**Pruebas realizadas:** solo lectura de código en C-001B, sin prueba manual en navegador.
**Pruebas pendientes:** navegación real en dispositivo móvil.
**Riesgo:** bajo.
**Dependencias:** ninguna bloqueante.
**Próximo pendiente autorizado:** ninguno.

---

**Módulo:** Chat IA
**Estado:** FUNCIONAL CON VALIDACIÓN PENDIENTE
**Funciones confirmadas:** enrutamiento por `lib/clasificadorNivel0.ts` (262 líneas, reglas numeradas) hacia `app/api/chat/route.ts` (1554 líneas) para escritura y `lib/asistente/herramientasModulo.ts` para lectura; herramienta nativa `registrar_dato_escolar` (`lib/registroEscolarTool.ts`) para registro por imagen; consultas cruzadas entre módulos (commit `380230f`).
**Funciones parciales:** un cliente con `SUPABASE_SERVICE_ROLE_KEY` (`supabaseRAG`, líneas 29–31 de `app/api/chat/route.ts`) cuyo alcance real de escritura no se auditó a fondo en C-001B.
**Errores conocidos:** ninguno nuevo; ver ACC-005 a ACC-008 en la lista de pendientes.
**Archivos principales:** `app/api/chat/route.ts`, `lib/clasificadorNivel0.ts`, `lib/asistente/*` (15 archivos), `lib/registroEscolarTool.ts`.
**Datos o tablas utilizadas:** alumnos, asistencia_registro, incidencias, conversaciones (vía `lib/asistente/persistencia.ts`).
**Pruebas realizadas:** ninguna ejecutada en C-001B; pruebas previas en producción según historial de commits.
**Pruebas pendientes:** auditar el alcance de escritura del cliente con service role key.
**Riesgo:** medio.
**Dependencias:** Voz, Asistencia, Incidencias.
**Próximo pendiente autorizado:** ninguno (requiere ID nuevo si se decide auditar el cliente de service role key).

---

**Módulo:** Voz
**Estado:** FUNCIONAL CON VALIDACIÓN PENDIENTE
**Funciones confirmadas:** detección de fin de turno (`lib/asistente/deteccionFinTurno.ts`), motor realtime (`lib/asistente/motores/motorOpenAIRealtime.ts`), endpoint con autenticación fuerte ya existente (`app/api/realtime-token/route.ts`).
**Funciones parciales:** ajuste de tiempos de silencio (ACC-005) sin validar en dispositivo real.
**Errores conocidos:** ninguno abierto; más de 15 commits de ajustes recientes sugieren posible inestabilidad residual no descartada.
**Archivos principales:** `lib/asistente/deteccionFinTurno.ts`, `lib/asistente/motores/motorOpenAIRealtime.ts`, `app/api/realtime-token/route.ts`.
**Datos o tablas utilizadas:** ninguna directa (streaming de audio).
**Pruebas realizadas:** ninguna en dispositivo real documentada.
**Pruebas pendientes:** prueba manual en dispositivo real (ACC-005).
**Riesgo:** medio.
**Dependencias:** Chat IA.
**Próximo pendiente autorizado:** ninguno.

---

**Módulo:** Historial de conversaciones
**Estado:** FUNCIONAL (detalle interno NO VERIFICADO)
**Funciones confirmadas:** pantalla `app/dashboard/historial/page.tsx` (126 líneas) respaldada por `lib/asistente/persistencia.ts` y `tipos.ts`.
**Funciones parciales:** lógica interna no revisada a fondo en C-001B.
**Errores conocidos:** ninguno detectado en la pasada superficial.
**Archivos principales:** `app/dashboard/historial/page.tsx`, `lib/asistente/persistencia.ts`, `lib/asistente/tipos.ts`.
**Datos o tablas utilizadas:** conversaciones (tabla inferida, nombre exacto no confirmado).
**Pruebas realizadas:** ninguna.
**Pruebas pendientes:** lectura completa de la lógica de persistencia y prueba manual.
**Riesgo:** bajo-medio (no verificado).
**Dependencias:** Chat IA.
**Próximo pendiente autorizado:** ninguno.

---

**Módulo:** Lista de alumnos
**Estado:** PARCIAL (cambios sin consolidar)
**Funciones confirmadas:** listado general de alumnos del grupo (`app/dashboard/lista/page.tsx`, 597 líneas).
**Funciones parciales:** diff sin commitear con dos bloques de trabajo mezclados: botón "Eliminar lista completa" (Grupo B) y enlace de navegación hacia `/dashboard/lista/proyectos` (Grupo A / Seguimiento) — ver ACC-017.
**Errores conocidos:** ninguno funcional nuevo; el riesgo es de proceso (mezcla de commits), no de lógica.
**Archivos principales:** `app/dashboard/lista/page.tsx`.
**Datos o tablas utilizadas:** alumnos, grupos.
**Pruebas realizadas:** ninguna en C-001B.
**Pruebas pendientes:** separar y probar cada bloque de forma independiente tras dividir el diff.
**Riesgo:** medio (bloquea consolidación limpia de Grupo B).
**Dependencias:** Seguimiento (por la mezcla del diff).
**Próximo pendiente autorizado:** ninguno (ACC-017 sin bloque asignado todavía).

---

**Módulo:** Ficha individual del alumno
**Estado:** FUNCIONAL CON RIESGO DE ETIQUETA ENGAÑOSA
**Funciones confirmadas:** ficha completa (`app/dashboard/lista/[alumnoId]/page.tsx`, 1054 líneas): asistencia, incidencias, evaluaciones, generación de ficha descriptiva.
**Funciones parciales:** diff sin commitear renombra la pestaña "Evaluación" a "Seguimiento" sin conectar ninguna lógica real al módulo Seguimiento nuevo.
**Errores conocidos:** si se despliega el renombrado sin la conexión real, genera una expectativa falsa en el docente (ver ACC-013).
**Archivos principales:** `app/dashboard/lista/[alumnoId]/page.tsx`.
**Datos o tablas utilizadas:** alumnos, asistencia_registro, incidencias, evaluaciones.
**Pruebas realizadas:** ninguna en C-001B más allá de lectura del diff.
**Pruebas pendientes:** decidir y validar la etiqueta correcta antes de commitear.
**Riesgo:** medio (experiencia de usuario, no de datos).
**Dependencias:** Seguimiento, Evaluación.
**Próximo pendiente autorizado:** ninguno (parte de ACC-013).

---

**Módulo:** Asistencia
**Estado:** FUNCIONAL
**Funciones confirmadas:** función compartida `escribirAsistencia` (`lib/motorContexto.ts`, 903 líneas) usada tanto por Lista como por Chat IA; endpoint `app/api/asistencia-guardar/route.ts` (68 líneas) con patrón RLS-scoped por `access_token`; corrección de zona horaria documentada en comentario para evitar registrar el día equivocado cerca de medianoche.
**Funciones parciales:** normalización de estados con fallback silencioso a "presente" cuando el valor recibido es inválido — ver ACC-016.
**Errores conocidos:** ver ACC-016.
**Archivos principales:** `lib/motorContexto.ts`, `app/api/asistencia-guardar/route.ts`.
**Datos o tablas utilizadas:** asistencia_registro.
**Pruebas realizadas:** ninguna en C-001B (solo lectura).
**Pruebas pendientes:** confirmar si el fallback silencioso es intencional o un bug latente.
**Riesgo:** bajo-medio.
**Dependencias:** Chat IA, Lista de alumnos.
**Próximo pendiente autorizado:** ninguno (ACC-016 nuevo, sin bloque asignado).

---

**Módulo:** Incidencias
**Estado:** FUNCIONAL
**Funciones confirmadas:** registro de incidencias desde Chat IA Nivel 2 (commit `ec9c91e`), redacción de `descripcion_incidencia` antes de guardar (commit `fe73eba`).
**Funciones parciales:** validación real en producción de ACC-006 todavía pendiente según registro previo.
**Errores conocidos:** ninguno nuevo.
**Archivos principales:** `lib/motorContexto.ts`, `lib/asistente/herramientasModulo.ts`, `lib/clasificadorNivel0.ts`.
**Datos o tablas utilizadas:** incidencias.
**Pruebas realizadas:** probado en producción según historial (ACC-003, ACC-004).
**Pruebas pendientes:** validación real de ACC-006.
**Riesgo:** bajo.
**Dependencias:** Chat IA, Ficha individual del alumno.
**Próximo pendiente autorizado:** ninguno.

---

**Módulo:** Planeación
**Estado:** NO IMPLEMENTADO
**Funciones confirmadas:** ninguna.
**Funciones parciales:** ninguna.
**Errores conocidos:** `app/dashboard/planeacion/page.tsx` es un stub de 34 líneas que muestra "Próximamente"; un comentario indica que es un módulo independiente, pero solo cierra el panel del Chat IA sin generar nada.
**Archivos principales:** `app/dashboard/planeacion/page.tsx`.
**Datos o tablas utilizadas:** ninguna.
**Pruebas realizadas:** no aplica.
**Pruebas pendientes:** no aplica hasta que exista implementación.
**Riesgo:** nulo.
**Dependencias:** ninguna.
**Próximo pendiente autorizado:** ninguno — fuera de Sprint 1 (Lista) según CLAUDE.md.

---

**Módulo:** Generación de documentos
**Estado:** FUNCIONAL
**Funciones confirmadas:** generación de PDF/XLSX/PPTX/Word (`lib/documentGen/`, 11 archivos, ~1374 líneas); confirmado por commits reales (`72d1a02`, `63b9e0a`).
**Funciones parciales:** ninguna detectada en la lógica base.
**Errores conocidos:** ninguno abierto.
**Archivos principales:** `lib/documentGen/*`, incluyendo `almacenamiento.ts` (modificado sin commitear — Grupo A, soporte de un segundo bucket de Storage para Seguimiento).
**Datos o tablas utilizadas:** Storage de Supabase (buckets de documentos).
**Pruebas realizadas:** probado en producción según historial de commits.
**Pruebas pendientes:** probar el cambio sin commitear en `almacenamiento.ts` una vez separado de Seguimiento.
**Riesgo:** bajo.
**Dependencias:** Chat IA (tarjetas y descarga).
**Próximo pendiente autorizado:** ninguno.

---

**Módulo:** Tarjetas y descarga de documentos
**Estado:** FUNCIONAL
**Funciones confirmadas:** reconocimiento de intención de descarga ("link"/"descarga") corregido y en main (commit `63b9e0a`).
**Funciones parciales:** ninguna.
**Errores conocidos:** ninguno abierto.
**Archivos principales:** `lib/asistente/documentos.ts`.
**Datos o tablas utilizadas:** ninguna directa (usa Storage vía Generación de documentos).
**Pruebas realizadas:** probado en producción según historial reciente.
**Pruebas pendientes:** ninguna conocida.
**Riesgo:** bajo.
**Dependencias:** Generación de documentos, Chat IA.
**Próximo pendiente autorizado:** ninguno.

---

**Módulo:** Seguimiento
**Estado:** BLOQUEADO (seguridad + migración sin verificar)
**Funciones confirmadas:** creación de proyectos de seguimiento (`POST /api/proyectos-seguimiento`); sugerencia de indicadores con autenticación fuerte real vía `access_token` + `auth.getUser()` (`POST /api/proyectos-seguimiento/sugerir-indicadores`, línea 53); generación de hoja/PDF (`POST /api/proyectos-seguimiento/[id]/hoja`).
**Funciones parciales:** pantallas `app/dashboard/lista/proyectos/page.tsx` y `.../nuevo/page.tsx` sin commitear.
**Errores conocidos:** IDOR confirmado con línea exacta — ver "Hallazgo de seguridad crítico" abajo y ACC-013.
**Archivos principales:** `app/api/proyectos-seguimiento/route.ts`, `app/api/proyectos-seguimiento/sugerir-indicadores/route.ts`, `app/api/proyectos-seguimiento/[id]/hoja/route.ts`, `lib/seguimiento/tipos.ts`, `migrations/seguimiento_fase3.sql`, `app/dashboard/lista/proyectos/*`.
**Datos o tablas utilizadas:** tabla(s) definidas en `migrations/seguimiento_fase3.sql` (no verificable si ya existen en Supabase real), `perfiles_docentes`.
**Pruebas realizadas:** ninguna prueba funcional; solo revisión de seguridad de código (C-001 y C-001B).
**Pruebas pendientes:** confirmar si la migración ya se aplicó; pruebas de autorización cruzada tras la corrección (C-002).
**Riesgo:** crítico (P0).
**Dependencias:** Lista de alumnos (diff mezclado), Evaluación (decisión de etiqueta), Base de datos (estado de la migración).
**Próximo pendiente autorizado:** ninguno todavía — C-002 queda definido pero no ejecutado.

---

**Módulo:** Evaluación
**Estado:** FUNCIONAL (aislado de Seguimiento)
**Funciones confirmadas:** la pestaña "Evaluación" de la ficha del alumno sigue leyendo la tabla `evaluaciones` preexistente, sin ninguna conexión al módulo Seguimiento nuevo.
**Funciones parciales:** ninguna.
**Errores conocidos:** riesgo de que el renombrado de etiqueta (ver Ficha individual del alumno) genere confusión con el módulo Seguimiento.
**Archivos principales:** `app/dashboard/lista/[alumnoId]/page.tsx` (pestaña Evaluación).
**Datos o tablas utilizadas:** evaluaciones.
**Pruebas realizadas:** ninguna en C-001B.
**Pruebas pendientes:** ninguna nueva.
**Riesgo:** bajo en su lógica actual; medio en percepción del usuario si se despliega el renombrado.
**Dependencias:** Ficha individual del alumno, Seguimiento (solo por la etiqueta).
**Próximo pendiente autorizado:** ninguno.

---

**Módulo:** Reportes de evaluación
**Estado:** PARCIAL / NO VERIFICADO
**Funciones confirmadas:** pantalla `app/dashboard/periodos-evaluacion/page.tsx` (99 líneas) y endpoint `app/api/periodos-evaluacion/route.ts` (43 líneas).
**Funciones parciales:** alcance real de "reportes" no confirmado a fondo.
**Errores conocidos:** `app/api/periodos-evaluacion/route.ts` no muestra ningún patrón de autenticación visible en una revisión superficial — ver ACC-015 (no confirmado como vulnerabilidad, requiere lectura completa).
**Archivos principales:** `app/dashboard/periodos-evaluacion/page.tsx`, `app/api/periodos-evaluacion/route.ts`.
**Datos o tablas utilizadas:** no confirmadas.
**Pruebas realizadas:** ninguna.
**Pruebas pendientes:** lectura completa del endpoint (ACC-015).
**Riesgo:** no verificado (potencialmente medio-alto hasta confirmar).
**Dependencias:** Evaluación, Ciclo escolar.
**Próximo pendiente autorizado:** ninguno.

---

**Módulo:** Fichas descriptivas
**Estado:** FUNCIONAL
**Funciones confirmadas:** generación de ficha descriptiva con patrón RLS-scoped (`access_token`) en `app/api/generar-ficha-descriptiva/route.ts` (89 líneas), consumido desde la ficha individual del alumno.
**Funciones parciales:** visión de convertir esta pestaña en un asistente de redacción con IA (ver memoria de proyecto ficha_descriptiva_ia) sigue sin implementarse.
**Errores conocidos:** ninguno detectado.
**Archivos principales:** `app/api/generar-ficha-descriptiva/route.ts`.
**Datos o tablas utilizadas:** alumnos, asistencia_registro, incidencias, evaluaciones.
**Pruebas realizadas:** ninguna en C-001B.
**Pruebas pendientes:** ninguna nueva conocida.
**Riesgo:** bajo.
**Dependencias:** Ficha individual del alumno.
**Próximo pendiente autorizado:** ninguno (la visión de asistente IA queda fuera de Sprint 1).

---

**Módulo:** Datos de escuela y grupo
**Estado:** FUNCIONAL
**Funciones confirmadas:** alta de grupo (`app/dashboard/grupos/nuevo/page.tsx`, 457 líneas), configuración inicial (`app/dashboard/grupos/[id]/configuracion-inicial/page.tsx`, 139 líneas), resolución de institución del docente vía `perfiles_docentes.institucion_id` + `docente_instituciones`.
**Funciones parciales:** ninguna detectada.
**Errores conocidos:** ninguno detectado.
**Archivos principales:** `app/dashboard/grupos/nuevo/page.tsx`, `app/dashboard/grupos/[id]/configuracion-inicial/page.tsx`, `lib/server/authApi.ts`.
**Datos o tablas utilizadas:** perfiles_docentes, docente_instituciones, grupos.
**Pruebas realizadas:** ninguna en C-001B.
**Pruebas pendientes:** ninguna nueva conocida.
**Riesgo:** bajo.
**Dependencias:** Importación de alumnos, Ciclo escolar.
**Próximo pendiente autorizado:** ninguno.

---

**Módulo:** Ciclo escolar
**Estado:** FUNCIONAL (detalle fino NO VERIFICADO)
**Funciones confirmadas:** calendario (`app/dashboard/calendario/page.tsx`, 720 líneas), análisis y aplicación de calendario (`app/api/calendario/analizar/route.ts`, `app/api/calendario/aplicar/route.ts`), `lib/tiempo/TimeService.ts`.
**Funciones parciales:** profundidad de prueba no verificada en C-001B.
**Errores conocidos:** ninguno detectado en la pasada superficial.
**Archivos principales:** `app/dashboard/calendario/page.tsx`, `app/api/calendario/analizar/route.ts`, `app/api/calendario/aplicar/route.ts`, `lib/tiempo/TimeService.ts`.
**Datos o tablas utilizadas:** no confirmadas a fondo.
**Pruebas realizadas:** existe un script manual (`verificar:calendario` en `package.json`).
**Pruebas pendientes:** revisión más profunda del endpoint y prueba manual completa.
**Riesgo:** bajo-medio (no verificado).
**Dependencias:** Datos de escuela y grupo, Asistencia.
**Próximo pendiente autorizado:** ninguno.

---

**Módulo:** Importación de alumnos
**Estado:** FUNCIONAL (con corrección de nomenclatura respecto a C-001)
**Funciones confirmadas:** `app/api/importar-alumnos/route.ts` (207+ líneas) es el endpoint real y activo, con autenticación fuerte (Fase 1A) vía `lib/server/authApi.ts` (`autenticarRequestApi`, header Bearer, `auth.getUser()`).
**Funciones parciales:** ninguna en el endpoint activo.
**Errores conocidos:** CORRECCIÓN AL REGISTRO DE C-001 — el texto anterior de este documento afirmaba que el patrón de vulnerabilidad de Seguimiento "ya fue corregido antes... para `app/api/importar-datos-alumnos/route.ts`". Verificado como impreciso en C-001B: ese archivo (con "-datos-" en el nombre) no fue corregido, fue **descontinuado por completo** — retorna HTTP 410, confirmado sin consumidores en `app/`, `components/` ni `lib/`. El endpoint que sí recibió la corrección real de autorización es `app/api/importar-alumnos/route.ts` (sin "-datos-"). Ver ACC-014.
**Archivos principales:** `app/api/importar-alumnos/route.ts` (activo), `app/api/importar-datos-alumnos/route.ts` (descontinuado, 41 líneas, retorna 410; su único cambio sin commitear es el comentario que documenta por qué se deshabilitó y el hallazgo de CURP truncado).
**Datos o tablas utilizadas:** alumnos, grupos.
**Pruebas realizadas:** ninguna en C-001B más allá de lectura completa de ambos archivos.
**Pruebas pendientes:** ninguna nueva sobre el endpoint activo.
**Riesgo:** bajo en el endpoint activo; nulo en el descontinuado.
**Dependencias:** Datos de escuela y grupo, Calidad e integridad de datos (CURP truncado).
**Próximo pendiente autorizado:** ninguno (ACC-014 es documental, ya cerrado en este bloque).

---

**Módulo:** Calidad e integridad de datos
**Estado:** EN DESARROLLO
**Funciones confirmadas:** `lib/curp.ts` (29 líneas, nuevo sin commitear) deriva `fecha_nacimiento` desde el CURP con corte de siglo 00–30→20xx / 31–99→19xx y rechaza fechas imposibles.
**Funciones parciales:** `consulta_11.sql` (30 líneas, no leído a fondo en C-001B); 16 de 28 alumnos del grupo 3°B ya corregidos directamente en Supabase, 7 casos de revisión manual con acta siguen abiertos (ACC-011).
**Errores conocidos:** bug de CURP truncado documentado en comentario de `app/api/importar-datos-alumnos/route.ts` — 8 de 9 CURP con problema de formato tenían 17 caracteres en vez de 18 (patrón determinista, no error humano aislado); 2 casos adicionales con "0" en vez de "O" en la segunda posición (confusión de OCR).
**Archivos principales:** `lib/curp.ts`, `consulta_11.sql`.
**Datos o tablas utilizadas:** alumnos (campos curp, fecha_nacimiento, sexo).
**Pruebas realizadas:** ninguna automatizada; corrección manual directa en Supabase para 16 de 28 casos.
**Pruebas pendientes:** completar los 7 casos con revisión de acta; leer `consulta_11.sql` a fondo.
**Riesgo:** medio (integridad de datos, no seguridad).
**Dependencias:** Importación de alumnos.
**Próximo pendiente autorizado:** ninguno (ACC-011 sin bloque asignado).

---

**Módulo:** Integración SEP
**Estado:** PARCIAL
**Funciones confirmadas:** herramienta de consulta de fuentes oficiales SEP registrada en el Chat IA (commit `31e76dc`, `lib/fuentesOficiales.ts`).
**Funciones parciales:** sin evidencia de sincronización real con sistemas SEP (SIGED/CCT); solo consulta de fuentes oficiales dentro del Chat IA, sin pantalla propia.
**Errores conocidos:** ninguno detectado.
**Archivos principales:** `lib/fuentesOficiales.ts`.
**Datos o tablas utilizadas:** ninguna propia (consulta externa).
**Pruebas realizadas:** ninguna en C-001B.
**Pruebas pendientes:** ninguna nueva conocida.
**Riesgo:** bajo.
**Dependencias:** Chat IA.
**Próximo pendiente autorizado:** ninguno.

---

**Módulo:** Seguridad
**Estado:** CON REGRESIÓN (patrón localizado, no generalizado)
**Funciones confirmadas:** 3 endpoints con validación fuerte explícita (`auth.getUser()` o `autenticarRequestApi`): `app/api/realtime-token/route.ts`, `app/api/importar-alumnos/route.ts`, y un endpoint de subida de documentos (nombre exacto a confirmar en C-002). Aproximadamente 8 endpoints usan un cliente Supabase por-request con `access_token` (anon key + header `Authorization: Bearer`), delegando la autorización a RLS: `asistencia-guardar`, `generar-ficha-descriptiva`, `calendario/aplicar`, `calendario/analizar`, los 3 de `proyectos-seguimiento`, `chat/route.ts` (parcial). Este patrón es legítimo solo si las políticas RLS de esas tablas restringen realmente por `auth.uid()` — no verificable sin acceso a Supabase.
**Funciones parciales:** cobertura de autenticación no confirmada en la totalidad de `app/api/`.
**Errores conocidos:** IDOR confirmado con línea exacta en los 2 endpoints de Seguimiento (ver "Hallazgo de seguridad crítico"); `app/api/periodos-evaluacion/route.ts` y `app/api/ocr-foto/route.ts` sin patrón de autenticación visible en grep superficial (NO VERIFICADO, no confirmado como vulnerabilidad — ACC-015).
**Archivos principales:** `lib/server/authApi.ts` (patrón de referencia correcto), los endpoints listados arriba.
**Datos o tablas utilizadas:** depende de cada endpoint.
**Pruebas realizadas:** grep dirigido sobre patrones de autenticación (`getUser`, `docente_id`) en los endpoints de Seguimiento e importación; no se leyó el cuerpo completo de `periodos-evaluacion` ni `ocr-foto`.
**Pruebas pendientes:** lectura completa de `periodos-evaluacion/route.ts` y `ocr-foto/route.ts`; confirmación de las políticas RLS reales en Supabase.
**Riesgo:** crítico en Seguimiento (P0); no verificado (potencialmente alto) en `periodos-evaluacion` y `ocr-foto`.
**Dependencias:** Base de datos (RLS real), todos los módulos con endpoints en `app/api/`.
**Próximo pendiente autorizado:** ninguno todavía — C-002 cubre solo los 2 endpoints confirmados de Seguimiento.

---

**Módulo:** Base de datos
**Estado:** NO VERIFICADO
**Funciones confirmadas:** ninguna verificable sin credenciales reales de Supabase (`NEXT_PUBLIC_SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` vacíos en este entorno, confirmado en C-001).
**Funciones parciales:** una sola migración existe en el repositorio: `migrations/seguimiento_fase3.sql`; no se sabe si ya se aplicó contra la base real.
**Errores conocidos:** estado de la migración desconocido (bloqueante para cerrar Seguimiento).
**Archivos principales:** `migrations/seguimiento_fase3.sql`.
**Datos o tablas utilizadas:** las definidas en esa migración (no verificadas contra el estado real).
**Pruebas realizadas:** ninguna (sin credenciales).
**Pruebas pendientes:** verificación del estado real de Supabase antes de cualquier migración futura.
**Riesgo:** incierto — tratar como potencialmente crítico hasta verificar (contribuye al P0 de Seguimiento).
**Dependencias:** Seguimiento.
**Próximo pendiente autorizado:** ninguno — Terminal 4 permanece en solo lectura hasta instrucción explícita.

---

**Módulo:** Despliegue y producción
**Estado:** FUNCIONAL (detalle NO VERIFICADO)
**Funciones confirmadas:** configuración por defecto de Vercel (sin `vercel.json` ni `vercel.ts` en el repo); `next.config.ts` con un redirect documentado (alias `/dashboard/chat`); scripts en `package.json`: `dev`, `build`, `start`, `lint`, más 3 scripts de verificación manual (`verificar:adjuntos-nativos`, `verificar:calendario`, `verificar:multiples-imagenes`).
**Funciones parciales:** no hay test runner automatizado, solo scripts de verificación manual.
**Errores conocidos:** ninguno detectado.
**Archivos principales:** `next.config.ts`, `package.json`.
**Datos o tablas utilizadas:** no aplica.
**Pruebas realizadas:** ninguna en C-001B.
**Pruebas pendientes:** ninguna nueva conocida.
**Riesgo:** bajo.
**Dependencias:** todos los módulos, indirectamente.
**Próximo pendiente autorizado:** ninguno.

---

## Estado de cada módulo conocido (tabla de C-001 — SUPERADA por el inventario completo de arriba, se conserva por trazabilidad)

| Módulo | Estado |
|---|---|
| Lista / Asistencia | Sprint LISTA DE ALUMNOS casi cerrado — pendiente validación manual de Diseño/Responsive en dispositivo real |
| Chat IA — asistencia | Estable, con varias correcciones ya probadas en producción (ver ACC-001 a ACC-004 del registro de acciones) |
| Chat IA — incidencias | Implementado y probado en producción (ACC-003, ACC-004, ACC-006 — este último con validación real todavía pendiente) |
| Chat IA — voz | Estable, ajuste de silencios aplicado (ACC-005) sin validar en dispositivo real todavía |
| Chat IA — registro por imagen (registrar_dato_escolar) | Implementado (ACC-007, ACC-008), sin evidencia de prueba real en producción |
| Chat IA — alta/baja de alumnos por foto | Solo planeado (ACC-010), cero código escrito |
| Calidad de datos (CURP / fechas de nacimiento) | En progreso — 16 de 28 alumnos del grupo 3°B ya corregidos directamente en Supabase; 7 casos de revisión manual con acta siguen abiertos; código de soporte (`lib/curp.ts`) sin commitear (ACC-011) |
| Módulo Seguimiento | Desarrollo sustancial sin commitear al momento de C-001 — ver hallazgos de seguridad y de migración (ACC-013). Bloqueado para consolidar |

## Hallazgo de seguridad crítico — módulo Seguimiento (P0)

Dos de los tres endpoints nuevos reciben `docente_id` directo del cuerpo de la petición y lo usan sin verificarlo contra el usuario real del `access_token` (nunca llaman a `supabase.auth.getUser()`):

- `POST /api/proyectos-seguimiento` (`app/api/proyectos-seguimiento/route.ts`, línea 88): inserta `docente_id` tal cual llega del body en la fila nueva.
- `POST /api/proyectos-seguimiento/[id]/hoja` (`app/api/proyectos-seguimiento/[id]/hoja/route.ts`, línea 69): hace `.eq('id', docente_id)` contra `perfiles_docentes` con el `docente_id` del body; línea 116: construye la ruta de Storage del PDF generado con ese mismo `docente_id` sin verificar.

Es un IDOR real: cualquier docente autenticado puede suplantar el `docente_id` de otro para crear registros a su nombre, leer su perfil, y generar/almacenar un PDF con el roster de su grupo en la ruta de Storage de ese docente. Riesgo alto a crítico.

El tercer endpoint, `app/api/proyectos-seguimiento/sugerir-indicadores/route.ts` (línea 53), **sí** llama a `supabase.auth.getUser()` y no tiene este problema — confirmado por lectura directa, no repetir su revisión.

**Corrección al registro de C-001:** el patrón correcto ya usado en el proyecto para resolver este tipo de problema está en `app/api/importar-alumnos/route.ts` (vía `lib/server/authApi.ts` / `autenticarRequestApi`), **no** en `app/api/importar-datos-alumnos/route.ts` como decía la versión anterior de este documento — ese archivo fue descontinuado (HTTP 410), no corregido. Ver ACC-014.

No se corrigió durante C-001 ni C-001B (fuera de su alcance autorizado) — queda como bloqueante explícito, definido en detalle en "Bloque actual y siguiente bloque" (C-002).

## Lista maestra de pendientes (ACC-001 a ACC-017)

Los identificadores ACC-001, ACC-002, ACC-009 y ACC-012 existían como huecos en el registro heredado de C-001 (el archivo temporal de auditoría original, `/tmp/AUDITORIA_DOCENTE_IA.md`, ya no existe en este entorno). Se conservan los IDs, sin inventar contenido:

**ID:** ACC-001
**Nombre:** Detalle original no recuperable
**Módulo:** desconocido
**Tipo:** DOCUMENTACIÓN
**Estado:** NO VERIFICADO
**Prioridad:** P3
**Riesgo:** bajo (riesgo documental, no funcional)
**Archivos:** N/A
**Dependencias:** N/A
**Trabajo ya realizado:** ninguno confirmable
**Trabajo pendiente:** si aparece evidencia nueva (commit, comentario, respaldo), reconstruir este identificador
**Pruebas realizadas:** N/A
**Pruebas pendientes:** N/A
**Criterio de aceptación:** N/A hasta reconstruir con evidencia real
**Bloque recomendado:** ninguno
**No repetir:** no inventar contenido para rellenar este ID.

**ID:** ACC-002 — mismos campos que ACC-001 (detalle original no recuperable).

**ID:** ACC-003
**Nombre:** Correcciones de asistencia desde Chat IA
**Módulo:** Chat IA / Asistencia
**Tipo:** FUNCIÓN NUEVA
**Estado:** FUNCIONAL (cerrado)
**Prioridad:** P3 (ya cerrado, solo referencia)
**Riesgo:** bajo
**Archivos:** `lib/motorContexto.ts` (inferido)
**Dependencias:** Chat IA
**Trabajo ya realizado:** implementado y probado en producción según registro de C-001
**Trabajo pendiente:** ninguno conocido
**Pruebas realizadas:** en producción (cita textual de C-001)
**Pruebas pendientes:** ninguna
**Criterio de aceptación:** ya cumplido según registro previo
**Bloque recomendado:** ninguno (cerrado)
**No repetir:** no reimplementar sin revisar `lib/motorContexto.ts` primero.

**ID:** ACC-004 — mismo módulo y patrón que ACC-003 (corrección adicional de asistencia/incidencias probada en producción); detalle exacto no recuperable más allá de la cita de C-001, no inventar contenido adicional.

**ID:** ACC-005
**Nombre:** Ajuste de tiempos de silencio en dictado de voz
**Módulo:** Voz
**Tipo:** VALIDACIÓN
**Estado:** FUNCIONAL CON VALIDACIÓN PENDIENTE
**Prioridad:** P2
**Riesgo:** medio
**Archivos:** `lib/asistente/deteccionFinTurno.ts`, commit `ac69cc2`
**Dependencias:** Chat IA
**Trabajo ya realizado:** ajuste de `silencioFraseCompletaMs`/`silencioFraseIncompletaMs` aplicado y en main
**Trabajo pendiente:** prueba manual en dispositivo real
**Pruebas realizadas:** ninguna en dispositivo real documentada
**Pruebas pendientes:** sesión de dictado real de extremo a extremo
**Criterio de aceptación:** dictado sin cortes prematuros confirmado por el usuario en dispositivo real
**Bloque recomendado:** bloque de pruebas dedicado (Terminal 3) cuando el usuario lo indique
**No repetir:** no volver a ajustar los tiempos de silencio sin antes probar los valores actuales en dispositivo real.

**ID:** ACC-006
**Nombre:** Validación real de incidencias Nivel 2
**Módulo:** Incidencias / Chat IA
**Tipo:** VALIDACIÓN
**Estado:** FUNCIONAL CON VALIDACIÓN PENDIENTE
**Prioridad:** P2
**Riesgo:** bajo
**Archivos:** `lib/motorContexto.ts`, `lib/clasificadorNivel0.ts`
**Dependencias:** Chat IA, Ficha individual del alumno
**Trabajo ya realizado:** implementado, ver commit `ec9c91e`
**Trabajo pendiente:** validación real en producción
**Pruebas realizadas:** ninguna real documentada
**Pruebas pendientes:** confirmación del docente de que una incidencia registrada aparece correctamente en la ficha del alumno
**Criterio de aceptación:** confirmación real del docente
**Bloque recomendado:** Terminal 3 cuando se autorice
**No repetir:** no reimplementar sin revisar el flujo ya existente.

**ID:** ACC-007
**Nombre:** Registro de datos escolares desde imagen
**Módulo:** Chat IA
**Tipo:** FUNCIÓN NUEVA
**Estado:** FUNCIONAL CON VALIDACIÓN PENDIENTE
**Prioridad:** P2
**Riesgo:** bajo
**Archivos:** `lib/registroEscolarTool.ts`, commit `0cede69`
**Dependencias:** Chat IA
**Trabajo ya realizado:** herramienta `registrar_dato_escolar` implementada
**Trabajo pendiente:** prueba real con imagen en producción
**Pruebas realizadas:** ninguna real documentada
**Pruebas pendientes:** prueba con foto real de documento
**Criterio de aceptación:** una foto real registra el dato correcto en el alumno correcto
**Bloque recomendado:** Terminal 3 cuando se autorice
**No repetir:** no confundir con ACC-010 (alta de alumnos nuevos, no cubierto aquí).

**ID:** ACC-008
**Nombre:** Resolución de alumno por nombre real del grupo (fuzzy match)
**Módulo:** Chat IA
**Tipo:** FUNCIÓN NUEVA
**Estado:** FUNCIONAL CON VALIDACIÓN PENDIENTE
**Prioridad:** P2
**Riesgo:** bajo
**Archivos:** commit `be73e15`
**Dependencias:** ACC-007
**Trabajo ya realizado:** `registrar_dato_escolar` resuelve `alumno_id` por nombre real del grupo con fuzzy match
**Trabajo pendiente:** prueba real en producción (compartida con ACC-007)
**Pruebas realizadas:** ninguna real documentada
**Pruebas pendientes:** casos con nombres ambiguos o mal escritos
**Criterio de aceptación:** resolución correcta del alumno incluso con variaciones de escritura
**Bloque recomendado:** Terminal 3 cuando se autorice
**No repetir:** no reimplementar el fuzzy match sin revisar el commit existente.

**ID:** ACC-009 — mismos campos que ACC-001 (detalle original no recuperable).

**ID:** ACC-010
**Nombre:** Alta/baja de alumnos por foto
**Módulo:** Chat IA / Lista de alumnos
**Tipo:** FUNCIÓN NUEVA
**Estado:** NO IMPLEMENTADO
**Prioridad:** P3
**Riesgo:** nulo (no implementado)
**Archivos:** ninguno todavía (cero código escrito)
**Dependencias:** ninguna confirmada
**Trabajo ya realizado:** solo planeación, según cita de C-001; la ubicación exacta del plan escrito no se confirmó en C-001B — localizarla antes de retomar
**Trabajo pendiente:** todo
**Pruebas realizadas:** N/A
**Pruebas pendientes:** N/A hasta implementación
**Criterio de aceptación:** no definido todavía
**Bloque recomendado:** ninguno asignado
**No repetir:** no volver a planear desde cero sin antes localizar y leer el plan ya existente.

**ID:** ACC-011
**Nombre:** Corrección de CURP / fecha de nacimiento del grupo 3°B
**Módulo:** Calidad e integridad de datos
**Tipo:** DATOS
**Estado:** EN DESARROLLO
**Prioridad:** P2
**Riesgo:** medio
**Archivos:** `lib/curp.ts`, `consulta_11.sql`
**Dependencias:** Importación de alumnos
**Trabajo ya realizado:** 16 de 28 alumnos corregidos directamente en Supabase; `lib/curp.ts` escrito (sin commit)
**Trabajo pendiente:** 7 casos con revisión manual de acta; commitear `lib/curp.ts`; revisar el bug de CURP truncado (8/9 casos con 17 caracteres) antes de reactivar cualquier importación por OCR
**Pruebas realizadas:** ninguna automatizada
**Pruebas pendientes:** validación de los 7 casos restantes
**Criterio de aceptación:** 28/28 alumnos del grupo 3°B con fecha de nacimiento correcta y verificable
**Bloque recomendado:** bloque de Datos independiente (Grupo C)
**No repetir:** no reactivar `app/api/importar-datos-alumnos/route.ts` sin corregir primero el truncamiento de CURP.

**ID:** ACC-012 — mismos campos que ACC-001 (detalle original no recuperable).

**ID:** ACC-013
**Nombre:** Vulnerabilidad IDOR en endpoints de Seguimiento
**Módulo:** Seguimiento / Seguridad
**Tipo:** SEGURIDAD
**Estado:** BLOQUEADO
**Prioridad:** P0
**Riesgo:** crítico
**Archivos:** `app/api/proyectos-seguimiento/route.ts` (línea 88), `app/api/proyectos-seguimiento/[id]/hoja/route.ts` (líneas 69 y 116)
**Dependencias:** Base de datos (estado de la migración), Lista de alumnos (diff mezclado), Evaluación (etiqueta)
**Trabajo ya realizado:** hallazgo documentado en C-001, confirmado con línea exacta en C-001B; respaldo externo completo del módulo
**Trabajo pendiente:** corrección de autorización (C-002); confirmación de la migración; decisión de la etiqueta Evaluación/Seguimiento
**Pruebas realizadas:** ninguna funcional; solo revisión de código (dos veces)
**Pruebas pendientes:** prueba de autorización cruzada tras la corrección
**Criterio de aceptación:** ver definición de C-002 abajo
**Bloque recomendado:** C-002
**No repetir:** no corregir "copiando el patrón de `app/api/importar-datos-alumnos/route.ts`" — ese archivo fue descontinuado, no corregido (ver ACC-014); el patrón correcto es el de `app/api/importar-alumnos/route.ts` + `lib/server/authApi.ts`.

**ID:** ACC-014
**Nombre:** Corregir confusión de nombres entre importar-alumnos e importar-datos-alumnos en la documentación
**Módulo:** Importación de alumnos / Documentación
**Tipo:** DOCUMENTACIÓN
**Estado:** FUNCIONAL (ya corregido en este documento)
**Prioridad:** P1
**Riesgo:** medio (riesgo de que C-002 copie un patrón equivocado si no se corrige a tiempo)
**Archivos:** `docs/PROJECT_CONTROL.md`, `app/api/importar-alumnos/route.ts`, `app/api/importar-datos-alumnos/route.ts`
**Dependencias:** ACC-013 / C-002
**Trabajo ya realizado:** corrección aplicada en el inventario del módulo Importación de alumnos y en el "Hallazgo de seguridad crítico" de este mismo documento (C-001B)
**Trabajo pendiente:** ninguno adicional
**Pruebas realizadas:** confirmación por lectura completa de ambos archivos
**Pruebas pendientes:** ninguna
**Criterio de aceptación:** cumplido — este documento ya referencia el archivo correcto
**Bloque recomendado:** cerrado en C-001B
**No repetir:** no volver a citar `app/api/importar-datos-alumnos/route.ts` como ejemplo de corrección de autorización.

**ID:** ACC-015
**Nombre:** Verificar patrón de autenticación en periodos-evaluacion y ocr-foto
**Módulo:** Reportes de evaluación / Seguridad
**Tipo:** SEGURIDAD
**Estado:** NO VERIFICADO
**Prioridad:** P1
**Riesgo:** no verificado, tratar como potencialmente alto
**Archivos:** `app/api/periodos-evaluacion/route.ts`, `app/api/ocr-foto/route.ts`
**Dependencias:** módulo Seguridad
**Trabajo ya realizado:** grep superficial sin encontrar patrón de autenticación visible
**Trabajo pendiente:** lectura completa de ambos archivos y confirmación de si usan cliente RLS-scoped, `autenticarRequestApi`, o ningún control
**Pruebas realizadas:** ninguna más allá del grep
**Pruebas pendientes:** lectura completa; prueba de acceso cruzado si se confirma el patrón
**Criterio de aceptación:** confirmar con línea exacta si hay o no un hueco de autorización y clasificarlo formalmente (podría pasar a P0 si se confirma)
**Bloque recomendado:** bloque de seguridad posterior a C-002
**No repetir:** no asumir que la superficie de riesgo se limita a los 2 endpoints de Seguimiento sin revisar estos dos primero.

**ID:** ACC-016
**Nombre:** Fallback silencioso de estado inválido en asistencia-guardar
**Módulo:** Asistencia
**Tipo:** DATOS
**Estado:** PARCIAL
**Prioridad:** P2
**Riesgo:** bajo-medio (datos silenciosamente incorrectos, no pérdida)
**Archivos:** `app/api/asistencia-guardar/route.ts`
**Dependencias:** Chat IA, Lista de alumnos
**Trabajo ya realizado:** comportamiento identificado por lectura de código en C-001B (fallback a "presente" si el estado recibido es inválido)
**Trabajo pendiente:** decidir si el fallback debe ser un error explícito en vez de un valor por defecto silencioso
**Pruebas realizadas:** ninguna
**Pruebas pendientes:** caso de prueba con un estado inválido intencional
**Criterio de aceptación:** comportamiento decidido explícitamente y documentado
**Bloque recomendado:** bloque de Asistencia, independiente de Seguimiento
**No repetir:** no asumir que un registro de asistencia siempre representa el estado real capturado sin revisar este fallback.

**ID:** ACC-017
**Nombre:** Separar diff mezclado de app/dashboard/lista/page.tsx
**Módulo:** Lista de alumnos / Seguimiento
**Tipo:** FUNCIÓN PARCIAL
**Estado:** PARCIAL
**Prioridad:** P2
**Riesgo:** medio (riesgo de mezclar Grupo A y Grupo B en un mismo commit)
**Archivos:** `app/dashboard/lista/page.tsx`
**Dependencias:** Seguimiento (C-002), Lista de alumnos
**Trabajo ya realizado:** identificado y respaldado en C-001 (respaldo externo, diff MEZCLADO.diff); confirmado de nuevo en C-001B
**Trabajo pendiente:** dividir el diff en dos commits independientes (botón "Eliminar lista completa" por un lado, enlace a Seguimiento por otro) antes de commitear cualquiera de los dos
**Pruebas realizadas:** ninguna
**Pruebas pendientes:** probar cada bloque por separado tras dividir
**Criterio de aceptación:** dos commits independientes, cada uno probado por separado, sin mezclar Grupo A y Grupo B
**Bloque recomendado:** uno para Grupo B (puede ir antes de C-002), otro coordinado con C-002 para Grupo A
**No repetir:** no commitear `app/dashboard/lista/page.tsx` tal cual sin dividir primero.

## Prioridad real del trabajo

**P0 — Crítico:**
- ACC-013 — IDOR en `POST /api/proyectos-seguimiento` y `POST /api/proyectos-seguimiento/[id]/hoja`.
- Base de datos (módulo 22) — estado incierto de `migrations/seguimiento_fase3.sql` contra Supabase real; forma parte del mismo bloqueo que ACC-013.

**P1 — Alto:**
- ACC-014 — corrección de documentación que afecta directamente la ejecución correcta de C-002 (ya cerrado en C-001B).
- ACC-015 — posible hueco de autorización sin confirmar en 2 endpoints adicionales (`periodos-evaluacion`, `ocr-foto`).

**P2 — Medio:**
- ACC-005, ACC-006, ACC-007, ACC-008 (validaciones pendientes en dispositivo/producción real).
- ACC-011 (calidad de datos CURP).
- ACC-016 (fallback silencioso en asistencia).
- ACC-017 (diff mezclado de Lista/Seguimiento).

**P3 — Bajo:**
- ACC-001, ACC-002, ACC-009, ACC-012 (detalle no recuperable, solo referencia).
- ACC-003, ACC-004 (ya cerrados, solo referencia).
- ACC-010 (función nueva sin código, fuera de alcance inmediato).

## Bloque actual y siguiente bloque

**BLOQUE ACTUAL:** Ninguno. C-001B se cierra al terminar este documento y `CHANGE_LOG_TECHNICAL.md`.

**SIGUIENTE BLOQUE PROPUESTO — C-002 — Corrección de seguridad de los dos endpoints críticos de Seguimiento** (definido, NO ejecutado):

- **Objetivo:** eliminar el IDOR en los dos endpoints de Seguimiento, resolviendo el docente real desde `auth.getUser()` sobre el `access_token` recibido — mismo patrón ya usado correctamente en `app/api/importar-alumnos/route.ts` vía `lib/server/authApi.ts` — sin agregar funciones nuevas.
- **Endpoints exactos:** `POST /api/proyectos-seguimiento` (`app/api/proyectos-seguimiento/route.ts`, línea 88); `POST /api/proyectos-seguimiento/[id]/hoja` (`app/api/proyectos-seguimiento/[id]/hoja/route.ts`, líneas 69 y 116).
- **Vulnerabilidades encontradas:** `docente_id` se recibe del cuerpo de la petición y se usa sin comparar contra el usuario real del `access_token` — permite a cualquier docente autenticado suplantar a otro (crear proyectos a su nombre, leer su perfil vía `perfiles_docentes`, generar/almacenar un PDF con el roster de su grupo en la ruta de Storage de ese docente).
- **Archivos permitidos:** `app/api/proyectos-seguimiento/route.ts`, `app/api/proyectos-seguimiento/[id]/hoja/route.ts`, y — solo si es estrictamente necesario para reutilizar el patrón existente — `lib/server/authApi.ts` (sin alterar su comportamiento para otros consumidores).
- **Archivos prohibidos:** cualquier archivo fuera de Seguimiento; `app/api/proyectos-seguimiento/sugerir-indicadores/route.ts` (ya usa el patrón correcto, no tocar); `migrations/seguimiento_fase3.sql`; cualquier archivo de Lista, Chat IA, Asistencia, Incidencias o CURP.
- **Pruebas necesarias:** docente A no puede crear un proyecto de seguimiento a nombre de docente B; docente A no puede leer el perfil de docente B a través de este endpoint; docente A no puede generar/almacenar la hoja PDF bajo la ruta de Storage de docente B; el flujo legítimo (docente autenticado actuando sobre sí mismo) sigue funcionando sin regresión.
- **Criterios de aceptación:** los dos endpoints resuelven el docente real desde `auth.getUser()` y rechazan o ignoran cualquier `docente_id` del body que no coincida; las pruebas anteriores pasan; no se modificó ninguna otra funcionalidad de Seguimiento ni de otro módulo.
- **Riesgos de regresión:** romper el flujo legítimo si el frontend (`app/dashboard/lista/proyectos/*.tsx`) todavía depende de enviar `docente_id` manualmente sin resolución completa por sesión — revisar antes de asumir que el frontend ya envía todo lo necesario.
- **Dependencia con la migración:** si `migrations/seguimiento_fase3.sql` no se ha aplicado contra Supabase real, la corrección de autorización no tendrá efecto observable en producción todavía — se recomienda verificar el estado de la migración (Terminal 4, solo lectura) antes o junto con C-002, sin ejecutar la migración sin autorización explícita adicional.
- **Confirmación de que no debe agregar funciones nuevas:** confirmado — C-002 es exclusivamente corrección de autorización, no debe tocar la lógica de negocio de Seguimiento ni agregar campos, pantallas o endpoints nuevos.

## Organización de terminales

**TERMINAL 1 — CONTROL MAESTRO**
Estado: ACTIVA
Bloque: C-001B
Permitido: Git, inventario, plan maestro, documentación, autorización de bloques.

**TERMINAL 2 — IMPLEMENTACIÓN**
Estado: INACTIVA
Próximo bloque posible: C-002
No debe abrirse hasta que C-001B quede cerrado.

**TERMINAL 3 — PRUEBAS**
Estado: INACTIVA
Se abrirá únicamente cuando C-002 tenga cambios que probar.

**TERMINAL 4 — BASE DE DATOS**
Estado: INACTIVA
No ejecutar migraciones. Solo se activará con una instrucción específica de verificación o migración.

## Control de cambios no consolidados

**GRUPO A — Seguimiento**
Archivos: `app/api/proyectos-seguimiento/*` (3 endpoints, nuevos), `app/dashboard/lista/proyectos/*` (2 páginas, nuevas), `lib/seguimiento/tipos.ts` (nuevo), `migrations/seguimiento_fase3.sql` (nuevo), `lib/documentGen/generarHojaSeguimientoPdf.ts` (nuevo), `lib/identificadorHoja.ts` (nuevo), `lib/documentGen/almacenamiento.ts` (modificado), `app/dashboard/lista/[alumnoId]/page.tsx` (modificado, solo renombrado de etiqueta), y la parte del diff mezclado de `app/dashboard/lista/page.tsx` correspondiente al enlace de navegación.
Estado: EN DESARROLLO / BLOQUEADO.
Respaldo: sí, completo, en `~/Desktop/RESPALDO_DOCENTE_IA_SEGUIMIENTO_2026-07-31/`.
Commit: no. Remoto: no.
Puede probarse: no, hasta resolver C-002 y confirmar la migración.
Bloque que lo cierra: C-002 (seguridad) + un bloque posterior de migración/consolidación.
No debe mezclarse con: Grupo B (ver ACC-017), Grupo C.

**GRUPO B — Lista de alumnos**
Archivos: la parte del diff mezclado de `app/dashboard/lista/page.tsx` correspondiente al botón "Eliminar lista completa".
Estado: PARCIAL, mezclado con Grupo A en el mismo archivo.
Respaldo: sí (incluido en el respaldo de Seguimiento por seguridad, con advertencia explícita de mezcla).
Commit: no. Remoto: no.
Puede probarse: solo después de separar el diff (ACC-017).
Bloque que lo cierra: un bloque de Lista independiente, puede ir antes o en paralelo a C-002 una vez separado.
No debe mezclarse con: Grupo A, Grupo C.

**GRUPO C — Calidad de datos/CURP**
Archivos: `ROADMAP.md` (modificado), `app/api/importar-datos-alumnos/route.ts` (modificado, solo el comentario que documenta la desactivación), `consulta_11.sql` (nuevo), `lib/curp.ts` (nuevo).
Estado: EN DESARROLLO.
Respaldo: no tiene respaldo externo dedicado (solo lo que ya está en git como untracked/modified).
Commit: no. Remoto: no.
Puede probarse: sí, es independiente de Seguimiento y Lista — confirmado sin dependencias cruzadas.
Bloque que lo cierra: un bloque de Datos independiente, puede ejecutarse en cualquier momento sin esperar a C-002.
No debe mezclarse con: Grupo A, Grupo B.

**GRUPO D — Documentación de control**
Archivos: `docs/PROJECT_CONTROL.md`, `docs/CHANGE_LOG_TECHNICAL.md`.
Estado: completados en este bloque (C-001B).
Respaldo: no aplica (son ellos mismos el registro).
Commit: pendiente de autorización explícita del usuario.
Remoto: no.
Puede probarse: no aplica.
Bloque que lo cierra: C-001B, sujeto a la autorización de commit.
No debe mezclarse con: ningún otro grupo — commit exclusivo de estos 2 archivos si se autoriza.

## Regla operativa permanente

- Solo puede existir un bloque de implementación activo.
- Solo Terminal 2 puede modificar código funcional.
- Ninguna terminal inicia trabajo sin ID autorizado.
- Todo bloque empieza con `git status`.
- Todo bloque termina con pruebas y registro.
- Ningún cambio se marca como terminado sin criterio de aceptación.
- Ninguna función se vuelve a implementar sin revisar el inventario.
- Ninguna migración se ejecuta sin verificar antes el estado real de Supabase.
- Ninguna corrección debe eliminar funciones previamente logradas.
- Las conversaciones de Claude no sustituyen el registro del repositorio.

## Matriz de acciones que no deben repetirse

- Volver a implementar "alta de alumnos desde foto" sin leer el plan ya escrito (ACC-010).
- Repetir o reescribir `migrations/seguimiento_fase3.sql` sin confirmar antes si ya se aplicó.
- Instalar una tercera dependencia de autenticación/SSR de Supabase sin antes determinar cuál de `@supabase/auth-helpers-nextjs` o `@supabase/ssr` está realmente en uso.
- Tocar `escribirAsistencia()` o la tabla legada `asistencias` sin leer primero los comentarios ya existentes en `lib/motorContexto.ts` (documentan una causa raíz ya corregida).
- Citar `app/api/importar-datos-alumnos/route.ts` como ejemplo de endpoint ya corregido — está descontinuado, no corregido (ver ACC-014).
- Corregir el IDOR de Seguimiento sin revisar primero `lib/server/authApi.ts` y el patrón real de `app/api/importar-alumnos/route.ts`.

## Protocolo de apertura y cierre de bloques

Apertura: ID del pendiente, objetivo, archivos previstos, funciones que no deben alterarse, pruebas de aceptación.
Cierre: archivos modificados, resumen de cambios, pruebas ejecutadas, resultados, funciones verificadas, riesgos restantes, estado final del pendiente, recomendación del siguiente paso.
Regla dura: ninguna Terminal 2 se abre sin confirmar primero el ID del pendiente contra este archivo.

## Próximo bloque permitido

Ninguno todavía. Requiere autorización explícita del usuario para C-002 (corrección de seguridad de Seguimiento) o para cualquiera de los bloques independientes de Grupo B o Grupo C.
