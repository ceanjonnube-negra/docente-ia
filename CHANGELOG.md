# Changelog — Docente IA

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.0.0/). Fechas en `AAAA-MM-DD`. Este archivo se actualiza al cerrar cada sprint o tarea relevante; el historial anterior a esta fecha fue reconstruido a partir de `git log`.

## [Unreleased]

### Fixed — Regresión: doble menú al importar en Lista (2026-07-23)
- `components/ImportacionInteligente.tsx`: el botón "Importar" volvía a mostrar el selector nativo del sistema operativo (Fototeca/Tomar foto/Elegir archivo) encima del menú propio de la app al elegir "Fotos" o "Archivos" — mismo bug ya diagnosticado y corregido para el Chat IA (commit `d388bd7`), pero explícitamente dejado sin corregir en Lista en ese momento a cambio de conservar selección múltiple de fotos. Se aplicó el mismo patrón ya validado en producción: un solo `<input type="file">` nativo disparado directamente por el botón, sin menú propio delante — el sistema operativo muestra su único selector en un solo toque, conservando la selección múltiple. Afecta también a `app/dashboard/grupos/[id]/importar/page.tsx` (mismo componente compartido).
- `components/ui/MenuAdjuntos.tsx` queda sin ningún consumidor en el proyecto tras este cambio — no se eliminó en este paso (fuera de alcance de esta corrección puntual).

### Fixed — Sprint LISTA DE ALUMNOS (cierre parcial, 2026-07-23)
- `escribirAsistencia()` (`lib/motorContexto.ts`): la escritura en `asistencia_registro` (único origen de verdad declarado del proyecto) ahora es la que determina éxito/error; antes, una escritura exitosa en la tabla legada `asistencias` podía reportar "✅ Asistencia guardada" al docente aunque `asistencia_registro` hubiera fallado en silencio. La tabla legada se sigue sincronizando después, de mejor esfuerzo, sin eliminarse.

### Removed — Sprint LISTA DE ALUMNOS (cierre parcial, 2026-07-23)
- `app/dashboard/lista/page.tsx`: eliminada la consulta huérfana a la tabla legada `asistencias` y los campos `totalAsistencias`/`totalFaltas` que solo existían para alimentarla (ninguno se mostraba ya en pantalla). `asistencia_registro` queda como única fuente de asistencia usada por esta pantalla.

### Added
- Acceso visible al módulo **Lista** desde la pantalla principal (`/dashboard`): tarjeta "Lista" junto a Historial.
- Acceso visible al módulo **Lista** desde el drawer/menú lateral del Chat IA (`/dashboard/chat`), justo después de "Chat IA".

### Fixed
- El módulo Lista (centro del seguimiento grupal e individual según las reglas del proyecto) ya no es una ruta huérfana: antes solo era alcanzable escribiendo la URL manualmente.
- Se agregó asistencia (marcar presente/falta) directamente desde `/dashboard/lista`, reutilizando `/api/asistencia-guardar` sin cambios.

### Added — Ficha Inteligente del Alumno (Etapa 1 de 4)
- Encabezado enriquecido en `/dashboard/lista/[alumnoId]`: grado y grupo (vía `grupos`), sexo, edad e indicador de estado general ("Al corriente" / "Requiere atención" / "Sin datos suficientes"), calculado solo con datos reales de asistencia e incidencias.
- Nueva pestaña **Resumen** con tarjetas reales de % de asistencia, faltas, incidencias, evaluaciones, evidencias y última actividad registrada; cada tarjeta navega a su pestaña correspondiente.
- Pestaña **Incidencias** ahora muestra también el campo real `seguimiento` (antes no se leía), con un renderizador seguro que nunca imprime JSON crudo.
- Carga de datos en paralelo (`Promise.allSettled`) con manejo de error independiente por sección (asistencia, incidencias, evaluaciones, evidencias), para que una tabla no disponible no rompa el resto de la ficha.

### Added — Ficha Inteligente del Alumno (Etapa 2 de 4: Evaluaciones)
- Nueva pestaña **Evaluaciones** en `/dashboard/lista/[alumnoId]`, mostrando solo campos reales de la tabla `evaluaciones`: campo formativo, periodo (texto tal como se guardó, sin inventar "trimestres"), calificación y fecha (`creado_en`).
- La rúbrica (`rubrica`, jsonb) se muestra con el mismo renderizador seguro ya usado para `incidencias.seguimiento` — nunca imprime JSON crudo, ni asume claves que no estén presentes.
- No se agregaron los campos "Contenido", "Instrumento", "Nivel de logro" ni "Observaciones" porque no existen como columnas en la tabla real (confirmado inspeccionando el esquema de Supabase); si en el futuro viven dentro de `rubrica`, aparecerán automáticamente sin cambios de código.
- Reutiliza la consulta a `evaluaciones` ya cargada desde la Etapa 1 — no se agregó ninguna llamada nueva a Supabase.

### Added — Ficha Inteligente del Alumno (Etapa 3 de 4: Evidencias)
- Nueva pestaña **Evidencias** en `/dashboard/lista/[alumnoId]`, con los 4 campos reales de la tabla `evidencias`: tipo, descripción, fecha (`creado_en`) y enlace "📎 Abrir archivo" cuando `archivo_url` existe (sin simular carga de archivos).
- Reutiliza la consulta a `evidencias` ya cargada desde la Etapa 1 — no se agregó ninguna llamada nueva a Supabase.

### Added — Ficha Inteligente del Alumno (Etapa 4 de 4: Necesidades de apoyo)
- Nueva pestaña **Necesidades de apoyo** en `/dashboard/lista/[alumnoId]`, con los campos reales de la tabla `necesidades_apoyo`: tipo, descripción, fecha (`creado_en`) y estado **Activa/Inactiva** (columna real `activa`).
- Se agregó una consulta nueva a `necesidades_apoyo` (filtrada por `alumno_id`), cargada en paralelo junto con el resto de la ficha, con su propio manejo de error independiente.
- No se modificó el indicador de estado general del encabezado (sigue basado solo en asistencia e incidencias, como en la Etapa 1); queda como posible mejora futura si se desea incluir necesidades de apoyo activas en ese cálculo.

### Added — Ficha Inteligente del Alumno (Etapa 5: Fichas descriptivas e Historial)
- Nueva pestaña **Fichas descriptivas**, con los campos reales de `fichas_descriptivas`: periodo y fecha (`creado_en`); el contenido (`contenido`, jsonb) se muestra con el mismo renderizador seguro genérico, nunca como JSON crudo.
- Nueva pestaña **Historial**, línea de tiempo cronológica unificada (más reciente primero) construida solo con datos reales de `asistencias`, `incidencias`, `evaluaciones`, `evidencias` y `perfil_alumno_notas` — esta última filtrada en la propia consulta con `.neq('estado', 'pendiente_confirmar')`, para no mostrar como hecho ninguna nota generada por IA que el docente no haya confirmado.
- Cada elemento del historial indica tipo de actividad, fecha, descripción breve y origen (Asistencia/Incidencia/Evaluación/Evidencia/Nota); sin duplicados, cada registro real aporta exactamente un elemento.
- Se agregaron dos consultas nuevas (`fichas_descriptivas`, `perfil_alumno_notas`), cargadas en el mismo `Promise.allSettled` que el resto, cada una con su propio manejo de error.
- Necesidades de apoyo y Fichas descriptivas **no** se incluyeron como fuentes del Historial, siguiendo el alcance original acordado (solo asistencias/incidencias/evaluaciones/evidencias/notas confirmadas); puede ampliarse más adelante si se solicita.
- Con esta etapa se completa la arquitectura acordada de la Ficha Inteligente del Alumno: Resumen, Datos, Asistencia, Incidencias, Evaluaciones, Evidencias, Necesidades de apoyo, Fichas descriptivas, Historial.

### Changed — Ficha Inteligente del Alumno (Rediseño visual, 1ª pasada)
- Rediseño completo del JSX/estilos de `/dashboard/lista/[alumnoId]` (encabezado con degradado e iniciales del alumno, selector de pestañas con iconos, tarjetas unificadas `rounded-2xl` con sombra) sin tocar ninguna consulta a Supabase, estado ni función existente. Las 9 pestañas y el guardado de Datos quedan intactos.

### Changed — Ficha Inteligente del Alumno (Refinamiento visual, 2ª pasada)
- Encabezado más compacto: el botón de regreso y la insignia de estado comparten la misma fila (antes en filas separadas), reduciendo la altura total; degradado más profundo (`purple-700 → blue-600`) y botón de regreso de 40×40px con `aria-label`.
- Selector de pestañas con mayor tamaño táctil (`py-2.5`, texto `text-sm`), scrollbar oculto y un degradado sutil en el borde derecho (solo móvil) que indica que hay más pestañas al deslizar.
- Resumen: se agregó la tarjeta faltante **Necesidades de apoyo** (dato real ya cargado, sin consulta nueva) y el grid pasa de 2 columnas fijas a 2→3 según el ancho de pantalla, eliminando el espacio vacío que dejaba la tarjeta "Última actividad".
- Sistema de color por categoría aplicado con moderación (fondos tenues, no saturados) en tarjetas de Resumen, listas (Incidencias, Evaluaciones, Evidencias, Necesidades, Fichas) e Historial: verde/rojo/ámbar/violeta/azul/naranja/índigo según el tipo de registro.
- Todas las listas (Asistencia, Incidencias, Evaluaciones, Evidencias, Necesidades, Fichas, Historial) pasan a `grid sm:grid-cols-2` para aprovechar el espacio en escritorio, manteniendo una columna en móvil.
- Pestaña Datos: los 4 campos pasan a grid de 2 columnas en pantallas ≥640px (mismos `onChange`/`guardarDatos`, sin cambios de lógica).
- Contenedor general ampliado de `max-w-2xl` a `max-w-3xl` con más aire lateral en escritorio (`lg:px-8`).
- Estados vacíos ("Sin registros...") unificados en un componente de presentación `EstadoVacio` (icono + mensaje centrado); banners de error unificados en `BannerError`. Mismos textos y condiciones exactas que antes.
- Accesibilidad: `focus:ring` visible agregado a botones/enlaces interactivos que no lo tenían, `aria-hidden` en iconos decorativos (siempre acompañados de texto) y `aria-label` en el botón de regreso.

---

## 2026-07-14 — Periodos de evaluación y cierre de datos de Lista

### Added
- Tabla y pantalla de periodos de evaluación (`/dashboard/periodos-evaluacion`, `/api/periodos-evaluacion`).
- Importación de CURP/sexo/fecha de nacimiento desde foto de la lista oficial (`/api/importar-datos-alumnos`).
- Ficha individual de alumno con datos editables (`/dashboard/lista/[alumnoId]`).
- Nueva pantalla Lista con conteos y ficha por sexo (`/dashboard/lista`).
- Carga automática de grupo y alumnos en Asistencia.

### Fixed
- Uso de `H`/`M` para sexo según el constraint real de la base de datos.
- `numero_lista` agregado a la importación de datos.

## 2026-07-13 — Estabilización de Grupos e importación

### Added
- Flujo de alta de grupo (`/dashboard/grupos/nuevo`) y configuración inicial.
- Importación de lista oficial por foto/Excel/PDF/Word (`/dashboard/grupos/[id]/importar`, `/api/importar-alumnos`).

### Fixed
- Sesión de usuario pasada correctamente en `asistencia-foto` para resolver políticas RLS.
- Uso de `grupo_id` en vez de `grupo` al insertar alumnos.
- Validación de errores en `asistencia-guardar` y uso correcto de sesión.
- Selección de foto desde galería o cámara en Asistencia.
- Build: `pdf-parse` con `as any` y reordenado antes de `.default`; `JSX.Element` reemplazado por `ReactNode` en `grupos/nuevo`.

## 2026-07-10 — Clasificador de Nivel 0

### Added
- Etapa 2: Clasificador de Nivel 0 integrado al Chat IA (`lib/clasificadorNivel0.ts`, `lib/sesionContexto.ts`), enrutando `consultar_asistencia`, `ficha_descriptiva` y `planeacion_nueva` hacia el Motor de Contexto.

### Changed
- Reordenado del menú: Asistencia debajo de Chat IA.

## 2026-07-07 — 2026-07-08 — Visión directa y procesos activos

### Added
- Envío de fotos directo a Claude Vision en Chat IA (sin OCR intermedio).
- Contexto adicional al texto OCR de fotos.
- Botón de cámara en Chat IA.
- Persistencia de "proceso activo" para continuar tareas largas de varios elementos (planeaciones, fichas, exámenes) sin reiniciar.

### Fixed
- Cliente Supabase unificado (evita error 400) y regex de CURP corregido en `generarWord`.
- Marcador técnico `[[PROCESO:...]]` oculto del texto mostrado al maestro.
- Mensaje original guardado en el contexto del proceso activo para continuar tareas correctamente.

## 2026-07-06 — Rediseño de navegación

### Added
- Rediseño de sidebar con menú de iconos.
- Nuevas pantallas: Planeación, Asistencia, Seguimiento (como stubs/placeholders).
- Filtro de documentos institucionales por `institucion_id`, incluyendo documentos globales SEP.

### Changed
- Rediseño del drawer: ícono de manzana abre el menú; dropdown para subir documentos/configuración.

### Fixed
- Eliminada flecha de regreso duplicada en el header del chat.

## 2026-07-02 — 2026-07-03 — RAG de documentos institucionales

### Added
- Endpoint de subida de documentos institucionales con generación de embeddings (`/api/upload-documento`).
- Conexión del Chat IA con búsqueda RAG de documentos institucionales.
- Pantalla de subida de documentos institucionales (`/documentos`).
- Citación de fuente en respuestas RAG del chat, distinguiendo SEP de documentos internos de la escuela.
- Captura de cámara y OCR con visión de OpenAI.
- Plantilla de exámenes y actividades en el Chat IA.
- Menú lateral con historial de documentos y botón de nuevo chat.

### Fixed
- Envío de contexto formateado (en vez del objeto `perfil` crudo) al chat.
- Tipos de TypeScript para `pdf-parse` y `mammoth`; dependencias agregadas.

## 2026-06-30 — 2026-07-01 — Rediseño visual y voz

### Added
- Calendario escolar SEP 2026-2027 con eventos precargados.
- Rediseño del dashboard tipo "rueda" de navegación, logo oficial, pantalla Seguimiento (NEM).
- Comando de voz en el Chat IA.
- Botón para eliminar documentos del historial.
- Rediseño visual de la exportación a Word (títulos con color, secciones con fondo, bullets reales).

### Fixed
- Errores de TypeScript en el build y en archivos de Supabase.
- Carpeta `src` sobrante eliminada.

## 2026-06-28 — 2026-06-29 — Base de la aplicación

### Added
- Login, registro, onboarding, dashboard y Chat IA iniciales.

### Fixed
- Columna `id` usada en vez de `user_id` en la consulta de perfil docente.
- Extracción de campo formativo desde el texto generado en vez de depender solo del perfil.

## 2026-06-26 — Inicio del proyecto

### Added
- Commit inicial generado por `create-next-app`.

---

## Plantilla para el próximo sprint

```
## AAAA-MM-DD — Título breve del sprint/tarea

### Added
-

### Changed
-

### Fixed
-

### Removed
-
```
