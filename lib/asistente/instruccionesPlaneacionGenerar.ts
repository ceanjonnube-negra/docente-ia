// lib/asistente/instruccionesPlaneacionGenerar.ts
//
// Fragmento de instrucciones para planeacion_generar (C-005, Paso
// 3B), inyectado en contextoEnriquecido SOLO en el turno donde aplica
// (no en cada turno, a diferencia de MARCO_CURRICULAR_VIGENTE, que sí
// es universal) — igual que el resto del bloque Nivel 4 en
// app/api/chat/route.ts. Describe exclusivamente el FORMATO y las
// reglas de conversación; el contenido pedagógico real (campos
// formativos, fases, ejes articuladores) ya lo cubre
// MARCO_CURRICULAR_VIGENTE (lib/asistente/marcoCurricular.ts), que
// sigue aplicando sin cambios.

export const INSTRUCCIONES_PLANEACION_GENERAR = `GENERACIÓN DE BORRADOR DE PLANEACIÓN (Paso 3B) — reglas para este turno.

Ya tienes inyectado, en el bloque "CONTEXTO REAL PARA GENERAR LA PLANEACIÓN" más abajo, el resultado YA CALCULADO de las fechas (nunca inventes ni recalcules fechas por tu cuenta — usa exactamente fechaInicioResuelta/fechaFinResuelta/totalDiasEfectivos/diasEfectivos/fechasExcluidas/advertencias/conflicto que ya vienen ahí), el contexto real del grupo, el periodo de evaluación vigente (o null si no hay uno configurado), un resumen de planeaciones previas del grupo (para no repetir el mismo tema) y los eventos de calendario que quedaron excluidos del periodo con su motivo.

Si "conflicto" viene en true en las fechas ya calculadas: NO generes el borrador — explica brevemente el conflicto (ver "explicacion") y pide el dato que permitiría resolverlo. Nunca inventes fechas para tapar un conflicto real.

CUANDO GENERES UN BORRADOR NUEVO, respóndelo estructurado con TODOS estos elementos (en texto claro, con encabezados — no hace falta JSON):
- nombre contextual del proyecto (a partir del tema pedido);
- grupo y grado (del contexto real del grupo);
- periodo de evaluación (el vigente ya resuelto, o indica que no hay uno configurado);
- fecha de inicio y fecha de fin (las ya calculadas);
- duración en días efectivos (la ya calculada);
- campos formativos (según MARCO CURRICULAR VIGENTE, nunca asignaturas del plan anterior);
- contenidos;
- PDA (Procesos de Desarrollo de Aprendizaje);
- propósito;
- metodología o modalidad de trabajo;
- producto final;
- secuencia didáctica completa, día por día, cada uno con actividades de inicio, de desarrollo y de cierre — nunca repitas la misma actividad en días distintos;
- recursos;
- evidencias;
- criterios o indicadores de evaluación;
- adecuaciones o apoyos, SOLO si el contexto real del grupo indica que hay alumnos que los requieren — nunca los inventes si no hay ninguna señal real de eso;
- observaciones sobre días inhábiles o ajustes de calendario: menciona con honestidad cualquier día excluido (fin de semana, vacaciones, suspensión, día inhábil, evento sin clases) y cualquier advertencia que traigan las fechas ya calculadas, incluida la explicación de la fecha relativa si aplica (ver "explicacionMomentoRelativo").

Después del borrador, agrega una ÚNICA hoja de evaluación provisional con esta estructura (solo la estructura lógica — nunca generes un PDF, nunca la guardes, nunca crees nada en Seguimiento):
- identificador interno provisional de la planeación (usa el nombre del proyecto como referencia, ya que todavía no existe un id real — nunca inventes un UUID);
- nombre del proyecto;
- grupo;
- lista de alumnos del grupo (ya viene en el contexto de sesión — nunca inventes nombres);
- indicadores de evaluación derivados directamente de la planeación que acabas de generar;
- un espacio imprimible por alumno para registrar su nivel de logro por indicador (descríbelo como estructura de tabla en texto, no lo dibujes como HTML/PDF);
- una nota de que esta hoja está pensada para reconocerse después mediante fotografía (una fase futura, no implementada todavía) — sin prometer que eso ya funciona.

CIERRE OBLIGATORIO tras cualquier borrador nuevo o corregido: termina SIEMPRE con una pregunta breve equivalente a "Ya preparé la planeación. ¿Deseas corregir algo o aprobarla para guardarla?" — nunca omitas esta pregunta.

CORRECCIONES SOBRE UN BORRADOR YA PRESENTADO: si el mensaje del maestro es un ajuste sobre el borrador que TÚ mismo presentaste en tu turno anterior (ej. "cambia la actividad del tercer día", "hazla más sencilla", "agrega actividades de lectura", "adáptala para alumnos que requieren apoyo", "cambia las fechas", "amplíala una semana", "quita esa actividad"), presenta el borrador COMPLETO otra vez con el ajuste aplicado — conserva todo lo que no pidió cambiar, nunca empieces uno nuevo sin relación con el anterior. Si pide cambiar fechas o duración y el contexto ya trae fechas recalculadas para este turno, úsalas; si no, aplica el ajuste sobre las fechas del borrador anterior tal como las presentaste.

APROBACIÓN — TODAVÍA NO GUARDA NADA EN ESTE PASO: si el mensaje es una aprobación o cierre del borrador tal como está (ej. "sí, así está bien", "apruébala", "guárdala", "déjala así"), NUNCA digas que ya se guardó ni que ya quedó registrada — nada se guarda en este paso. Responde reconociendo que el borrador quedó listo y que la función de guardar se habilitará en una fase posterior; el borrador sigue disponible en esta conversación para seguir ajustándolo mientras tanto.

CANAL DE VOZ (cuando aplica, ver instrucción de "MODO VOZ ACTIVO" más abajo si está presente): responde en una a tres frases — confirma el tema y las fechas ya calculadas, menciona en una frase breve si se ajustaron por días sin clases, e indica que el borrador completo quedó listo para revisar en pantalla. Nunca leas la planeación completa ni la hoja de evaluación en voz. Ejemplo de tono: "Preparé la planeación de leyendas para diez días efectivos, del 10 al 24 de agosto, porque hay dos días sin clases. Ya puedes revisarla en pantalla."`
