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
**Estado:** EN DESARROLLO (seguridad corregida en código por C-002/C-003, sin commit; migración CONFIRMADA/APLICADA — ver "Estado de la migración seguimiento_fase3.sql" abajo) — esta línea queda superada por las secciones "C-002"/"C-003" y por el registro de migración, se conserva por trazabilidad
**Funciones confirmadas:** creación de proyectos de seguimiento (`POST /api/proyectos-seguimiento`); sugerencia de indicadores con autenticación fuerte real vía `access_token` + `auth.getUser()` (`POST /api/proyectos-seguimiento/sugerir-indicadores`, línea 53); generación de hoja/PDF (`POST /api/proyectos-seguimiento/[id]/hoja`); las 4 tablas de soporte (`proyectos_seguimiento`, `hojas_evaluacion`, `seguimiento_resultados`, `seguimiento_versiones`) confirmadas existentes en Supabase real (verificación de solo lectura contra `information_schema.tables`, registrada 2026-08-01).
**Funciones parciales:** pantallas `app/dashboard/lista/proyectos/page.tsx` y `.../nuevo/page.tsx` sin commitear.
**Errores conocidos:** IDOR confirmado con línea exacta en C-001/C-001B — corregido en código por C-002 (POST) y C-003 (GET), ver esas secciones abajo; sin commit ni push todavía.
**Archivos principales:** `app/api/proyectos-seguimiento/route.ts`, `app/api/proyectos-seguimiento/sugerir-indicadores/route.ts`, `app/api/proyectos-seguimiento/[id]/hoja/route.ts`, `lib/seguimiento/tipos.ts`, `migrations/seguimiento_fase3.sql`, `app/dashboard/lista/proyectos/*`.
**Datos o tablas utilizadas:** `proyectos_seguimiento`, `hojas_evaluacion`, `seguimiento_resultados`, `seguimiento_versiones` (las 4 confirmadas existentes en Supabase real), `perfiles_docentes`, `grupos`.
**Pruebas realizadas:** revisión de seguridad de código (C-001, C-001B, C-002, C-003) más `tsc --noEmit`/`eslint` sobre los endpoints corregidos; verificación de solo lectura de las 4 tablas contra Supabase real. Ninguna prueba funcional en vivo todavía (crear un proyecto real, generar una hoja real).
**Pruebas pendientes:** prueba funcional real contra Supabase (crear proyecto, generar hoja, listar) ahora que la migración está confirmada; separar el diff mezclado de Lista (ACC-017); decidir la etiqueta Evaluación/Seguimiento.
**Riesgo:** medio — bajó de crítico porque el IDOR ya está corregido en código (C-002/C-003), pero sigue sin commit, sin push y sin prueba funcional real.
**Dependencias:** Lista de alumnos (diff mezclado), Evaluación (decisión de etiqueta).
**Próximo pendiente autorizado:** ninguno todavía — ver "Siguiente bloque propuesto" (C-004) al final de este documento.

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
**Estado:** FUNCIONAL CON VALIDACIÓN PENDIENTE (migración de Seguimiento CONFIRMADA/APLICADA, 2026-08-01)
**Funciones confirmadas:** `migrations/seguimiento_fase3.sql` ya está aplicada contra la base real — verificado el 2026-08-01 mediante consulta de solo lectura a `information_schema.tables`, confirmando la existencia de las 4 tablas: `proyectos_seguimiento`, `hojas_evaluacion`, `seguimiento_resultados`, `seguimiento_versiones`. Ver "Estado de la migración seguimiento_fase3.sql" más abajo para el registro completo.
**Funciones parciales:** solo se confirmó la existencia de las 4 tablas (estructura a nivel `information_schema.tables`); no se verificaron columnas, políticas RLS reales, ni datos de prueba dentro de ellas.
**Errores conocidos:** ninguno — el bloqueo anterior (estado de la migración desconocido) queda resuelto.
**Archivos principales:** `migrations/seguimiento_fase3.sql` (ya aplicada — NO debe volver a ejecutarse).
**Datos o tablas utilizadas:** `proyectos_seguimiento`, `hojas_evaluacion`, `seguimiento_resultados`, `seguimiento_versiones` (las 4 confirmadas existentes).
**Pruebas realizadas:** consulta de solo lectura a `information_schema.tables` contra Supabase real, confirmando las 4 tablas.
**Pruebas pendientes:** verificar columnas/constraints reales contra lo esperado por `lib/seguimiento/tipos.ts`; confirmar las políticas RLS reales de las 4 tablas (relevante para el patrón de autorización delegada a RLS usado en otros endpoints, ver módulo Seguridad); prueba funcional real de escritura/lectura desde la aplicación.
**Riesgo:** bajo en cuanto a la existencia de la migración (ya no es un bloqueo); pendiente de verificar RLS antes de considerar el módulo completamente cerrado.
**Dependencias:** Seguimiento.
**Próximo pendiente autorizado:** ninguno — Terminal 4 permanece en solo lectura hasta instrucción explícita; no volver a ejecutar `migrations/seguimiento_fase3.sql` bajo ninguna circunstancia, ya está aplicada.

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

**Actualización C-002 (ver sección propia más abajo):** corregido en código — ambos endpoints resuelven `docente_id` desde `auth.getUser()` vía `autenticarRequestApi()`, nunca del body. Sin commit todavía.

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
**Estado:** CORREGIDO EN CÓDIGO por C-002 (sin commit, sin prueba funcional real) — este campo queda superado, se conserva por trazabilidad
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

**P0 — Crítico (histórico, ya resuelto en código):**
- ACC-013 — IDOR en `POST /api/proyectos-seguimiento` y `POST /api/proyectos-seguimiento/[id]/hoja`. CORREGIDO EN CÓDIGO por C-002 (2026-08-01), sin commit ni push todavía — ver sección "C-002".
- ~~Base de datos (módulo 22) — estado incierto de `migrations/seguimiento_fase3.sql`~~ — RESUELTO 2026-08-01: migración CONFIRMADA/APLICADA (ver "Estado de la migración seguimiento_fase3.sql"). Ya no es P0.

**P1 — Alto:**
- ACC-014 — corrección de documentación que afecta directamente la ejecución correcta de C-002 (ya cerrado en C-001B).
- ACC-015 — posible hueco de autorización sin confirmar en 2 endpoints adicionales (`periodos-evaluacion`, `ocr-foto`).
- ACC-018 — IDOR de lectura en `GET /api/proyectos-seguimiento`. CORREGIDO EN CÓDIGO por C-003 (2026-08-01), sin commit ni push — ver sección "C-003".
- Commitear y probar funcionalmente C-002/C-003 contra Supabase real, ahora que la migración está confirmada — ver "Siguiente bloque propuesto (C-004)".

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
Estado: INACTIVA (se activó y cerró para ejecutar C-002)
Próximo bloque posible: ninguno asignado — ver "Próximo bloque permitido"

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
- Volver a ejecutar `migrations/seguimiento_fase3.sql` — CONFIRMADA/APLICADA desde el 2026-08-01, ver "Estado de la migración seguimiento_fase3.sql"; cualquier cambio de esquema futuro debe ser una migración nueva y separada.
- Instalar una tercera dependencia de autenticación/SSR de Supabase sin antes determinar cuál de `@supabase/auth-helpers-nextjs` o `@supabase/ssr` está realmente en uso.
- Tocar `escribirAsistencia()` o la tabla legada `asistencias` sin leer primero los comentarios ya existentes en `lib/motorContexto.ts` (documentan una causa raíz ya corregida).
- Citar `app/api/importar-datos-alumnos/route.ts` como ejemplo de endpoint ya corregido — está descontinuado, no corregido (ver ACC-014).
- Corregir el IDOR de Seguimiento sin revisar primero `lib/server/authApi.ts` y el patrón real de `app/api/importar-alumnos/route.ts`.

## Protocolo de apertura y cierre de bloques

Apertura: ID del pendiente, objetivo, archivos previstos, funciones que no deben alterarse, pruebas de aceptación.
Cierre: archivos modificados, resumen de cambios, pruebas ejecutadas, resultados, funciones verificadas, riesgos restantes, estado final del pendiente, recomendación del siguiente paso.
Regla dura: ninguna Terminal 2 se abre sin confirmar primero el ID del pendiente contra este archivo.

## C-002 — Corrección de seguridad de los dos endpoints críticos de Seguimiento (ejecutado, sin commit)

**Estado:** CORREGIDO EN CÓDIGO, sin probar en producción, sin commit ni push (pendiente de autorización del usuario).

**Endpoints corregidos:**
- `POST /api/proyectos-seguimiento` (`app/api/proyectos-seguimiento/route.ts`).
- `POST /api/proyectos-seguimiento/[id]/hoja` (`app/api/proyectos-seguimiento/[id]/hoja/route.ts`).

**Corrección aplicada (idéntica en ambos):** se reemplazó la confianza en `docente_id` del body por `autenticarRequestApi(access_token)` (`lib/server/authApi.ts`, mismo patrón ya usado en `app/api/importar-alumnos/route.ts`), que llama a `auth.getUser()` y regresa el usuario real de la sesión. `docente_id` ya no se lee del body en ningún punto — se resuelve siempre como `auth.user.id`. Se agregó verificación explícita de pertenencia (grupo/proyecto → docente autenticado) en vez de delegarla implícitamente al RLS, con códigos de estado diferenciados: 401 sin sesión, 400 con ID de grupo/proyecto con formato inválido (regex UUID), 404 si el recurso no existe, 403 si existe pero pertenece a otro docente. `lib/server/authApi.ts` no se modificó — se reutilizó tal cual.

**Vulnerabilidades corregidas:** IDOR confirmado en C-001/C-001B — `docente_id` del body se usaba sin verificar para insertar el proyecto (route.ts:88 original) y para leer `perfiles_docentes` / construir la ruta de Storage del PDF (hoja/route.ts:69,116 original). Ambos puntos ahora usan el `docente_id` resuelto por sesión.

**Archivos modificados:** `app/api/proyectos-seguimiento/route.ts`, `app/api/proyectos-seguimiento/[id]/hoja/route.ts`.
**Archivos NO modificados:** `app/api/proyectos-seguimiento/sugerir-indicadores/route.ts` (ya tenía el patrón correcto, no se tocó), `lib/server/authApi.ts`, cualquier archivo de Lista, Chat IA, Asistencia, Incidencias, CURP, pantallas de Seguimiento, `migrations/`.

**Pruebas ejecutadas:** `npx tsc --noEmit` (sin errores) y `npx eslint` sobre los 2 archivos modificados (sin errores). Verificación por lectura de código de los 4 casos de autorización (401/403/404/continúa) y del caso de ID inválido (400). No se ejecutó prueba funcional real contra Supabase (sin credenciales en este entorno, mismo bloqueo documentado para el módulo Base de datos).

**Hallazgo nuevo, fuera de alcance de C-002 (no corregido en C-002):** el `GET /api/proyectos-seguimiento` (mismo archivo `route.ts`) tampoco verificaba que el `grupo_id` recibido por query param perteneciera al docente autenticado — mismo patrón de IDOR, pero de solo lectura. Registrado como ACC-018. **Corregido en C-002 — ver sección "C-003" más abajo.**

**Riesgos restantes:**
- RESUELTO 2026-08-01: `migrations/seguimiento_fase3.sql` está CONFIRMADA/APLICADA contra Supabase real (ver "Estado de la migración seguimiento_fase3.sql" más abajo) — la corrección ya tiene efecto observable en producción en cuanto se commitee y despliegue.
- Sin credenciales reales de Supabase en este entorno de desarrollo (variables de entorno vacías), no fue posible probar en vivo los 4 casos de autorización desde la aplicación (solo verificación por lectura de código); esto es independiente de que la migración ya esté aplicada, que se verificó por otro medio (consulta directa de solo lectura a `information_schema.tables`).
- Depende de que las políticas RLS reales de `grupos` y `proyectos_seguimiento` no contradigan la verificación explícita agregada (si RLS ya restringe por `auth.uid()`, la verificación explícita es redundante pero no dañina; si RLS es más permisivo de lo esperado, la verificación explícita es ahora la única defensa real) — RLS real todavía no verificado.

## C-003 — Corrección de ACC-018 en GET /api/proyectos-seguimiento (ejecutado, sin commit)

**ID del pendiente cerrado:** ACC-018.
**Estado:** CORREGIDO EN CÓDIGO, sin probar en producción, sin commit ni push (pendiente de autorización del usuario).

**Vulnerabilidad:** el `GET` obtenía `grupo_id` de un query param y consultaba `proyectos_seguimiento` filtrando solo por ese valor, sin verificar sesión con `auth.getUser()` ni pertenencia del grupo al docente autenticado — IDOR de lectura: cualquier docente con el UUID de un grupo ajeno podía listar sus proyectos de seguimiento (nombre, campos formativos, fechas, estado).

**Cambio realizado:** el `GET` ahora resuelve el docente real vía `autenticarRequestApi(extraerBearerToken(req))` (mismo patrón de `lib/server/authApi.ts` ya usado en el `POST` de este archivo y en C-002), exige `grupo_id` con formato UUID válido, y verifica explícitamente `grupo.docente_id === docenteId` contra la tabla `grupos` antes de consultar `proyectos_seguimiento`. Devuelve 401 sin sesión, 400 sin `grupo_id` o con formato inválido, 404 si el grupo no existe, 403 si existe pero es de otro docente. El `POST` del mismo archivo no se tocó.

**Archivos modificados:** `app/api/proyectos-seguimiento/route.ts` (únicamente el handler `GET`).
**Archivos NO modificados:** `app/api/proyectos-seguimiento/[id]/hoja/route.ts`, `app/api/proyectos-seguimiento/sugerir-indicadores/route.ts`, `lib/server/authApi.ts`, pantallas de Seguimiento, Lista, Chat IA, CURP, `migrations/`.

**Pruebas ejecutadas:** `npx tsc --noEmit` (sin errores), `npx eslint app/api/proyectos-seguimiento/route.ts` (sin errores). Verificación por lectura de código de los 5 casos requeridos (401 sin sesión; grupo propio → solo proyectos autorizados; grupo ajeno → 403/404; sin `grupo_id` → nunca hay fuga de datos ajenos, ya que la ruta corta con 400 antes de consultar; `grupo_id` con formato inválido → 400) y confirmación de que el `POST` quedó exactamente igual.

**ACC-018:** CERRADO.

**Riesgos restantes:**
- Sin credenciales reales de Supabase en este entorno de desarrollo, no fue posible probar en vivo desde la aplicación (mismo bloqueo documentado desde C-001); la migración en sí ya está confirmada por otro medio, ver abajo.
- Mismo riesgo de dependencia con RLS real ya documentado en C-002.
- Sin commit ni push todavía — el archivo queda como cambio local sin consolidar dentro de Grupo A (Seguimiento).

## Estado de la migración seguimiento_fase3.sql — CONFIRMADA/APLICADA (registrado 2026-08-01)

**Conclusión:** la migración `migrations/seguimiento_fase3.sql` ya fue aplicada en la base de datos real de Supabase.

**Método de verificación:** consulta de solo lectura a `information_schema.tables`, ejecutada directamente contra Supabase por el usuario (fuera de este entorno de desarrollo, que sigue sin credenciales reales configuradas).

**Tablas confirmadas existentes (las 4 que define la migración):**
- `proyectos_seguimiento`
- `hojas_evaluacion`
- `seguimiento_resultados`
- `seguimiento_versiones`

**Alcance de esta verificación:** solo confirma la existencia de las 4 tablas a nivel de `information_schema.tables`. NO confirma columnas exactas, constraints, ni políticas RLS reales — eso sigue pendiente (ver módulo Base de datos y módulo Seguridad).

**Regla dura — NO VOLVER A EJECUTAR:** `migrations/seguimiento_fase3.sql` NO debe ejecutarse de nuevo bajo ninguna circunstancia. Ya está aplicada; volver a correrla arriesga errores de "ya existe" en el mejor caso, o daño a datos reales ya almacenados en esas 4 tablas en el peor caso. Cualquier cambio futuro al esquema de Seguimiento debe ser una migración nueva y separada, nunca una re-ejecución de esta.

**Efecto sobre bloqueos previos:** esto resuelve la dependencia de migración que mantenía a ACC-013 y al módulo Base de datos como P0 (ver "Prioridad real del trabajo", ya actualizado arriba). El módulo Seguimiento ya no está BLOQUEADO por este motivo — ver estado actualizado del módulo Seguimiento arriba.

## Siguiente bloque propuesto — C-004 — Consolidación y prueba funcional del módulo Seguimiento (definido, NO ejecutado)

Con el IDOR corregido en código (C-002, C-003) y la migración confirmada/aplicada, el trabajo pendiente para cerrar el módulo Seguimiento es de consolidación y prueba, no de más correcciones de seguridad:

- **Objetivo:** commitear el código ya corregido de C-002/C-003, probar funcionalmente los 3 endpoints de Seguimiento contra Supabase real (crear proyecto, generar hoja, listar proyectos por grupo, y los casos negativos 401/403/404), y dejar el módulo en un estado consolidado y verificable.
- **Alcance sugerido:** (a) revisar y commitear `app/api/proyectos-seguimiento/route.ts` y `app/api/proyectos-seguimiento/[id]/hoja/route.ts` tal como quedaron tras C-002/C-003; (b) prueba funcional real de los 3 endpoints; (c) separar el diff mezclado de `app/dashboard/lista/page.tsx` (ACC-017) antes de tocarlo; (d) decidir la etiqueta Evaluación/Seguimiento en la ficha del alumno; (e) verificar políticas RLS reales de `grupos`, `proyectos_seguimiento`, `hojas_evaluacion`.
- **Fuera de alcance de C-004:** ACC-015 (periodos-evaluacion/ocr-foto — módulo distinto, bloque de seguridad aparte); cualquier función nueva de Seguimiento no solicitada.
- **Depende de:** autorización explícita del usuario para abrir C-004 y para el primer commit de código funcional de Seguimiento.

## C-004 — Consolidación y prueba funcional del módulo Seguimiento (EN PROGRESO — diagnóstico y pruebas técnicas completos, prueba funcional bloqueada por entorno)

**Estado:** diagnóstico de integración completo, pruebas técnicas completas, 1 corrección aplicada, prueba funcional en vivo BLOQUEADA (no por falta de autorización, sino porque este entorno de desarrollo no tiene credenciales reales de Supabase). Sin commit, sin push.

### 1. Confirmaciones de lectura obligatoria

C-002 y C-003 cerrados (ver esas secciones arriba); ACC-018 cerrado; migración `seguimiento_fase3.sql` CONFIRMADA/APLICADA (ver sección propia); C-004 era el siguiente bloque autorizado (ver "Siguiente bloque propuesto" ya escrito en C-001C). Git al abrir este bloque: rama `main`, sincronizada con `origin/main`, mismos 5 archivos modificados + 8 rutas sin rastrear ya conocidas de Grupos A/B/C, sin cambios remotos nuevos.

### 2. Auditoría de integración (diagnóstico, antes de tocar nada)

- **Pantalla que inicia el flujo:** `app/dashboard/lista/proyectos/page.tsx` (lista de proyectos del grupo), accesible desde el botón 🏆 "Seguimiento" en el header de `app/dashboard/lista/page.tsx` (línea 388) y desde el enlace "+ Crear un proyecto para el grupo" en la pestaña "Seguimiento" de la ficha del alumno (`app/dashboard/lista/[alumnoId]/page.tsx`, línea 826) cuando no hay evaluaciones.
- **Creación de proyecto:** botón "+ Nuevo proyecto" → `app/dashboard/lista/proyectos/nuevo/page.tsx` → `crearProyecto()` → `POST /api/proyectos-seguimiento` con `access_token` de la sesión real (`supabase.auth.getSession()`). El backend resuelve el docente desde el token, verifica que el grupo le pertenezca, e inserta en `proyectos_seguimiento` con `estado='planeado'`.
- **Sugerencia de indicadores:** botón "✨ Ayúdame a redactar los indicadores" → `POST /api/proyectos-seguimiento/sugerir-indicadores` → valida sesión con `auth.getUser()` (sin tocar datos del grupo) → llama a Claude con el marco curricular vigente (`lib/asistente/marcoCurricular.ts`) → regresa 5 indicadores, uno por cada aspecto general.
- **Guardado del proyecto:** ya cubierto arriba — el proyecto se crea en un solo POST, sin pasos intermedios.
- **Generación de la hoja:** inmediatamente después de crear el proyecto, `generarHoja()` llama a `POST /api/proyectos-seguimiento/[id]/hoja` con `access_token` + los indicadores capturados en pantalla. El backend verifica que el proyecto pertenezca al docente, arma el roster del grupo (`lib/rosterGrupo.ts`, tablas `inscripciones`/`alumnos`), dibuja el PDF (`lib/documentGen/generarHojaSeguimientoPdf.ts`, vía `pdf-lib`), lo sube a Storage (`lib/documentGen/almacenamiento.ts`, bucket `hojas-seguimiento`, privado) e inserta la fila en `hojas_evaluacion` con reintento ante colisión de identificador (`lib/identificadorHoja.ts`, hasta 3 intentos).
- **Descarga/apertura del PDF:** URL firmada de 7 días (`crearUrlFirmada`), mostrada como botón "📄 Ver / descargar hoja" en la pantalla de confirmación.
- **Tablas usadas por paso:** crear proyecto → `grupos` (verificación), `proyectos_seguimiento` (insert); generar hoja → `proyectos_seguimiento` (select+update), `periodos_evaluacion` (select opcional), `perfiles_docentes` (select), `inscripciones`/`alumnos` (roster vía `obtenerRosterConPosicion`), `hojas_evaluacion` (insert+update); listar → `grupos` (verificación), `proyectos_seguimiento` (select). Las tablas `seguimiento_resultados` y `seguimiento_versiones` (creadas por la migración) NO tienen ningún consumidor en el código todavía — esperado, corresponden a una fase futura (captura de resultados desde la hoja física, fuera de alcance de C-004 y explícitamente no autorizada en este bloque).
- **Bucket de Storage:** `hojas-seguimiento` (`BUCKET_HOJAS_SEGUIMIENTO`), separado del bucket de documentos generados por el Chat IA (`documentos-generados-ia`), privado, se autoasegura de forma perezosa la primera vez que se usa.
- **Rutas que conectan cada pantalla:** lista → nuevo (`?grupoId=`) → confirmación (`router.push` de vuelta a la lista); todas propagan `grupoId` correctamente; confirmado sin enlaces rotos.
- **Validaciones de sesión y propiedad:** las 3 rutas API resuelven el docente exclusivamente desde `auth.getUser()` sobre el `access_token` real (nunca del body/query); `POST /api/proyectos-seguimiento` y `POST .../[id]/hoja` verifican explícitamente que el grupo/proyecto pertenezca al docente (403/404 diferenciados); `GET` verifica lo mismo sobre el grupo antes de listar (C-003). RLS real (Patrón A, "solo titular") ya está definida en la migración como defensa adicional.
- **Enlaces rotos:** ninguno encontrado.
- **Funciones sin consumidor:** el tipo `EstadoProyectoFase2` (`lib/seguimiento/tipos.ts`) está declarado pero sin ningún valor de esa unión usado fuera de la propia definición — es intencional y está documentado en el propio archivo (valores reservados para fases futuras). Las tablas `seguimiento_resultados`/`seguimiento_versiones` no tienen ningún código que las consulte todavía (mismo motivo).
- **Pantallas que prometen acciones inexistentes:** SÍ, un caso real — la pestaña "Seguimiento" de la ficha del alumno (`app/dashboard/lista/[alumnoId]/page.tsx`, línea 821) muestra el texto "Los resultados se registrarán al cargar la hoja de evaluación de un proyecto" cuando no hay evaluaciones. Esto es engañoso: generar una hoja NO produce ningún resultado visible ahí — no existe ningún código que escriba en `seguimiento_resultados` (eso requiere la fase de captura por foto/OCR, explícitamente fuera de alcance de C-004). Registrado como **ACC-019** abajo.
- **Etiqueta "Seguimiento" de la ficha individual:** confirmado por lectura de código — la pestaña sigue leyendo exclusivamente la tabla `evaluaciones` preexistente (tipo `Evaluacion`, línea 23 del archivo); el único cambio real (más allá del renombrado de etiqueta que ya documentaba C-001) es el nuevo enlace "+ Crear un proyecto para el grupo" cuando la lista está vacía. La etiqueta NO está conectada a resultados reales de Seguimiento — ver decisión en la sección 7 más abajo.
- **Hallazgo adicional (menor, no bloqueante):** `app/dashboard/lista/proyectos/nuevo/page.tsx` sigue enviando `docente_id: user.id` en el body de los 2 POST (líneas 156 y 189), pero el backend ya no lo lee en absoluto desde C-002 (el tipo `BodyPost` no lo incluye) — es un campo muerto, inofensivo (el backend lo ignora), pero vale la pena limpiarlo en un futuro bloque de pulido. Registrado como **ACC-020**, prioridad P3, no corregido en C-004 (no es necesario para esta fase).
- **Hallazgo adicional (comentario impreciso, no funcional):** el comentario de `lib/identificadorHoja.ts` (líneas 8-10) dice que el manejo de colisión del identificador "vive en `app/api/proyectos-seguimiento/route.ts`" — en realidad vive en `app/api/proyectos-seguimiento/[id]/hoja/route.ts` (el bucle de reintento de C-002/C-003 está en el endpoint de la hoja, no en el de creación del proyecto). Es solo un comentario desactualizado, no afecta el comportamiento. No corregido en C-004 por ser cosmético y no formar parte de los archivos con lógica de negocio activa del diagnóstico.

### 3. Pruebas técnicas ejecutadas

- **`npx tsc --noEmit`** (proyecto completo): sin errores.
- **`npx eslint`** sobre los 9 archivos del bloque: 1 error — `app/dashboard/lista/proyectos/page.tsx:126`, regla `@next/next/no-html-link-for-pages` (usa `<a>` en vez de `<Link/>`). CONFIRMADO como patrón preexistente en todo el proyecto (mismo error en `app/dashboard/lista/[alumnoId]/page.tsx:587` y 10+ archivos más de `app/dashboard/`) — no es una regresión del bloque, no se corrige aquí para no desviarse de la convención ya establecida en el resto de la app.
- **`npm run build`**: NO completó — falla en la recolección de datos de página de `/api/realtime-token` por `OPENAI_API_KEY` vacío en este entorno. Error preexistente y ajeno al bloque (no relacionado con Seguimiento); no se intentó rodear ni ocultar.
- **Archivos sin uso:** ninguno completo sin usar; ver "Funciones sin consumidor" arriba para los casos parciales (intencionales).
- **Prueba en vivo de los guards de autenticación** (servidor local, sin datos reales, sin necesidad de credenciales): con `npm run dev` y `curl` directo a los 3 endpoints —
  - `GET` sin `Authorization` → 401 "Sesión no encontrada." ✓
  - `POST` proyecto sin `access_token` → 401 "Sesión no encontrada." ✓
  - `POST` hoja sin `access_token` → 401 "Sesión no encontrada." ✓
  - `POST` sugerir-indicadores sin `access_token` → 401 "Sesión no encontrada. Vuelve a iniciar sesión." ✓
  - `GET`/`POST` proyecto con un token no vacío pero inválido → 500 "supabaseKey is required." — esperado en este entorno porque `NEXT_PUBLIC_SUPABASE_ANON_KEY` está vacía (no hay forma de que `auth.getUser()` se ejecute realmente); en producción, con la anon key real, este mismo caso devolvería 401 "Sesión inválida o expirada." (supabase-js regresa un error, no lanza una excepción, ante un JWT inválido con una key real).
  - **Corrección aplicada:** el `GET` no tenía `try/catch` (a diferencia de los 2 `POST` del módulo), así que el caso de arriba salía como un error sin manejar de Next.js en vez de un JSON `{error: ...}` limpio. Se envolvió el cuerpo completo del `GET` en `try/catch`, igual que ya hacían los 2 `POST` del mismo archivo — mismo patrón, mismo archivo, sin nueva lógica. Verificado después: el mismo caso ahora responde `{"error":"supabaseKey is required."}` con 500 en vez de la página de error por defecto de Next.js. `tsc`/`eslint` limpios tras el cambio.

### 4. Prueba funcional local — BLOQUEADA POR ENTORNO (sección 5 del bloque)

No se pudo ejecutar. Antes de siquiera llegar a la pregunta de qué nombre de prueba usar, se confirmó que `.env.local` en este entorno de desarrollo tiene `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY` y `OPENAI_API_KEY` vacíos (solo `NEXT_PUBLIC_SUPABASE_URL` tiene un valor real) — ningún login real, lectura ni escritura contra Supabase es posible desde aquí. Esto es consistente con lo ya documentado desde C-001 para el módulo Base de datos. Se ejecutó en su lugar una verificación segura y no destructiva de los 3 endpoints (guards de autenticación, ver arriba), que no requiere credenciales ni crea ningún dato. La prueba funcional real (crear proyecto, generar hoja, descargar PDF, ver datos correctos del grupo) queda pendiente para cuando el usuario la ejecute con credenciales reales (localmente o en un entorno con acceso a Supabase) — no es un pendiente de autorización, es un pendiente de entorno.

### 5. Decisión sobre la ficha del alumno (recomendación, SIN modificar el archivo)

**Recomendación: Opción A — dejar `app/dashboard/lista/[alumnoId]/page.tsx` fuera de este commit.**

Razones: (1) la pestaña sigue leyendo exclusivamente `evaluaciones`, sin ninguna conexión real a `seguimiento_resultados` — conectarla de verdad (Opción C) requiere la fase de captura de resultados (foto/OCR), explícitamente fuera de alcance de C-004; (2) volver a "Evaluación" (Opción B) escondería el enlace "+ Crear un proyecto para el grupo" que sí es una función real y funcionando, y el usuario ya invirtió en construir todo el módulo Seguimiento — revertir la etiqueta ahora sería un paso atrás sin necesidad; (3) el texto engañoso del estado vacío (ACC-019) es un problema de copy aislado, corregible con un cambio de una línea en un bloque futuro pequeño y específico, sin esperar a la fase de OCR. Commitear este archivo junto con C-002/C-003/C-004 mezclaría "corrección de seguridad ya probada" con "cambio de UI todavía con una promesa imprecisa" — mejor mantenerlos separados.

### 6. Pendientes nuevos de este bloque

**ID:** ACC-019
**Nombre:** Texto engañoso en la pestaña Seguimiento de la ficha del alumno
**Módulo:** Ficha individual del alumno / Seguimiento
**Tipo:** EXPERIENCIA DE USUARIO
**Estado:** NO VERIFICADO → confirmado como hallazgo real en C-004
**Prioridad:** P2
**Riesgo:** bajo-medio (expectativa falsa para el docente, no pérdida de datos)
**Archivos:** `app/dashboard/lista/[alumnoId]/page.tsx` (línea 821)
**Dependencias:** fase futura de captura de resultados de Seguimiento (OCR/foto), fuera de alcance de C-004
**Trabajo ya realizado:** identificado y confirmado por lectura de código en C-004
**Trabajo pendiente:** decidir una redacción honesta para el estado vacío (ej. mencionar que los resultados llegarán en una fase futura, sin prometer que aparecen automáticamente al generar la hoja)
**Pruebas realizadas:** ninguna, es un cambio de copy
**Pruebas pendientes:** ninguna técnica; solo revisión de redacción
**Criterio de aceptación:** el texto ya no promete una actualización automática que el código no puede cumplir todavía
**Bloque recomendado:** bloque pequeño e independiente, no requiere esperar a C-005 ni a la fase de OCR
**No repetir:** no conectar apresuradamente esta pestaña a `seguimiento_resultados` sin la fase de captura real construida.

**ID:** ACC-020
**Nombre:** Campo `docente_id` muerto enviado por el frontend de Seguimiento
**Módulo:** Seguimiento
**Tipo:** FUNCIÓN PARCIAL
**Estado:** PARCIAL (inofensivo)
**Prioridad:** P3
**Riesgo:** nulo (el backend ya lo ignora desde C-002)
**Archivos:** `app/dashboard/lista/proyectos/nuevo/page.tsx` (líneas 156, 189)
**Dependencias:** ninguna
**Trabajo ya realizado:** identificado en el diagnóstico de C-004
**Trabajo pendiente:** quitar el campo `docente_id` del body de ambos `fetch` (limpieza, no afecta comportamiento)
**Pruebas realizadas:** confirmado por lectura que el backend no lo lee (`BodyPost` no lo incluye)
**Pruebas pendientes:** ninguna
**Criterio de aceptación:** el frontend ya no manda un campo que el backend ignora
**Bloque recomendado:** bloque de pulido técnico, sin urgencia
**No repetir:** no interpretar este campo como si todavía tuviera efecto en la autorización — la autorización real es 100% server-side desde C-002/C-003.

## C-004 — continuación: prueba manual guiada, hallazgo de entorno y bloqueo de autenticación (2026-08-01)

Tras resolver el bloqueo de credenciales (el usuario agregó `NEXT_PUBLIC_SUPABASE_ANON_KEY` real a `.env.local`), se retomó la prueba funcional manual en navegador con la sesión real del usuario, guiada paso a paso.

### Pantalla en blanco en `http://192.168.1.10:3000` (encontrado y corregido)

- **Síntoma:** la app cargaba en blanco (solo la burbuja flotante del Chat IA y `BuildBadge`) tanto en Safari del iPhone como en Safari de la Mac al abrir la IP de red, pero no en `localhost`.
- **Error real de consola (confirmado por el usuario vía Web Inspector):** `WebSocket connection to ws://192.168.1.10:3000/_next/webpack-hmr?... failed: cannot parse response`.
- **Causa raíz:** el servidor de desarrollo de Next.js rechaza por seguridad el WebSocket de HMR cuando la página se abre desde un origen (`host`) que no está en `allowedDevOrigins` — el cliente de desarrollo se queda a medio inicializar y nunca termina de montar la app.
- **Corrección aplicada:** se agregó `allowedDevOrigins: ["192.168.1.10"]` a `next.config.ts` (única línea funcional nueva, con comentario explicando el motivo). Verificado con `npx tsc --noEmit` (sin errores), `npx eslint next.config.ts` (sin errores), reinicio completo del servidor, y confirmación del propio usuario en Safari (Mac e iPhone) de que la pantalla en blanco desapareció.
- **Alcance:** cambio exclusivo de configuración del servidor de desarrollo local — no afecta producción (Vercel no usa `next dev`).

### Verificación de proyecto/clave de Supabase local vs. producción (sin bloqueos, sin cambios)

Ante el hallazgo de que la misma cuenta sí inicia sesión en producción (`docente-ia-gules.vercel.app`) pero no en `192.168.1.10:3000`, se comparó la configuración sin exponer secretos:
- **Proyecto:** idéntico en ambos entornos (`abdtrkdfobrkramerrrc.supabase.co`).
- **Tipo de clave:** ambos usan el formato nuevo `sb_publishable_...` (no es la clave JWT legada) — la versión instalada de `@supabase/supabase-js` (2.108.2) lo soporta sin problema.
- **¿Es la misma clave?** No — distinta clave publishable en cada entorno (confirmado por checksum, sin exponer ningún valor), lo cual es normal y válido: Supabase permite múltiples claves publishable activas por proyecto.
- **Prueba de aceptación de la clave local:** `POST {url}/auth/v1/token?grant_type=password` con la clave local y credenciales de prueba obviamente falsas respondió `HTTP 400 {"error_code":"invalid_credentials"}` — confirma que la clave y el proyecto son correctos (un problema de clave habría dado `invalid_api_key`, no `invalid_credentials`).
- **Conclusión:** ni el proyecto ni la clave son la causa del fallo de login local. La causa es que la sesión de Supabase se guarda en `localStorage`, aislado por origen exacto — iniciar sesión en producción no deja ninguna sesión visible en `http://192.168.1.10:3000` (son orígenes distintos para el navegador). Nunca se había completado un login real en ese origen específico.
- Durante esta verificación, un comando (`cat -v`) mostró por accidente el valor completo de `NEXT_PUBLIC_SUPABASE_ANON_KEY` local en la salida de terminal — no es `service_role` ni una clave verdaderamente secreta (las `NEXT_PUBLIC_*` van embebidas en el bundle público por diseño), pero fue un descuido frente a la instrucción explícita de no imprimir valores. Registrado aquí por transparencia, no se repitió.

### Bloqueo de autenticación — recuperación de contraseña incompleta

Al intentar recuperar el acceso (contraseña no disponible para probar en este origen), se encontró que el proyecto **no tiene ningún flujo de recuperación/actualización de contraseña implementado**: sin páginas ni funciones para `resetPasswordForEmail`, `updateUser` con propósito de recuperación, ni ruta de "nueva contraseña". El correo de recuperación enviado desde el panel de Supabase redirige a una ruta local que no existe → **404**.

**La prueba funcional local de C-004 queda BLOQUEADA POR AUTENTICACIÓN** — no se pudo completar el flujo de crear proyecto → generar hoja → descargar PDF con una sesión real en este origen. No se intentaron más logins, no se modificaron enlaces, no se tocó ninguna contraseña, no se creó el proyecto de prueba.

**Confirmación importante que sí se conserva:** en producción (`docente-ia-gules.vercel.app`), con una sesión real, el docente, su grupo y sus alumnos SÍ cargan correctamente — es decir, la lógica de Lista/carga de contexto del docente ya funciona en producción; el problema de "No se pudo identificar al maestro" fue exclusivamente de sesión local en el origen de red, no un bug de la lógica de la aplicación.

## Lista maestra de pendientes — ACC-021 y ACC-022 (nuevos)

**ID:** ACC-021
**Nombre:** Acceso a Seguimiento poco claro (solo un ícono de copa)
**Módulo:** Lista / Seguimiento
**Tipo:** EXPERIENCIA DE USUARIO
**Estado:** PENDIENTE
**Prioridad:** P2
**Riesgo:** bajo (usabilidad, no funcional ni de datos)
**Archivos:** `app/dashboard/lista/page.tsx` (línea 387-394, botón 🏆)
**Dependencias:** ninguna
**Trabajo ya realizado:** identificado durante la prueba manual de C-004
**Trabajo pendiente:** diseñar un acceso claro, sencillo y rotulado como "Seguimiento", sin saturar la pantalla ni agregar menús redundantes
**Pruebas realizadas:** ninguna (hallazgo de observación directa)
**Pruebas pendientes:** validación de la nueva propuesta con el usuario antes de implementar
**Criterio de aceptación:** el acceso a Seguimiento es reconocible sin necesidad de adivinar el significado del ícono
**Bloque recomendado:** bloque independiente, posterior a que C-004 cierre por completo — explícitamente NO dentro de C-004
**No repetir:** no rediseñar este acceso dentro de C-004 ni de ningún bloque de seguridad/consolidación.

**ID:** ACC-022
**Nombre:** Falta flujo completo de recuperación y actualización de contraseña
**Módulo:** Autenticación
**Tipo:** FUNCIÓN NUEVA
**Estado:** PENDIENTE
**Prioridad:** P1
**Riesgo:** medio (bloquea el acceso legítimo de un docente que olvida su contraseña, sin alternativa dentro de la app)
**Archivos:** ninguno existe todavía (se necesitaría una pantalla de "nueva contraseña" que llame `supabase.auth.updateUser({ password })`, más la configuración de redirección de Supabase apuntando a esa ruta)
**Dependencias:** configuración de "Redirect URLs" en Supabase Authentication
**Trabajo ya realizado:** diagnóstico confirmado — el correo de recuperación de Supabase redirige a una ruta local inexistente y termina en 404
**Evidencia:** 404 real reproducido por el usuario al seguir el enlace del correo de recuperación
**Trabajo pendiente:** implementar un flujo seguro y completo (solicitud de recuperación + página de nueva contraseña + redirecciones configuradas correctamente en Supabase)
**Pruebas realizadas:** ninguna de código (no existe código todavía)
**Pruebas pendientes:** flujo completo de extremo a extremo una vez implementado
**Criterio de aceptación:** un docente puede recuperar y actualizar su contraseña sin intervención manual desde el panel de Supabase
**Bloque recomendado:** bloque independiente de Autenticación, prioridad alta — recomendado antes o junto con la simplificación de acceso de ACC-021
**No repetir:** no intentar más recuperaciones de contraseña ni cambios de enlaces hasta que este flujo se construya formalmente.

**ID:** UI-023
**Nombre:** Tarjeta redundante "VIENDO AHORA / inicio" en la barra lateral
**Módulo:** Sidebar / navegación
**Tipo:** EXPERIENCIA DE USUARIO
**Estado:** PENDIENTE
**Prioridad:** P2
**Riesgo:** nulo (solo visual/redundancia, no funcional)
**Archivos:** no identificados todavía (pendiente localizar el componente exacto de la barra lateral que dibuja esa tarjeta)
**Dependencias:** ninguna
**Trabajo ya realizado:** ninguno — solo acordado y registrado, sin diagnóstico de código todavía
**Trabajo pendiente:** eliminar completamente la tarjeta "VIENDO AHORA / inicio"; la única indicación de la sección actual debe ser el elemento activo del menú, sin una segunda tarjeta o bloque de estado
**Pruebas realizadas:** ninguna
**Pruebas pendientes:** confirmar visualmente que no queda ningún indicador duplicado de sección activa tras el cambio
**Criterio de aceptación:** ver "Criterio futuro" arriba — un solo indicador de sección activa, sin tarjeta redundante
**Bloque recomendado:** bloque independiente de diseño/sidebar, posterior al cierre de C-004
**No repetir:** no implementar este ajuste dentro de C-004; no modificar diseño todavía.

## Estado de C-004 al cierre de esta pausa

**Estado:** BLOQUEADO POR AUTENTICACIÓN (no por seguridad del código ni por falta de credenciales de entorno — ambas ya resueltas). Diagnóstico y pruebas técnicas completos (ver secciones anteriores); prueba funcional manual en navegador (crear proyecto → indicadores → guardar → generar hoja → descargar PDF) **no ejecutada todavía** — no se llegó a crear el proyecto de prueba.

**Correcciones de código ya verificadas y listas para revisión de commit (dentro de C-004):**
1. `app/api/proyectos-seguimiento/route.ts` — `try/catch` agregado al `GET` (consistencia con los `POST` del mismo archivo).
2. `next.config.ts` — `allowedDevOrigins: ["192.168.1.10"]` (desbloqueo de pruebas en dispositivos de la red local, solo entorno de desarrollo).

**Pendiente explícito antes de cerrar C-004 por completo:** recuperar el acceso local (ACC-022 o una alternativa manual vía el panel de Supabase) y completar la prueba funcional real de crear proyecto → generar hoja → descargar PDF.

## Cierre definitivo de C-004 (2026-08-01)

**Estado final: CERRADO — con alcance corregido respecto al objetivo original.**

C-004 se abrió como "consolidación y prueba funcional del módulo Seguimiento". Ese objetivo queda **parcialmente cumplido y parcialmente cancelado — no pendiente**:

**Cumplido y cerrado dentro de C-004:**
- Autenticación: recuperación de contraseña completa (`app/login/page.tsx`, `app/actualizar-contrasena/page.tsx`) — ACC-022 cerrado.
- Sincronización de sesión tras magic link (listener `onAuthStateChange` en `app/dashboard/lista/page.tsx` y en las pantallas de Seguimiento) — corrige la carrera entre `detectSessionInUrl` y el montaje del componente.
- Identificación correcta del docente, carga correcta del grupo y de los alumnos — confirmado con prueba real: Luis Manuel Ramírez, Francisco I. Madero, 4.º B, 28 alumnos (12 niñas, 16 niños).
- Corrección técnica del `GET` de `proyectos-seguimiento` (try/catch) y de la pantalla en blanco en red local (`allowedDevOrigins`).

**NO cumplido, y formalmente CANCELADO (no queda como pendiente de C-004):**
- La prueba funcional del formulario manual de Seguimiento (crear proyecto → indicadores → generar hoja → descargar PDF) **no se completó ni se completará dentro de C-004**. No es un pendiente abierto: el formulario manual (`app/dashboard/lista/proyectos/nuevo/page.tsx`) deja de ser el flujo definitivo por la decisión arquitectónica registrada abajo, así que validarlo como estaba habría sido esfuerzo desechable.
- El trabajo de Seguimiento (API, pantallas, endpoint `DELETE` construido en este bloque) **no se considera terminado ni validado como flujo definitivo** — se conserva sin commit, reutilizable, a la espera de C-005 en adelante.

## Decisión arquitectónica obligatoria — Seguimiento pertenece a Planeación (registrada 2026-08-01)

- Seguimiento deja de ser un módulo independiente accesible desde Lista; pertenece a **Planeación**.
- La estructura definitiva es: **Planeación → Proyecto → Hoja final de evaluación → impresión y llenado manual → fotografía → reconocimiento automático → confirmación de lecturas dudosas → historial individual del alumno → concentrado trimestral → reporte de evaluación → ficha descriptiva.**
- El acceso 🏆 en Lista (`app/dashboard/lista/page.tsx`) se retirará **cuando el flujo nuevo esté completo** — no antes, para no dejar al docente sin ninguna forma de usar Seguimiento durante la transición.
- "Nuevo proyecto de seguimiento" (`app/dashboard/lista/proyectos/nuevo/page.tsx`) deja de ser el flujo principal — el docente no volverá a capturar manualmente nombre, campos formativos, trimestre, fechas ni indicadores que ya existan en la planeación.
- Habrá una sola hoja final de evaluación por proyecto (ya es así en el código actual — `generarHojaSeguimientoPdf.ts` no cambia en esto).
- La hoja se imprime, se llena a mano, y se captura mediante fotografía desde Docente IA — la app reconoce proyecto, grupo, alumnos, indicadores y niveles/resultados marcados.
- Antes de guardar, solo se resaltan las lecturas dudosas para corrección mínima — nunca se pide recapturar todo.
- Los resultados confirmados alimentan: historial individual del alumno, concentrado trimestral (no existe hoy), reporte de evaluación (hoy PARCIAL/NO VERIFICADO), y ficha descriptiva (hoy no consume Seguimiento).
- Esta decisión reemplaza la premisa original de C-001/C-001B/C-002/C-003/C-004 de que Seguimiento sería un módulo independiente accesible desde Lista — se conserva el código ya construido (ver tabla de reutilización abajo), no se descarta nada.

## Código de Seguimiento conservado sin commit (reutilizable para C-005 en adelante)

Ninguno de estos archivos se revierte, se borra ni se archiva aparte — permanecen exactamente donde están, sin commit, hasta que el bloque correspondiente de Planeación los retome:

| Código | Reutilización prevista |
|---|---|
| `migrations/seguimiento_fase3.sql` (ya aplicada) | Las 4 tablas, sin cambios de esquema |
| `lib/seguimiento/tipos.ts` | Enums reutilizables tal cual |
| `lib/identificadorHoja.ts` | Función pura, reutilizable tal cual |
| `lib/documentGen/generarHojaSeguimientoPdf.ts` | Ya es la hoja final que pide el flujo nuevo |
| `lib/documentGen/almacenamiento.ts` (bucket + `eliminarArchivo`) | Reutilizable tal cual |
| `app/api/proyectos-seguimiento/route.ts`, `[id]/route.ts`, `[id]/hoja/route.ts`, `sugerir-indicadores/route.ts` | API reutilizable — cambiará quién la llama (Planeación en vez de un formulario), no la lógica interna |
| `app/dashboard/lista/proyectos/page.tsx`, `nuevo/page.tsx` | Se conservan sin commit; dejarán de ser el flujo principal cuando C-005+ esté listo |

**Riesgo abierto explícito:** el endpoint `DELETE /api/proyectos-seguimiento/[id]` (construido en este bloque) nunca se probó de extremo a extremo con un proyecto real — solo verificado por lectura de código y pruebas de autorización sin sesión (401/400). Debe probarse antes de confiar en él cuando se retome.

## Próximo bloque permitido

**C-005 — Construcción del módulo Planeación — Fase 1: modelo de datos y estructura funcional base.**

Alcance recomendado para C-005 (no iniciado, requiere autorización explícita aparte): diseñar el modelo de datos de una planeación real (hoy no existe ninguna tabla — Planeación hoy solo genera documentos sueltos vía Chat IA, sin registro estructurado) y construir la pantalla de Planeación como módulo funcional real (hoy es un stub de 34 líneas, "Próximamente"). NO incluye todavía: conexión con Seguimiento, generación automática de hoja, ni fotografía/reconocimiento — esas son fases posteriores (C-006, C-007...).

No se abre C-005 todavía. Pendientes que siguen abiertos e independientes de C-005: ACC-017 (diff mezclado de Lista), ACC-019 (texto engañoso en la ficha del alumno — ahora con solución definida dentro del flujo nuevo), ACC-020 (campo muerto en el formulario manual), ACC-021 (copa sin texto — con fecha de resolución ya definida: cuando el flujo nuevo esté completo), UI-023 (tarjeta redundante de sidebar). La migración de Seguimiento sigue CONFIRMADA/APLICADA (no volver a ejecutar).
