// lib/asistente/instruccionesFichaDescriptiva.ts
//
// FD-3 — fragmento de instrucciones para la intención ficha_descriptiva,
// inyectado en contextoEnriquecido SOLO en el turno donde aplica (mismo
// patrón que INSTRUCCIONES_PLANEACION_GENERAR, ver
// lib/asistente/instruccionesPlaneacionGenerar.ts) — nunca contamina el
// resto de las respuestas del Chat.
//
// El bloque de evidencia que precede a este texto en contextoEnriquecido
// (ver app/api/chat/route.ts, rama ficha_descriptiva) viene de
// contextoPedagogicoAlumno() (lib/motorContexto.ts): cuatro fuentes ya
// existentes compuestas sin interpretación (contextoAlumno,
// resultadosProyectoAlumno, consultarAsistenciaAlumno, incidenciasAlumno).
// Este texto solo instruye CÓMO redactar a partir de esos datos — nunca
// agrega una fuente nueva ni una llamada de IA adicional.

export const INSTRUCCIONES_FICHA_DESCRIPTIVA = `FICHA DESCRIPTIVA — reglas para este turno.

Arriba tienes, en "CONTEXTO REAL DEL ALUMNO PARA LA FICHA DESCRIPTIVA", cuatro bloques de evidencia real, cada uno de una fuente distinta: A) contexto base del alumno, B) resultados académicos confirmados (seguimiento de proyectos, ya revisados y confirmados por el docente — nunca staging ni lecturas sin confirmar), C) asistencia (resumen canónico) y D) incidencias registradas. Redacta la ficha EXCLUSIVAMENTE a partir de esos cuatro bloques — nunca inventes ni infieras datos, características personales, académicas o conductuales que esos bloques no respalden directamente.

SEMÁNTICA DE AUSENCIA — diferencia siempre "no existe evidencia registrada" de "existe evidencia de que no hay problema/necesidad"; estos dos nunca significan lo mismo:
- B) resultadosProyectos vacío ([]) significa únicamente que no hay resultados confirmados disponibles todavía — NUNCA lo interpretes como buen desempeño ni como bajo desempeño del alumno.
- D) incidencias.incidencias vacío ([]) significa únicamente que no se recuperaron incidencias registradas — NUNCA afirmes que el alumno nunca ha presentado dificultades conductuales; solo úsalo para decir que no hay registros, nunca como conclusión sobre su conducta real.
- Esta ficha NO consulta todavía necesidades de apoyo registradas explícitamente — por eso tienes PROHIBIDO escribir que el alumno "no necesita apoyo" o equivalente; si mencionas necesidades de apoyo, hazlo ÚNICAMENTE cuando B) o D) las respalden directamente (p. ej. un nivel "requiere_apoyo" confirmado, o una observación/incidencia real que lo sugiera) — nunca por la sola ausencia de un registro explícito.

ASISTENCIA (C) — preséntala siempre como dato observado sobre el periodo disponible, nunca como un patrón estable o una conclusión general: si "dias_registrados" es bajo, dilo explícitamente (por ejemplo, "en los N días con registro disponible no presenta faltas") en vez de una frase como "mantiene excelente asistencia", que generalizaría sobre un periodo mucho más largo del que en realidad se registró.

EVIDENCIA ACADÉMICA (B) — los resultados confirmados (nivel, aspecto_general, indicador_especifico, confianza, observacion si existe) SÍ son evidencia real. NIVEL COMO CORTE PUNTUAL: un nivel confirmado (p. ej. "en_proceso") describe únicamente el resultado de ESA evaluación — por sí solo NUNCA permite afirmar qué parte concreta del indicador ya domina el alumno, qué parte concreta falla, que "muestra avances", que "está mejorando", ni que "está desarrollando"/"está construyendo" una habilidad como trayectoria temporal (eso exigiría más de un resultado confirmado del mismo indicador en fechas distintas, que hoy no tienes); tampoco permite afirmar una dificultad permanente ni una necesidad de apoyo registrada. Cuando solo tengas nivel + indicador, sin "observacion" ni otra evidencia que agregue precisión, usa una formulación prudente como "Este aprendizaje se encuentra en proceso y conviene continuar fortaleciéndolo" — puedes adaptar la redacción al indicador, pero sin descomponerlo en sub-logros o sub-dificultades que el dato no distingue. Si un resultado trae "observacion", esa sí es evidencia real adicional: puedes usarla tal cual (sin reescribirla como si fuera tuya) y, solo en ese caso, ser más específico, estrictamente limitado a lo que esa observación demuestra.

ÁREAS DE TRABAJO DERIVADAS — los indicadores en_proceso pueden sintetizarse como aspectos que conviene continuar fortaleciendo, áreas sugeridas de trabajo, u orientaciones pedagógicas derivadas de la evaluación — nunca deben escalarse por sí solos a necesidades de apoyo registradas, diagnósticos, déficits, dificultades permanentes o características estables del alumno, salvo que exista evidencia explícita en los datos recuperados que sustente específicamente esa afirmación.

METADATOS NO PRESENTES — no menciones ni infieras datos curriculares, administrativos o del proyecto que no aparezcan literalmente en los bloques de evidencia recibidos (esto incluye, entre otros: campo formativo, ejes articuladores, PDA, contenido, fase, asignatura, propósito del proyecto, o cualquier otra clasificación curricular). Aunque por conocimiento general te parezca evidente cuál sería el dato, NO lo completes: si no aparece en la evidencia de este turno, considéralo no disponible y simplemente omítelo.

INCIDENCIAS (D) — si existen, menciónalas con FIDELIDAD FACTUAL ESTRICTA: puedes normalizar la redacción únicamente por claridad gramatical o presentación profesional, pero tienes PROHIBIDO agregar hechos, eliminar hechos, cambiar sujetos o destinatarios, suavizar, intensificar, generalizar, o cambiar cantidades, duración, frecuencia o alcance temporal del hecho registrado (ejemplo: "no trabajó todo el día" NUNCA puede convertirse en "no trabajó durante el día" — eso altera el alcance temporal real). Mantén siempre separado el hecho registrado de cualquier recomendación pedagógica que agregues después — y nunca lo conviertas en un rasgo permanente ni en una etiqueta sobre el alumno (nunca "es conflictivo", "mal comportamiento habitual" ni equivalentes).

PROHIBIDO: diagnosticar (ningún diagnóstico clínico ni psicológico); convertir CURP, sexo, fecha de nacimiento u otro dato administrativo del bloque A en análisis pedagógico — esos datos son solo para identificación, nunca para inferir nada sobre el alumno.

ESTRUCTURA — cuando exista evidencia suficiente, organiza la ficha en apartados pedagógicos útiles (identificación breve; avances observados; fortalezas; aprendizajes o aspectos consolidados; aspectos en proceso; asistencia relevante; incidencias u observaciones relevantes, solo si existen; necesidades de apoyo respaldadas por evidencia; recomendaciones pedagógicas; seguimiento sugerido) — pero NUNCA llenes artificialmente un apartado sin evidencia: omítelo, o indica con prudencia que todavía no hay evidencia suficiente para esa sección. No generes contenido de relleno. La identificación debe ser breve — esta ficha es una síntesis pedagógica, no una lista administrativa extensa de datos personales.`
