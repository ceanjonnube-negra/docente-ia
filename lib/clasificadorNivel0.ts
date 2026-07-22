// lib/clasificadorNivel0.ts
// Clasificador de Nivel 0: analiza el mensaje del docente y decide
// intención, nivel de ejecución, y si hace falta contexto o datos.
//
// NOTA DE ALCANCE (MVP): esta primera versión trae un subconjunto de
// los campos diseñados en el documento de arquitectura completo
// (persistencia, permisos, aislamiento, sub_acciones se agregan en
// una siguiente etapa). Aquí solo lo necesario para enrutar
// consultar_asistencia (Nivel 1) y ficha_descriptiva / planeacion_nueva
// (Nivel 4) desde el Chat IA. Si el modelo no puede clasificar con
// confianza, se hace fallback seguro a conversación general (el
// comportamiento actual de la app, sin cambios).

import Anthropic from '@anthropic-ai/sdk';
import type { SesionContexto } from './sesionContexto';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ClasificacionNivel0 = {
  intencion_principal:
    | 'consultar_asistencia'
    | 'registrar_asistencia'
    | 'marcar_asistencia_individual'
    | 'consultar_asistencia_grupo'
    | 'consultar_apoyo'
    | 'consultar_documentos'
    | 'consultar_calendario'
    | 'ficha_descriptiva'
    | 'planeacion_nueva'
    | 'consultar_alumno_lista'
    | 'navegar_alumno_lista'
    | 'consultar_incidencias_alumno'
    | 'navegar_lista_filtrada'
    | 'actualizar_perfil_docente'
    | 'conversacion_general'
    | 'intencion_no_reconocida';
  nivel_ejecucion: 1 | 2 | 3 | 4;
  requiere_ia: boolean;
  requiere_contexto_memoria: boolean;
  entidades_resueltas: {
    alumno_id: string | null;
    alumno_nombre_detectado: string | null;
    alumno_ambiguo: boolean;
    opciones_alumno_ambiguo: string[];
  };
  // Solo para marcar_asistencia_individual — qué estado pidió el
  // maestro para ESE alumno ("no vino"→falta, "llegó tarde"→retardo,
  // "sí asistió"→presente). null en cualquier otra intención.
  estado_asistencia_solicitado: 'presente' | 'falta' | 'retardo' | null;
  // Solo para consultar_alumno_lista / navegar_alumno_lista — a qué
  // pestaña de la ficha del alumno se refiere el maestro (ver Pestana
  // en app/dashboard/lista/[alumnoId]/page.tsx), o null si solo pidió
  // ver/abrir al alumno en general (pestaña "resumen" por default).
  pestana_lista: 'resumen' | 'datos' | 'asistencia' | 'incidencias' | 'evaluaciones' | 'evidencias' | 'fichas' | 'historial' | null;
  // Solo para navegar_lista_filtrada — qué subconjunto de la Lista
  // pidió ver el maestro (ver el mismo estado `filtro` que ya existe
  // en app/dashboard/lista/page.tsx). null en cualquier otra intención.
  filtro_lista: 'todos' | 'ninas' | 'ninos' | 'presentes' | 'ausentes' | null;
  // Solo para consultar_asistencia_grupo (ver "Corregir respuestas
  // excesivas del modo voz" — regla 5.1) — qué tan detallada debe ser
  // la respuesta. 'cantidad': solo el número de UNA categoría
  // (categoria_asistencia_grupo). 'nombres': solo la lista de nombres
  // de esa misma categoría. 'resumen': totales de las 4 categorías,
  // sin nombres. 'completo': el reporte de siempre (totales, %,
  // nombres de ausentes y retardos). null en cualquier otra intención.
  nivel_detalle_asistencia_grupo: 'cantidad' | 'nombres' | 'resumen' | 'completo' | null;
  // Solo relevante cuando nivel_detalle_asistencia_grupo es 'cantidad'
  // o 'nombres' — a qué categoría se refiere ("¿cuántos retardos?" →
  // "retardos"). null en 'resumen'/'completo' (cubren las 4 a la vez)
  // o en cualquier otra intención.
  categoria_asistencia_grupo: 'faltas' | 'presentes' | 'retardos' | 'total' | null;
  // Solo para actualizar_perfil_docente — el grado/grupo NUEVO que
  // pidió el maestro, ya resuelto contra el dominio válido real (ver
  // app/onboarding/page.tsx: mismos 6 grados y 5 letras que usa el
  // resto de la aplicación). null en el campo que NO se mencionó —
  // nunca se inventa el que falta.
  grado_solicitado: '1°' | '2°' | '3°' | '4°' | '5°' | '6°' | null;
  grupo_solicitado: 'A' | 'B' | 'C' | 'D' | 'E' | null;
  datos_faltantes: string[];
  nivel_confianza: number;
  requiere_confirmacion: boolean;
  motivo_confirmacion: string | null;
};

const FALLBACK: ClasificacionNivel0 = {
  intencion_principal: 'conversacion_general',
  nivel_ejecucion: 3,
  requiere_ia: true,
  requiere_contexto_memoria: false,
  entidades_resueltas: {
    alumno_id: null,
    alumno_nombre_detectado: null,
    alumno_ambiguo: false,
    opciones_alumno_ambiguo: [],
  },
  estado_asistencia_solicitado: null,
  pestana_lista: null,
  filtro_lista: null,
  nivel_detalle_asistencia_grupo: null,
  categoria_asistencia_grupo: null,
  grado_solicitado: null,
  grupo_solicitado: null,
  datos_faltantes: [],
  nivel_confianza: 0,
  requiere_confirmacion: false,
  motivo_confirmacion: null,
};

// Últimos turnos reales de la conversación — solo se usan para resolver
// una confirmación de seguimiento breve ("sí", "correcto") cuando el
// turno anterior del asistente preguntó "¿Te refieres a...?" antes de
// marcar la asistencia de un alumno (ver regla 13). Sin esto, el
// Clasificador de Nivel 0 es estrictamente sin memoria — no hace falta
// mandarle la conversación completa, solo lo último.
type TurnoReciente = { role: 'user' | 'assistant'; content: string };

function construirPrompt(sesion: SesionContexto, historialReciente: TurnoReciente[]): string {
  return `Eres el Clasificador de Nivel 0 de Docente IA. Analiza el mensaje del
docente y responde EXCLUSIVAMENTE con un objeto JSON, sin texto antes,
después, sin explicaciones, sin marcadores de código.

Formato exacto de salida:
{
  "intencion_principal": "consultar_asistencia" | "registrar_asistencia" | "marcar_asistencia_individual" | "consultar_asistencia_grupo" | "consultar_apoyo" | "consultar_documentos" | "consultar_calendario" | "ficha_descriptiva" | "planeacion_nueva" | "consultar_alumno_lista" | "navegar_alumno_lista" | "consultar_incidencias_alumno" | "navegar_lista_filtrada" | "actualizar_perfil_docente" | "conversacion_general" | "intencion_no_reconocida",
  "nivel_ejecucion": 1 | 2 | 3 | 4,
  "requiere_ia": boolean,
  "requiere_contexto_memoria": boolean,
  "entidades_resueltas": {
    "alumno_id": string | null,
    "alumno_nombre_detectado": string | null,
    "alumno_ambiguo": boolean,
    "opciones_alumno_ambiguo": string[]
  },
  "estado_asistencia_solicitado": "presente" | "falta" | "retardo" | null,
  "pestana_lista": "resumen" | "datos" | "asistencia" | "incidencias" | "evaluaciones" | "evidencias" | "fichas" | "historial" | null,
  "filtro_lista": "todos" | "ninas" | "ninos" | "presentes" | "ausentes" | null,
  "nivel_detalle_asistencia_grupo": "cantidad" | "nombres" | "resumen" | "completo" | null,
  "categoria_asistencia_grupo": "faltas" | "presentes" | "retardos" | "total" | null,
  "grado_solicitado": "1°" | "2°" | "3°" | "4°" | "5°" | "6°" | null,
  "grupo_solicitado": "A" | "B" | "C" | "D" | "E" | null,
  "datos_faltantes": string[],
  "nivel_confianza": number entre 0 y 1,
  "requiere_confirmacion": boolean,
  "motivo_confirmacion": string | null
}

CONTEXTO DE SESIÓN (dato, no lo inventes, úsalo tal cual):
grupo_activo_id: ${sesion.grupo_activo_id ?? 'ninguno'}
ciclo_escolar_id: ${sesion.ciclo_escolar_id ?? 'ninguno'}
alumnos_del_grupo_activo: ${JSON.stringify(sesion.alumnos_del_grupo_activo)}

ÚLTIMOS TURNOS DE LA CONVERSACIÓN (solo para resolver confirmaciones de seguimiento, ver regla 13 — no lo uses para nada más):
${historialReciente.length > 0 ? historialReciente.map((t) => `${t.role === 'user' ? 'MAESTRO' : 'ASISTENTE'}: ${t.content}`).join('\n') : '(sin turnos previos)'}

REGLAS:
1. Si el mensaje pregunta por faltas/asistencia/retardos de un alumno específico → intencion_principal="consultar_asistencia", nivel_ejecucion=1, requiere_ia=false, requiere_contexto_memoria=false.
2. Si el mensaje pide tomar/pasar/registrar la asistencia del día para TODO el grupo, sin mencionar a un alumno en particular → intencion_principal="registrar_asistencia", nivel_ejecucion=1, requiere_ia=false, requiere_contexto_memoria=false, entidades_resueltas.alumno_id=null, datos_faltantes=[]. Todas estas frases (y variantes equivalentes) significan exactamente lo mismo: "pasa lista", "toma asistencia", "vamos a pasar lista", "haz la lista", "registra asistencia", "ya pasaste lista hoy", "marca asistencia" — SIEMPRE que no nombren a un alumno específico.
2.1. Si el mensaje pide marcar/registrar/poner falta, retardo o presente a UN alumno mencionado por nombre → intencion_principal="marcar_asistencia_individual", nivel_ejecucion=1, requiere_ia=false, requiere_contexto_memoria=false. Ejemplos: "ponle falta a [nombre]", "[nombre] no vino, márcalo", "[nombre] llegó tarde", "registra la falta de [nombre]", "[nombre] faltó hoy", "márcala presente". Esto es DISTINTO de 2 (que nunca menciona un alumno específico) y de 1 (que es una PREGUNTA, no una instrucción de cambiar algo). estado_asistencia_solicitado: "falta" si no vino/faltó/no asistió/está ausente; "retardo" si llegó tarde/con retardo; "presente" si sí vino/asistió/está presente. Si no puedes determinar el estado con claridad, agrega "estado_asistencia" a datos_faltantes.
3. Si pide una ficha descriptiva de un alumno → intencion_principal="ficha_descriptiva", nivel_ejecucion=4, requiere_ia=true, requiere_contexto_memoria=true.
4. Si pide una planeación → intencion_principal="planeacion_nueva", nivel_ejecucion=4, requiere_ia=true, requiere_contexto_memoria=true. entidades_resueltas.alumno_id queda null en este caso.
5. Si pregunta por asistencia a nivel de TODO el grupo, no de un alumno específico — "¿quién faltó hoy?", "¿quién tiene más faltas?", "¿cuál fue la última asistencia registrada?", "¿quién no ha llegado?", "¿cuántas faltas hay hoy?", "¿quiénes asistieron?", "¿cuántos presentes hay?", "¿quién llegó tarde?", "¿cuántos retardos hay?", "¿quiénes faltaron?", "¿quién está ausente?", "muéstrame las faltas de hoy", "muéstrame/revisa/consulta la asistencia (de hoy/la lista)", "¿cómo quedó la asistencia?" — cualquier forma de pedir el estado de asistencia del grupo, aunque no use ninguna de estas palabras exactas → intencion_principal="consultar_asistencia_grupo", nivel_ejecucion=4, requiere_ia=true, requiere_contexto_memoria=true, entidades_resueltas.alumno_id=null.
5.1. Para consultar_asistencia_grupo, la respuesta debe ajustarse EXACTAMENTE a lo que se preguntó — nunca asumas que quieren el reporte completo. Decide nivel_detalle_asistencia_grupo así:
   - "cantidad": preguntó por un NÚMERO de una sola categoría. Ejemplos: "¿cuántos faltaron?", "¿cuántas faltas hay?" → categoria_asistencia_grupo="faltas". "¿cuántos presentes hay?", "¿cuántos alumnos asistieron?" → categoria_asistencia_grupo="presentes". "¿cuántos retardos hay?", "¿cuántos llegaron tarde?" → categoria_asistencia_grupo="retardos". "¿cuántos alumnos son/hay en total?" → categoria_asistencia_grupo="total".
   - "nombres": preguntó QUIÉNES, sin pedir cifras de otras categorías. Ejemplos: "¿quiénes faltaron?" → categoria_asistencia_grupo="faltas". "¿quiénes asistieron?" → categoria_asistencia_grupo="presentes". "¿quiénes llegaron tarde?" → categoria_asistencia_grupo="retardos".
   - "resumen": preguntó de forma general por el estado de la asistencia SIN especificar una sola categoría ni pedir el reporte completo explícitamente. Ejemplos: "¿cómo quedó la asistencia?", "¿cómo va la asistencia hoy?". categoria_asistencia_grupo=null.
   - "completo": pidió EXPLÍCITAMENTE el reporte completo, o mencionó varias categorías juntas en la misma pregunta. Ejemplos: "dame el reporte completo de asistencia", "muéstrame la asistencia completa", "dame presentes, faltas y retardos". categoria_asistencia_grupo=null.
   Ante la duda entre "resumen" y "completo", usa "resumen" — es preferible responder corto y que el maestro pida más, que saturarlo con datos que no pidió.
6. Si pregunta qué alumnos requieren apoyo, tienen necesidades especiales, o van rezagados/con dificultades → intencion_principal="consultar_apoyo", nivel_ejecucion=4, requiere_ia=true, requiere_contexto_memoria=true.
7. Si pregunta qué documentos tiene generados/guardados/almacenados en la aplicación (planeaciones, fichas, exámenes, citatorios que ya generó antes) → intencion_principal="consultar_documentos", nivel_ejecucion=4, requiere_ia=true, requiere_contexto_memoria=true.
8. Si pregunta por actividades, eventos o fechas programadas en el calendario escolar, o por cualquier cosa relacionada con tiempo/fechas de la escuela — aunque no diga la palabra "calendario" ni lo pida explícitamente — → intencion_principal="consultar_calendario", nivel_ejecucion=4, requiere_ia=true, requiere_contexto_memoria=true. Ejemplos: "¿qué sigue esta semana?", "¿cuándo regresamos?", "¿qué tengo mañana?", "¿hay CTE este mes?", "¿qué actividades tengo el viernes?", "¿cuándo son las vacaciones?", "¿qué día es la junta?", "¿qué eventos hay este mes?", "¿cuántos eventos tengo esta semana?", "¿qué días están libres?", "¿qué actividades son oficiales?", "¿qué actividades agregué yo?", "¿cuándo es el próximo consejo técnico?", "¿ya empezaron las vacaciones?".
9. Para 1, 2.1, 3, 14, 14.1 y 15: busca el nombre del alumno mencionado contra "alumnos_del_grupo_activo" — tolerante a mayúsculas, acentos, nombre parcial, Y a errores de transcripción de voz (el nombre puede llegar distorsionado fonéticamente, ej. "Outrid" por "Audrey", "Erik" por "Eric" — considera una coincidencia por semejanza FONÉTICA como candidato válido, no solo coincidencia de texto exacta).
   - Si hay exactamente una coincidencia EXACTA o casi exacta (mismo nombre, tolerando acentos/mayúsculas/nombre parcial claro): entidades_resueltas.alumno_id = su alumno_id, entidades_resueltas.alumno_nombre_detectado = su nombre_completo REAL tal como aparece en alumnos_del_grupo_activo (nunca el texto que dijo el maestro), alumno_ambiguo=false, datos_faltantes=[].
   - Si hay exactamente una coincidencia pero SOLO por semejanza FONÉTICA (el texto que escribió/dijo el maestro no se parece por escrito al nombre real, típico de dictado por voz mal transcrito): mismo llenado de alumno_id/alumno_nombre_detectado que arriba, PERO además, SOLO para marcar_asistencia_individual (2.1), pon requiere_confirmacion=true y motivo_confirmacion="nombre_fonetico" — la aplicación le va a preguntar al maestro antes de escribir nada. Para 1, 3, 14, 14.1 y 15 (son consultas o navegación, no escrituras) no hace falta esta confirmación extra.
   - Si no se menciona ningún alumno o no hay coincidencia razonable: alumno_id=null, agrega "alumno" a datos_faltantes, nivel_confianza baja (<0.5).
   - Si hay más de una coincidencia razonable: alumno_ambiguo=true, opciones_alumno_ambiguo con los nombres, agrega "alumno" a datos_faltantes.
10. Si no puedes identificar ninguna de las intenciones anteriores con confianza razonable, usa intencion_principal="conversacion_general", nivel_ejecucion=3, requiere_ia=true, requiere_contexto_memoria=false, datos_faltantes=[], requiere_confirmacion=false.
11. requiere_confirmacion=true solo si alumno_ambiguo=true, si "alumno" o "estado_asistencia" está en datos_faltantes para una intención que lo necesita, o si aplica el caso fonético de la regla 9.
12. Nunca inventes un alumno_id que no exista literalmente en alumnos_del_grupo_activo.
13. CONFIRMACIÓN DE SEGUIMIENTO: si el mensaje actual es una respuesta afirmativa breve ("sí", "sí es correcto", "así es", "correcto", "exacto", "confirmado", "sí, regístralo") Y el ÚLTIMO turno del ASISTENTE en "ÚLTIMOS TURNOS DE LA CONVERSACIÓN" es una pregunta del tipo "¿Te refieres a [nombre]?" sobre asistencia, entonces: intencion_principal="marcar_asistencia_individual", resuelve entidades_resueltas contra ese mismo [nombre] (búscalo en alumnos_del_grupo_activo), toma estado_asistencia_solicitado del turno del MAESTRO anterior a esa pregunta, y esta vez requiere_confirmacion=false (ya se confirmó explícitamente).
14. Si pide VER/CONSULTAR a un alumno específico en la Lista (sin pedir asistencia/ficha/apoyo con su propio formato de documento, ver 1/3/6) → intencion_principal="consultar_alumno_lista", nivel_ejecucion=1, requiere_ia=false, requiere_contexto_memoria=false. Frases que indican CONSULTA (no cambiar de pantalla todavía, solo mostrar y ofrecer abrir): "muéstrame a [nombre]", "muéstrame a [nombre] en la lista", "enséñame a [nombre]", "enséñame las faltas/incidencias/evaluaciones de [nombre]", "busca a [nombre]", "dime de [nombre]", "cómo va [nombre]". Si la frase nombra claramente una de estas áreas, resuelve pestana_lista: faltas/asistencias→"asistencia", ficha/ficha descriptiva→"fichas", incidencias→"incidencias", evaluaciones/calificaciones→"evaluaciones"; si no nombra ninguna, pestana_lista=null (pestaña "resumen" por default).
14.1. Si pide ABRIR/NAVEGAR directamente a un alumno específico en la Lista → intencion_principal="navegar_alumno_lista", nivel_ejecucion=1, requiere_ia=false, requiere_contexto_memoria=false. Frases que indican NAVEGACIÓN EXPLÍCITA (sí cambiar de pantalla): "abre a [nombre]", "abre a [nombre] en la lista", "llévame a [nombre]", "ve a [nombre]", "entra a [nombre]", "ábreme la ficha de [nombre]". Mismo cálculo de pestana_lista que en 14. La diferencia entre 14 y 14.1 es EXCLUSIVAMENTE el verbo usado (mostrar/consultar vs. abrir/navegar) — nunca lo decidas por otra señal.
15. Si pregunta CUÁNTAS/CUÁNTOS incidencias/reportes/actas tiene un alumno específico, o pide un número/resumen de sus incidencias (no pide VER la pestaña, pide la CIFRA) → intencion_principal="consultar_incidencias_alumno", nivel_ejecucion=1, requiere_ia=false, requiere_contexto_memoria=false. Ejemplos: "¿cuántas incidencias tiene [nombre]?", "¿[nombre] tiene reportes?", "¿cuántos reportes lleva [nombre]?". Distinto de 14 (que es "muéstrame/enséñame las incidencias de [nombre]", pide VER la pestaña, no una cifra) — igual que la distinción entre 1 (cifra de faltas) y 14 con pestana_lista="asistencia" (ver la pestaña).
16. Si pide ver la Lista mostrando SOLO un subconjunto, sin nombrar a un alumno específico → intencion_principal="navegar_lista_filtrada", nivel_ejecucion=1, requiere_ia=false, requiere_contexto_memoria=false, entidades_resueltas.alumno_id=null. Ejemplos: "muéstrame únicamente los ausentes", "muéstrame solo los presentes", "ver solo las niñas", "enséñame nada más los niños", "filtra la lista por ausentes". filtro_lista: "ausentes" si pide solo ausentes/faltantes/quién faltó, "presentes" si pide solo presentes/quién sí vino, "ninas" si pide solo niñas/mujeres/alumnas, "ninos" si pide solo niños/hombres/alumnos, "todos" si pide ver la lista completa sin filtro específico pero de todas formas con un verbo de navegación (abre/muéstrame/ve a la lista, sin más). Nunca actives esta regla si el mensaje ya nombra a un alumno específico (eso es 14/14.1).
17. Si el mensaje indica un cambio de grado y/o grupo escolar del DOCENTE (no de un alumno, no de la lista) → intencion_principal="actualizar_perfil_docente", nivel_ejecucion=1, requiere_ia=false, requiere_contexto_memoria=false. Ejemplos: "Ya somos cuarto.", "Ya somos 4° B.", "Corrige el grupo.", "Cambia el grado.", "Ahora es 4° B.", "Cambiamos a tercero.", "Ahora somos el grupo C.", "Pásame a 5° A.". Resuelve el grado mencionado contra el dominio exacto "1°"–"6°" (convierte palabras a número: primero→"1°", segundo→"2°", tercero→"3°", cuarto→"4°", quinto→"5°", sexto→"6°"; si ya viene como dígito o con el símbolo, solo normalízalo al formato "N°"). Resuelve el grupo mencionado contra el dominio exacto "A"–"E" (una sola letra, mayúscula). Si el mensaje solo menciona el grado, grupo_solicitado=null; si solo menciona el grupo, grado_solicitado=null — NUNCA inventes el campo que no se mencionó. Si no puedes resolver NI grado NI grupo dentro de esos dominios válidos, no uses esta intención — usa "conversacion_general" en su lugar. requiere_confirmacion=false (la confirmación la da la propia respuesta del sistema tras guardar, no una pregunta previa).`;
}

// CAUSA RAÍZ de "el chat se queda esperando indefinidamente" tras
// generar un documento: esta era la ÚNICA llamada a Claude en todo el
// proyecto sin límite de tiempo explícito (compárese con las otras dos
// en app/api/chat/route.ts, que sí usan { timeout: TIMEOUT_ANTHROPIC_MS
// }). El Clasificador de Nivel 0 se llama en CADA mensaje con sesión
// real (ver app/api/chat/route.ts — ya no hay ningún filtro de
// palabras clave delante), así que este límite protege absolutamente
// todo el flujo, no solo un caso particular. Si esta llamada se quedaba
// esperando, la ruta completa de /api/chat nunca terminaba — el
// try/catch de quien la llama ya existía, pero nunca se disparaba
// porque nada la delataba como colgada.
const TIMEOUT_NIVEL0_MS = 12_000;

export async function clasificarNivel0(
  mensaje: string,
  sesion: SesionContexto,
  historialReciente: TurnoReciente[] = []
): Promise<ClasificacionNivel0> {
  try {
    const respuesta = await client.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: construirPrompt(sesion, historialReciente),
        messages: [{ role: 'user', content: mensaje }],
      },
      { timeout: TIMEOUT_NIVEL0_MS }
    );

    const bloque = respuesta.content.find((b) => b.type === 'text');
    if (!bloque || bloque.type !== 'text') return FALLBACK;

    const limpio = bloque.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(limpio) as ClasificacionNivel0;

    // Validación mínima de forma, para no confiar ciegamente en el JSON del modelo
    if (
      !parsed.intencion_principal ||
      typeof parsed.nivel_ejecucion !== 'number' ||
      !parsed.entidades_resueltas
    ) {
      return FALLBACK;
    }

    return parsed;
  } catch (e) {
    console.error('Error en Clasificador de Nivel 0, usando fallback:', e);
    return FALLBACK;
  }
}
