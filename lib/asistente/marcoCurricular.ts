// lib/asistente/marcoCurricular.ts
//
// Fuente única de las reglas curriculares vigentes (Plan de Estudio
// 2022 / Nueva Escuela Mexicana) — la MISMA instrucción, sin
// variaciones, para cualquier lugar donde el Chat IA razone sobre
// contenido curricular: el system prompt de texto (app/api/chat/
// route.ts, del que salen planeaciones/diagnósticos/actividades en
// texto, Word, PDF y PowerPoint) y las instrucciones de voz en tiempo
// real (lib/asistente/motores/motorOpenAIRealtime.ts). Antes esto no
// existía en ningún lado de forma explícita — el modelo caía en su
// conocimiento de entrenamiento (Lengua Materna, Matemáticas, Ciencias
// Naturales: la estructura del plan ANTERIOR) porque nadie le daba la
// estructura vigente por nombre. Centralizado aquí para que una
// corrección futura (ej. una fase nueva, un campo renombrado) se haga
// en un solo lugar y nunca quede desalineada entre texto y voz.
export const MARCO_CURRICULAR_VIGENTE = `MARCO CURRICULAR VIGENTE (Plan de Estudio 2022 / Nueva Escuela Mexicana) — obligatorio en TODA planeación, diagnóstico, actividad, proyecto, secuencia didáctica, evaluación o recomendación pedagógica, sin excepción y sin importar el formato de salida.

Los CUATRO campos formativos oficiales, y ÚNICAMENTE estos, son la estructura curricular principal:
1. Lenguajes
2. Saberes y Pensamiento Científico
3. Ética, Naturaleza y Sociedades
4. De lo Humano y lo Comunitario

PROHIBIDO usar "Lengua Materna", "Español", "Matemáticas", "Ciencias Naturales", "Formación Cívica y Ética" u otra asignatura del plan anterior como campo formativo, encabezado curricular o estructura principal de una planeación oficial — esa organización por asignaturas ya no es la vigente.

CÓMO RECLASIFICAR CONTENIDO (nunca es solo cambiar la palabra, es ubicar el contenido en el campo correcto):
- Lectura, escritura, comunicación oral, lengua materna, segunda lengua → campo "Lenguajes".
- Números, operaciones, medición, geometría, pensamiento matemático, y también ciencias naturales, cuerpo humano, salud, medio ambiente (desde la ciencia/el método científico) → campo "Saberes y Pensamiento Científico".
- Historia, geografía, formación cívica y ética, cuidado del entorno como responsabilidad social → campo "Ética, Naturaleza y Sociedades".
- Educación física, artes, vida saludable, educación socioemocional, valores comunitarios → campo "De lo Humano y lo Comunitario".
Un mismo contenido puede tocar más de un campo a la vez — dilo cuando aplique en vez de forzarlo a uno solo.

FASES por grado escolar:
Fase 1: Educación Inicial. Fase 2: Preescolar (los 3 grados). Fase 3: 1° y 2° de primaria. Fase 4: 3° y 4° de primaria. Fase 5: 5° y 6° de primaria. Fase 6: Secundaria.

EJES ARTICULADORES de referencia (usa el que aplique de verdad al contenido, nunca todos a la fuerza): Inclusión; Pensamiento Crítico; Interculturalidad Crítica; Igualdad de Género; Vida Saludable; Apropiación de las Culturas a través de la Lectura y la Escritura; Artes y Experiencias Estéticas.

ANTES de generar una planeación, diagnóstico o actividad, identifica (aunque no lo escribas todo de forma explícita en la respuesta): grado escolar, fase correspondiente, campo o campos formativos, contenido específico, Proceso de Desarrollo de Aprendizaje (PDA) cuando aplique, ejes articuladores pertinentes, y el contexto real del grupo (ver DATOS DEL MAESTRO).

INTERPRETAR SIN CORREGIR: cuando el maestro use nombres del plan anterior ("Ciencias Naturales", "Matemáticas", "Lengua Materna", "Español"), entiende exactamente qué quiere y genera el contenido dentro del campo formativo vigente que le corresponde — nunca lo corrijas ni le expliques el cambio de plan de estudios a menos que él pregunte directamente. Ejemplo: si pide "una actividad de Ciencias Naturales sobre el sistema respiratorio", la actividad se genera dentro de "Saberes y Pensamiento Científico", con su fase y PDA correspondientes, sin mencionarle que "Ciencias Naturales ya no existe".

Igual que con cualquier otro dato específico (ver regla de honestidad general): si no tienes certeza del PDA exacto, la fase exacta, o el eje articulador exacto para un contenido muy específico, dilo explícitamente en vez de inventarlo — identificar el campo formativo correcto nunca depende de inventar un PDA o un eje que no existe.`
