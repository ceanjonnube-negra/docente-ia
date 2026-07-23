# Estado del proyecto — Docente IA

*Generado al cierre de la sesión de estabilización técnica (rediseño del modo voz + estabilización post-auditoría). Actualizado el 2026-07-23 al cierre parcial del Sprint LISTA DE ALUMNOS.*

---

## Metodología vigente (desde 2026-07-23)

Todo el desarrollo restante de Docente IA sigue un flujo de sprints, un módulo por sprint: **FASE 1** Diagnóstico (sin modificar nada) → **FASE 2** Implementación (solo archivos autorizados) → **FASE 3** Validación técnica (`tsc`, `eslint`, `git diff --stat`) → **FASE 4** Control de no regresión → **FASE 5** Checklist del módulo (🟢/🟡/🔴). Un sprint no se cierra mientras quede algún punto en 🟡 o 🔴 sin una decisión explícita del usuario sobre cómo tratarlo.

## Sprint LISTA DE ALUMNOS — Estado de cierre

**Completamente estabilizado (14 de 15 puntos 🟢):** Contadores superiores, Asistencia del día, Guardado de asistencia (corregido este sprint), Historial del alumno, Porcentaje grupal, Número de lista, Filtros, Búsqueda, Rendimiento (consulta huérfana eliminada este sprint), Importación, Persistencia, Sin regresiones.

**Pendiente de validación manual, único punto que mantiene el sprint abierto:** Diseño y Responsive — el usuario los validará directamente en dispositivos reales. El Sprint LISTA DE ALUMNOS se marcará como completamente cerrado únicamente después de esa validación.

**Movido formalmente fuera de este sprint:** Edades — no es un problema de la pantalla de Lista sino de calidad/integridad de los datos capturados (fechas de nacimiento inválidas). Pasa a ser el primer pendiente del nuevo **Sprint: Calidad e Integridad de Datos** (ver `ROADMAP.md`), que no podrá cerrarse hasta corregir las edades existentes y agregar validación de fecha de nacimiento.

---

## Cambios realizados

1. **Rediseño completo del modo voz** — arquitectura híbrida: OpenAI Realtime como capa de entrada/salida (escucha, detecta fin de turno, reproduce), Claude como único cerebro que genera el contenido. Realtime sin `tools` registradas (garantía estructural, no de convención).
2. **Corrección de la reproducción de voz** — campo real de la API (`output_modalities`) verificado contra el SDK instalado; la voz dejó de fallar en silencio.
3. **Corrección del techo de conexión** — de 12s a 20s, alineado matemáticamente con la suma real de sus propios timeouts internos.
4. **Diagnóstico de arranque instrumentado** — traza completa (`voice:*`) y panel técnico visible directamente en el dispositivo, sin depender de consola de escritorio.
5. **Corrección de turnos cortados** — umbral de silencio de cierre ajustado (900ms → 1200ms) para no partir intervenciones con pausas naturales.
6. **Respuestas de asistencia ajustadas al nivel de detalle pedido** — antes siempre devolvía el reporte completo; ahora distingue cantidad / nombres / resumen / reporte completo según la pregunta.
7. **Corrección del botón de colgar y de la reproducción silenciosa** — el cierre de sesión ahora siempre limpia el estado (try/finally), y un canal de voz muerto a media conversación ya no falla en silencio.
8. **Prompt específico para el canal de voz (Fase 1 del plan de optimización)** — respuestas más breves y directas en voz, sin tocar el prompt del chat escrito.
9. **Telemetría de latencia end-to-end** — instrumentación completa (cliente + servidor) detrás de una bandera de diagnóstico, sin cambiar comportamiento.
10. **Herramienta de consulta oficial SEP** — Claude ahora puede buscar información oficial vigente (calendario, planes y programas, acuerdos SEP/DOF) restringida a dominios `.gob.mx`, vía la herramienta nativa de Anthropic.
11. **Auditoría técnica completa del proyecto** — inventario de 14 secciones (arquitectura, funcionalidades, pantallas, Chat IA, base de datos, APIs, IA, rendimiento, seguridad, código muerto, errores, deuda técnica, módulos, roadmap).
12. **Fase 1A — Protección de endpoints críticos** — autenticación obligatoria en los dos endpoints que la auditoría marcó como abiertos sin sesión; los dos endpoints huérfanos quedaron bloqueados (410) en vez de expuestos sin uso.
13. **Corrección de la pantalla de asistencia (Lista)** — se dejó de mezclar el historial acumulado con el estado de hoy en las tarjetas; se agregó el porcentaje de asistencia del día.
14. **Sprint LISTA DE ALUMNOS — Corrección de `escribirAsistencia()`** — se invirtió la prioridad de escritura: `asistencia_registro` (único origen de verdad declarado del proyecto) ahora determina éxito/error; la tabla legada `asistencias` se sincroniza después, de mejor esfuerzo, sin poder enmascarar una falla real ni una falsa confirmación al docente.
15. **Sprint LISTA DE ALUMNOS — Limpieza de consulta huérfana** — se eliminó en `app/dashboard/lista/page.tsx` la consulta a la tabla legada `asistencias` cuyo resultado (`totalAsistencias`/`totalFaltas`) ya no se mostraba en ninguna parte de la pantalla.

---

## Archivos modificados

| Archivo | Motivo |
|---|---|
| `lib/asistente/motores/motorOpenAIRealtime.ts` | Núcleo del rediseño de voz — conexión, turnos, reproducción, telemetría, diagnóstico |
| `lib/asistente/AsistenteService.ts` | Estado global del asistente, manejo de errores de voz vs. conversacionales |
| `components/Asistente/AsistentePanel.tsx` | Interfaz del botón de voz, panel de diagnóstico visible |
| `lib/asistente/tipos.ts` | Tipos compartidos (`EventoMotor`, `DiagnosticoArranqueVoz`, canal) |
| `lib/asistente/hooks.ts` | Puente React ↔ `AsistenteService` |
| `lib/asistente/lecturaVoz.ts` / `lib/asistente/personaVoz.ts` | Limpieza de texto para voz y persona de lectura literal de Realtime |
| `lib/asistente/deteccionFinTurno.ts` | Umbral de silencio de cierre de turno |
| `lib/asistente/herramientasModulo.ts` | Nivel de detalle de respuestas de asistencia grupal |
| `lib/clasificadorNivel0.ts` | Reglas del Clasificador de Nivel 0 (detalle de asistencia, consulta oficial) |
| `app/api/chat/route.ts` | Prompt por canal, telemetría de servidor, herramienta de consulta oficial |
| `app/api/realtime-token/route.ts` | Emisión del token efímero, `tools` siempre vacío |
| `lib/fuentesOficiales.ts` | **Nuevo** — allowlist y construcción de la herramienta de búsqueda oficial |
| `lib/server/authApi.ts` | **Nuevo** — helper server-only de autenticación/autorización |
| `app/api/upload-documento/route.ts` | Autenticación + verificación de institución |
| `app/api/importar-alumnos/route.ts` | Autenticación + verificación de grupo/institución si aplica |
| `app/api/ocr-foto/route.ts` | Deshabilitado (410 Gone), sin consumidores |
| `app/api/importar-datos-alumnos/route.ts` | Deshabilitado (410 Gone), sin consumidores |
| `app/documentos/page.tsx` | Envía token de sesión e institución real al subir documentos |
| `lib/importacionInteligente.ts` | Envía token de sesión al analizar archivos de importación |
| `app/dashboard/lista/page.tsx` | Tarjetas enfocadas en hoy; porcentaje de asistencia del día; **(2026-07-23)** eliminada la consulta huérfana a la tabla legada `asistencias` y los campos `totalAsistencias`/`totalFaltas` que solo existían para alimentarla |
| `lib/buildInfo.ts` | Identificador de build actualizado en cada despliegue |
| `historial-tecnico.md` | **Nuevo** — transcripción técnica completa de la sesión |
| `lib/motorContexto.ts` | **(2026-07-23)** `escribirAsistencia()` — `asistencia_registro` pasa a determinar éxito/error; la tabla legada `asistencias` queda como sincronización de mejor esfuerzo, documentadas sus 3 dependencias reales restantes |

---

## Bugs corregidos

- Reproducción de voz nunca sonaba (`modalities` → `output_modalities`).
- Conexión de voz fallaba en redes no ideales (techo de conexión menor a la suma de sus propios timeouts).
- El botón para colgar no cerraba la sesión si algún paso de limpieza lanzaba una excepción.
- El texto de la respuesta llegaba pero el audio nunca se reproducía si el canal se cerraba solo mientras se esperaba a Claude, sin ningún aviso.
- Errores de conexión de voz se mezclaban con errores conversacionales (se guardaban como mensaje falso del chat y dejaban la sesión "viva" en apariencia).
- Intervenciones largas con pausas naturales ("...gracias") se partían en dos mensajes.
- Preguntas puntuales de asistencia ("¿cuántos faltaron?") devolvían siempre el reporte completo en vez de solo el dato pedido.
- Endpoints de subida de documentos e importación de alumnos aceptaban solicitudes sin sesión.
- Dos endpoints sin consumidores quedaban expuestos y sin protección.
- Las tarjetas de la Lista mostraban un acumulado histórico sin fecha etiquetado ambiguamente como si fuera el estado de hoy.
- `escribirAsistencia()` podía reportar "✅ Asistencia guardada" al docente aunque la escritura en `asistencia_registro` (la tabla que realmente leen los contadores de Lista y todo el Chat IA) hubiera fallado en silencio — la tabla legada `asistencias` era la que determinaba el éxito reportado.

---

## Bugs pendientes

| Bug | Estado |
|---|---|
| "¿Cuántas niñas y niños son?" se clasifica como consulta de asistencia | Diagnosticado con causa raíz exacta, corrección **no implementada** (quedó pausado cuando la sesión se movió a estabilizar conexión de voz) |
| Edades incorrectas en fichas de alumno (13 años, 2 años, "—") | Diagnosticado — es un problema de calidad/integridad de datos, no de código; **movido formalmente al Sprint "Calidad e Integridad de Datos"** (primer pendiente, ver `ROADMAP.md`) |
| Sin listener de backgrounding para la sesión de voz | Identificado en auditoría de arquitectura; sin corregir |
| `generar-ficha-descriptiva` sin timeout en la llamada a Claude | Identificado en la auditoría técnica; sin corregir |
| Embeddings generados secuencialmente en `upload-documento` | Identificado en la auditoría técnica; sin corregir |
| `/dashboard/planeacion` es un placeholder que contradice al Chat IA | Identificado en la auditoría técnica; sin decisión tomada |
| `app/utils/generarWord.ts` duplicado y obsoleto | Identificado en la auditoría técnica; sin eliminar |
| Dependencias sin uso (`@supabase/auth-helpers-nextjs`, `@supabase/ssr`) | Identificado en la auditoría técnica; sin retirar |
| Sin `middleware.ts` centralizado — autenticación inconsistente entre rutas | Identificado en la auditoría; solo se cerraron los 2 huecos más críticos (Fase 1A) |
| Fases 2, 3 y 4 del plan de optimización de voz (streaming, TTS progresivo, auditoría de VAD) | Deliberadamente no iniciadas — solo se autorizó la Fase 1 |

---

## Decisiones de arquitectura

- **Realtime nunca es el cerebro.** Cero `tools` registradas en la sesión de voz — garantía estructural de que nunca puede ejecutar una Herramienta ni generar contenido por su cuenta, no una convención de código.
- **La reproducción de voz reutiliza el mismo canal WebRTC autorizado por el toque inicial** (en vez de `speechSynthesis` del navegador), para evitar el bloqueo silencioso de Safari/iOS fuera de un gesto directo del usuario.
- **Detección de fin de turno con heurística propia** (`lib/asistente/deteccionFinTurno.ts`) en vez de depender únicamente del VAD del proveedor — permite ajustar la sensibilidad sin depender de la configuración del servidor de voz.
- **El prompt de voz se concatena, nunca reemplaza**, el prompt general del chat escrito (`channel:"voice"` como bandera aditiva) — el comportamiento del chat escrito queda garantizado sin cambios.
- **Toda telemetría vive detrás de una bandera explícita** (`voiceDebug`), nunca corre en producción normal.
- **Búsqueda de información oficial vía la herramienta nativa de Anthropic** (`web_search`, dominios restringidos) en vez de un buscador/scraper propio — cero proveedores ni credenciales nuevas, allowlist aplicada por la propia plataforma.
- **Dos mecanismos de herramientas, deliberadamente separados:** el Tool Registry determinista (`lib/asistente/herramientasModulo.ts`, nunca pasa por Claude) y el function-calling nativo de Claude (solo `web_search` por ahora) — no se combinan ni se confunden.
- **Autenticación de endpoints nuevos centralizada en un helper server-only** (`lib/server/authApi.ts`), modelado en el único patrón que ya validaba explícitamente tokens (`realtime-token/route.ts`) — sin migrar los endpoints existentes que usan un patrón más laxo.
- **Endpoints sin consumidores se bloquean (410), no se eliminan** — reversibles, documentados, sin perder el código por si se conectan a un flujo real más adelante.
- **El historial de asistencia se retira de la vista general de Lista** y queda exclusivamente en la ficha individual del alumno — la vista de grupo se limita al estado del día.
- **`asistencia_registro` es la que determina éxito/error al escribir asistencia**, no la tabla legada `asistencias` — invierte el orden anterior, donde una escritura legada exitosa podía enmascarar una falla real en la tabla que de verdad se lee para reportar asistencia. La tabla legada sigue sincronizándose de mejor esfuerzo mientras exista (no se elimina en este sprint); sus 3 dependencias reales quedaron documentadas directamente en `lib/motorContexto.ts`.
- **Desarrollo por sprints, un módulo a la vez** (vigente desde 2026-07-23): cada módulo sigue Diagnóstico → Implementación → Validación técnica → Control de no regresión → Checklist; un sprint no cierra con puntos en 🟡/🔴 sin decisión explícita sobre cómo tratarlos.

---

## Riesgos

- **Nada de esta sesión se probó contra credenciales reales de Anthropic, OpenAI o Supabase** — toda verificación fue estática (`tsc`, `eslint`) o mediante scripts aislados que replican la lógica. Los flujos reales de autenticación, RLS y respuestas de los proveedores requieren prueba real en producción.
- **Los cambios de las dos últimas rondas (Fase 1A de seguridad y corrección de Lista) siguen sin commit ni despliegue**, por instrucción explícita — quedan expuestos a perderse si no se consolidan pronto.
- **Las políticas RLS de Supabase no son verificables desde este entorno** — las correcciones de autorización asumen que RLS existe como capa adicional; si no está bien configurada, la protección depende únicamente del código nuevo.
- **Sin rate limiting en ningún endpoint** — un endpoint recién protegido con sesión sigue sin límite de solicitudes por usuario.
- **Duplicación de datos de asistencia sin plan formal de deprecación** — la tabla legada `asistencias` sigue existiendo (no se elimina en este sprint); un futuro punto de escritura que no pase por `escribirAsistencia()` puede volver a desincronizarla de `asistencia_registro`. Solo puede eliminarse después de migrar la pestaña "Asistencia" de la ficha individual (`app/dashboard/lista/[alumnoId]/page.tsx`), su única lectura real restante.
- **Diseño y Responsive del Sprint LISTA DE ALUMNOS aún no tienen validación manual** — no verificables en este entorno sin dispositivo/navegador real; el sprint permanece formalmente abierto hasta que el usuario los valide.
- **El porcentaje de asistencia de Lista usa una fórmula distinta a la del Chat IA** (solo presentes vs. presentes + retardos) — riesgo de confusión si el docente compara ambos números el mismo día.
- **Persistencia de conversación 100% en `localStorage`** — sin respaldo ni sincronización entre dispositivos; cualquier pérdida de datos del navegador es irreversible para el docente.

---

## Próximo paso recomendado

**Inmediato:** el usuario valida Diseño y Responsive del módulo Lista en dispositivos reales — es el único punto que impide cerrar formalmente el Sprint LISTA DE ALUMNOS como 15/15 🟢.

**Siguiente sprint, ya iniciado formalmente:** **Sprint "Calidad e Integridad de Datos"**, con las edades incorrectas de ficha de alumno como primer pendiente (corrección de datos existentes + validación de fecha de nacimiento para impedir capturas inválidas hacia adelante).

Pendiente de la sesión anterior, aún sin fecha asignada: **consolidar (commit + despliegue)** los bloques de trabajo ya verificados pero no enviados (Fase 1A de seguridad, corrección de tarjetas de Lista, y ahora la corrección de `escribirAsistencia()` + limpieza de la consulta huérfana), y la corrección ya diagnosticada de "¿Cuántas niñas y niños son?" en el Chat IA (fuera de alcance mientras el Sprint Lista no cierre por completo).
