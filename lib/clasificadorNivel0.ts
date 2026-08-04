// lib/clasificadorNivel0.ts
// Clasificador de Nivel 0: analiza el mensaje del docente y decide
// intención, nivel de ejecución, y si hace falta contexto o datos.
//
// NOTA DE ALCANCE (MVP): esta primera versión trae un subconjunto de
// los campos diseñados en el documento de arquitectura completo
// (persistencia, permisos, aislamiento, sub_acciones se agregan en
// una siguiente etapa). Aquí solo lo necesario para enrutar
// consultar_asistencia (Nivel 1) y ficha_descriptiva / planeacion_generar
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
    | 'planeacion_generar'
    | 'planeacion_consultar'
    | 'consultar_alumno_lista'
    | 'navegar_alumno_lista'
    | 'consultar_incidencias_alumno'
    | 'navegar_lista_filtrada'
    | 'actualizar_perfil_docente'
    | 'registrar_incidencia'
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
  // Solo para registrar_incidencia — categoría breve (2-4 palabras,
  // ej. "Conducta", "Falta de material") y el detalle de lo ocurrido,
  // tomados de las propias palabras del maestro, nunca inventados. null
  // en cualquier otra intención.
  tipo_incidencia: string | null;
  descripcion_incidencia: string | null;
  // Solo para planeacion_consultar (C-005, Paso 3A) — qué desea
  // consultar sobre sus planeaciones YA GUARDADAS. 'listado_general':
  // todas las del grupo activo, sin filtro. 'por_periodo': un
  // trimestre/periodo específico (periodo_planeacion_consulta).
  // 'por_estado': un estado específico (estado_planeacion_consulta).
  // 'actual': la vigente para hoy. 'ultima': la más reciente por
  // fecha de inicio. 'por_nombre': busca una en particular por nombre
  // o tema (nombre_planeacion_consulta). null en cualquier otra
  // intención.
  tipo_consulta_planeacion: 'listado_general' | 'por_periodo' | 'por_estado' | 'actual' | 'ultima' | 'por_nombre' | null;
  // Solo relevante con tipo_consulta_planeacion="por_periodo" — el
  // trimestre/periodo tal cual lo dijo el maestro (ej. "primer
  // trimestre", "trimestre 2"). La resolución exacta contra el
  // periodo_evaluacion_id real la hace el código, nunca este campo.
  periodo_planeacion_consulta: string | null;
  // Solo relevante con tipo_consulta_planeacion="por_estado".
  estado_planeacion_consulta: 'borrador' | 'publicada' | 'archivada' | null;
  // Solo relevante con tipo_consulta_planeacion="por_nombre" — el
  // nombre o tema buscado, tomado del mensaje actual, o (si el
  // mensaje es una referencia vaga de continuación, ej. "ábrela") del
  // nombre de planeación mencionado en el ÚLTIMO turno del asistente
  // en "ÚLTIMOS TURNOS DE LA CONVERSACIÓN". Nunca inventado si no
  // aparece en ninguno de los dos.
  nombre_planeacion_consulta: string | null;
  // Solo para planeacion_generar (C-005, Paso 3B) — datos de tiempo
  // mencionados EXPLÍCITAMENTE por el maestro para generar el
  // borrador. Nunca se inventa el que no se mencionó; la resolución
  // real (día efectivo siguiente, exclusión de fines de semana/días
  // inhábiles/vacaciones/suspensiones) la hace calcularFechasPlaneacion
  // (lib/planeacion/calculoFechasHabiles.ts), nunca este clasificador.
  tema_planeacion: string | null;
  fecha_inicio_planeacion: string | null; // YYYY-MM-DD, solo si dio fecha exacta
  fecha_fin_planeacion: string | null; // YYYY-MM-DD, solo si dio fecha exacta
  duracion_dias_planeacion: number | null; // días efectivos, solo si lo dijo así
  duracion_semanas_planeacion: number | null; // solo si dijo "semanas"
  // Referencia relativa no resoluble por el clasificador (ej. "después
  // de vacaciones", "la próxima semana") — se guarda tal cual el texto,
  // nunca se convierte aquí en una fecha.
  momento_relativo_planeacion: string | null;
  // Solo para planeacion_generar (C-005, Paso 3C) — cuál de los tres
  // sub-casos es este mensaje. 'aprobar' SOLO cuando el turno
  // inmediato anterior del asistente presentó un borrador completo y
  // cerró con la pregunta de aprobación, Y el mensaje actual responde
  // afirmativamente a ESA pregunta de forma inequívoca — nunca lo
  // pongas "por si acaso". El guardado real lo decide el código a
  // partir de este campo, nunca el modelo grande — un falso 'aprobar'
  // dispararía una escritura real no pedida.
  accion_planeacion_generar: 'crear' | 'ajustar' | 'aprobar' | null;
  datos_faltantes: string[];
  nivel_confianza: number;
  requiere_confirmacion: boolean;
  motivo_confirmacion: string | null;
  // Ver "Consultar información oficial vigente de la SEP" — regla 18.
  // true SOLO cuando el mensaje pregunta por algo oficial que puede
  // cambiar con el tiempo (calendario escolar, ciclo escolar, planes y
  // programas, lineamientos, trámites, acuerdos SEP/DOF) y cuya
  // respuesta NO está ya en DATOS DEL MAESTRO ni en la memoria general
  // del modelo con certeza. Cuando es true, route.ts agrega la
  // herramienta nativa de búsqueda oficial (restringida a dominios
  // .gob.mx) SOLO para este turno — nunca por default. false para
  // cualquier consulta de datos internos del grupo (asistencias,
  // alumnos, documentos ya guardados) o conversación casual.
  requiere_consulta_oficial: boolean;
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
  tipo_incidencia: null,
  descripcion_incidencia: null,
  tipo_consulta_planeacion: null,
  periodo_planeacion_consulta: null,
  estado_planeacion_consulta: null,
  nombre_planeacion_consulta: null,
  tema_planeacion: null,
  fecha_inicio_planeacion: null,
  fecha_fin_planeacion: null,
  duracion_dias_planeacion: null,
  duracion_semanas_planeacion: null,
  momento_relativo_planeacion: null,
  accion_planeacion_generar: null,
  datos_faltantes: [],
  nivel_confianza: 0,
  requiere_confirmacion: false,
  motivo_confirmacion: null,
  requiere_consulta_oficial: false,
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
  "intencion_principal": "consultar_asistencia" | "registrar_asistencia" | "marcar_asistencia_individual" | "consultar_asistencia_grupo" | "consultar_apoyo" | "consultar_documentos" | "consultar_calendario" | "ficha_descriptiva" | "planeacion_generar" | "planeacion_consultar" | "consultar_alumno_lista" | "navegar_alumno_lista" | "consultar_incidencias_alumno" | "navegar_lista_filtrada" | "actualizar_perfil_docente" | "registrar_incidencia" | "conversacion_general" | "intencion_no_reconocida",
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
  "tipo_incidencia": string | null,
  "descripcion_incidencia": string | null,
  "tipo_consulta_planeacion": "listado_general" | "por_periodo" | "por_estado" | "actual" | "ultima" | "por_nombre" | null,
  "periodo_planeacion_consulta": string | null,
  "estado_planeacion_consulta": "borrador" | "publicada" | "archivada" | null,
  "nombre_planeacion_consulta": string | null,
  "tema_planeacion": string | null,
  "fecha_inicio_planeacion": string | null,
  "fecha_fin_planeacion": string | null,
  "duracion_dias_planeacion": number | null,
  "duracion_semanas_planeacion": number | null,
  "momento_relativo_planeacion": string | null,
  "accion_planeacion_generar": "crear" | "ajustar" | "aprobar" | null,
  "datos_faltantes": string[],
  "nivel_confianza": number entre 0 y 1,
  "requiere_confirmacion": boolean,
  "motivo_confirmacion": string | null,
  "requiere_consulta_oficial": boolean
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
4. Si pide que el Chat IA CREE, GENERE o PREPARE una planeación NUEVA (redactar un proyecto didáctico completo — no es una pregunta sobre planeaciones YA GUARDADAS, ni una pregunta general sobre qué es planear) → intencion_principal="planeacion_generar", nivel_ejecucion=4, requiere_ia=true, requiere_contexto_memoria=true. entidades_resueltas.alumno_id queda null en este caso. Ejemplos: "hazme una planeación de leyendas para dos semanas", "genera una planeación para mi grupo", "prepara una planeación del 10 al 21 de agosto", "planea diez días efectivos sobre fracciones", "haz una planeación para después de vacaciones", "necesito una planeación para el siguiente proyecto". También aplica a instrucciones de AJUSTE, corrección o APROBACIÓN sobre un borrador de planeación que el propio asistente presentó en el ÚLTIMO turno (ver "ÚLTIMOS TURNOS DE LA CONVERSACIÓN") — ej. "cambia la actividad del tercer día", "hazla más sencilla", "agrega actividades de lectura", "adáptala para alumnos que requieren apoyo", "cambia las fechas", "amplíala una semana", "quita esa actividad", "déjala así", "sí, apruébala", "guárdala", "ya quedó", "guarda esta planeación": mientras el turno inmediato anterior del asistente haya presentado un borrador de planeación, TODAS estas se clasifican también como planeacion_generar. Resuelve accion_planeacion_generar así: "crear" si es una solicitud nueva desde cero (sin borrador previo en el turno anterior); "ajustar" si pide modificar el borrador que el asistente presentó; "aprobar" SOLO si el turno inmediato anterior del asistente presentó un borrador COMPLETO (con su bloque de resumen, no una pregunta de aclaración) y cerró con la pregunta de aprobación, Y el mensaje actual responde afirmativamente a ESA pregunta de forma clara ("sí", "apruébala", "guárdala", "déjala así", "ya quedó", "está bien", "ok", "perfecto" — estas últimas cuatro SOLO cuentan como aprobación si el turno anterior es inequívocamente esa pregunta de cierre, nunca en otro contexto). Ante cualquier duda entre "aprobar" y otra cosa, o si no hay un turno anterior claro de borrador completo, usa "ajustar" o "crear" según aplique — nunca "aprobar" por defecto, porque dispara un guardado real. IMPORTANTE — esta intención NUNCA compite con la 8 (consultar_calendario): si el mensaje pide crear una planeación Y ADEMÁS menciona el calendario escolar, los días inhábiles, las suspensiones o las vacaciones como algo a considerar (ej. "hazme una planeación... considerando el calendario escolar, los días inhábiles y las suspensiones"), sigue siendo planeacion_generar — NUNCA reclasifiques como consultar_calendario, porque planeacion_generar ya consulta el calendario real internamente para calcular las fechas; mencionar el calendario como algo a tomar en cuenta nunca cambia la intención principal cuando el mensaje pide crear/ajustar/aprobar una planeación.

Extrae, SOLO si el maestro los mencionó explícitamente en su mensaje ACTUAL (nunca inventes el que no dijo): tema_planeacion (el tema o proyecto, ej. "leyendas", "fracciones"), fecha_inicio_planeacion y fecha_fin_planeacion (formato YYYY-MM-DD, solo si dio fechas exactas), duracion_dias_planeacion (número de días efectivos, solo si lo dijo así), duracion_semanas_planeacion (número de semanas, solo si dijo "semanas"), momento_relativo_planeacion (la frase textual tal cual, solo para una referencia relativa que tú no puedas convertir en fecha, ej. "después de vacaciones", "la próxima semana", "las primeras semanas de clases", "el inicio de clases", "el regreso a clases" — nunca inventes aquí una fecha). Duración y momento_relativo NO son excluyentes: si el mensaje da una duración (ej. "dos semanas") Y ADEMÁS indica que debe iniciar al arranque del ciclo escolar (ej. "planeación diagnóstica para las primeras dos semanas de clases", "para el inicio de clases"), extrae AMBOS — duracion_semanas_planeacion (o duracion_dias_planeacion) Y momento_relativo_planeacion con la frase que indica el inicio — para que el sistema calcule el periodo desde el inicio real del ciclo escolar y no desde hoy. Deja en null cualquiera de estos campos que no se haya mencionado.
4.1. Para planeacion_generar: el dato realmente indispensable es una DURACIÓN o un RANGO completo — ni la fecha inicial sola (exacta o relativa) ni el tema alcanzan para calcular el periodo. Agrega "fecha_o_duracion" a datos_faltantes cuando NINGUNA de estas tres condiciones se cumple: (a) diste fecha_inicio_planeacion Y fecha_fin_planeacion juntas; (b) diste duracion_dias_planeacion; (c) diste duracion_semanas_planeacion — SIN IMPORTAR si mencionó una fecha inicial suelta o una referencia relativa (momento_relativo_planeacion), porque ninguna de esas dos por sí sola basta para calcular cuánto debe durar. Excepción: si el turno inmediato anterior del asistente ya presentó un borrador de planeación (el mensaje actual es un ajuste o una aprobación sobre ese borrador, no una solicitud nueva desde cero), NUNCA agregues esto — las fechas/duración del borrador anterior siguen vigentes hasta que el maestro pida cambiarlas explícitamente.
5. Si pregunta por asistencia a nivel de TODO el grupo, no de un alumno específico — "¿quién faltó hoy?", "¿quién tiene más faltas?", "¿cuál fue la última asistencia registrada?", "¿quién no ha llegado?", "¿cuántas faltas hay hoy?", "¿quiénes asistieron?", "¿cuántos presentes hay?", "¿quién llegó tarde?", "¿cuántos retardos hay?", "¿quiénes faltaron?", "¿quién está ausente?", "muéstrame las faltas de hoy", "muéstrame/revisa/consulta la asistencia (de hoy/la lista)", "¿cómo quedó la asistencia?" — cualquier forma de pedir el estado de asistencia del grupo, aunque no use ninguna de estas palabras exactas → intencion_principal="consultar_asistencia_grupo", nivel_ejecucion=4, requiere_ia=true, requiere_contexto_memoria=true, entidades_resueltas.alumno_id=null.
5.1. Para consultar_asistencia_grupo, la respuesta debe ajustarse EXACTAMENTE a lo que se preguntó — nunca asumas que quieren el reporte completo. Decide nivel_detalle_asistencia_grupo así:
   - "cantidad": preguntó por un NÚMERO de una sola categoría. Ejemplos: "¿cuántos faltaron?", "¿cuántas faltas hay?" → categoria_asistencia_grupo="faltas". "¿cuántos presentes hay?", "¿cuántos alumnos asistieron?" → categoria_asistencia_grupo="presentes". "¿cuántos retardos hay?", "¿cuántos llegaron tarde?" → categoria_asistencia_grupo="retardos". "¿cuántos alumnos son/hay en total?" → categoria_asistencia_grupo="total".
   - "nombres": preguntó QUIÉNES, sin pedir cifras de otras categorías. Ejemplos: "¿quiénes faltaron?" → categoria_asistencia_grupo="faltas". "¿quiénes asistieron?" → categoria_asistencia_grupo="presentes". "¿quiénes llegaron tarde?" → categoria_asistencia_grupo="retardos".
   - "resumen": preguntó de forma general por el estado de la asistencia SIN especificar una sola categoría ni pedir el reporte completo explícitamente. Ejemplos: "¿cómo quedó la asistencia?", "¿cómo va la asistencia hoy?". categoria_asistencia_grupo=null.
   - "completo": pidió EXPLÍCITAMENTE el reporte completo, o mencionó varias categorías juntas en la misma pregunta. Ejemplos: "dame el reporte completo de asistencia", "muéstrame la asistencia completa", "dame presentes, faltas y retardos". categoria_asistencia_grupo=null.
   Ante la duda entre "resumen" y "completo", usa "resumen" — es preferible responder corto y que el maestro pida más, que saturarlo con datos que no pidió.
6. Si pregunta qué alumnos requieren apoyo, tienen necesidades especiales, o van rezagados/con dificultades → intencion_principal="consultar_apoyo", nivel_ejecucion=4, requiere_ia=true, requiere_contexto_memoria=true.
7. Si pregunta qué documentos tiene generados/guardados/almacenados en la aplicación (planeaciones, fichas, exámenes, citatorios que ya generó antes) → intencion_principal="consultar_documentos", nivel_ejecucion=4, requiere_ia=true, requiere_contexto_memoria=true.
8. Si pregunta por actividades, eventos o fechas programadas en el calendario escolar, o por cualquier cosa relacionada con tiempo/fechas de la escuela — aunque no diga la palabra "calendario" ni lo pida explícitamente — → intencion_principal="consultar_calendario", nivel_ejecucion=4, requiere_ia=true, requiere_contexto_memoria=true. Ejemplos: "¿qué sigue esta semana?", "¿cuándo regresamos?", "¿qué tengo mañana?", "¿hay CTE este mes?", "¿qué actividades tengo el viernes?", "¿cuándo son las vacaciones?", "¿qué día es la junta?", "¿qué eventos hay este mes?", "¿cuántos eventos tengo esta semana?", "¿qué días están libres?", "¿qué actividades son oficiales?", "¿qué actividades agregué yo?", "¿cuándo es el próximo consejo técnico?", "¿ya empezaron las vacaciones?". Excepción — NUNCA uses esta regla si el mensaje en realidad pide CREAR, AJUSTAR o APROBAR una planeación (ver regla 4): cuando el calendario, los días inhábiles, las suspensiones o las vacaciones se mencionan solo como algo a considerar DENTRO de una solicitud de planeación (ej. "hazme una planeación... considerando el calendario escolar y las suspensiones"), la intención sigue siendo planeacion_generar; esta regla 8 aplica únicamente cuando la pregunta principal del mensaje es sobre el calendario en sí, no sobre crear un proyecto didáctico.
9. Para 1, 2.1, 3, 14, 14.1, 15 y 19: busca el nombre del alumno mencionado contra "alumnos_del_grupo_activo" — tolerante a mayúsculas, acentos, nombre parcial, Y a errores de transcripción de voz (el nombre puede llegar distorsionado fonéticamente, ej. "Outrid" por "Audrey", "Erik" por "Eric" — considera una coincidencia por semejanza FONÉTICA como candidato válido, no solo coincidencia de texto exacta).
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
17. Si el mensaje indica un cambio de grado y/o grupo escolar del DOCENTE (no de un alumno, no de la lista) → intencion_principal="actualizar_perfil_docente", nivel_ejecucion=1, requiere_ia=false, requiere_contexto_memoria=false. Ejemplos: "Ya somos cuarto.", "Ya somos 4° B.", "Corrige el grupo.", "Cambia el grado.", "Ahora es 4° B.", "Cambiamos a tercero.", "Ahora somos el grupo C.", "Pásame a 5° A.". Resuelve el grado mencionado contra el dominio exacto "1°"–"6°" (convierte palabras a número: primero→"1°", segundo→"2°", tercero→"3°", cuarto→"4°", quinto→"5°", sexto→"6°"; si ya viene como dígito o con el símbolo, solo normalízalo al formato "N°"). Resuelve el grupo mencionado contra el dominio exacto "A"–"E" (una sola letra, mayúscula). Si el mensaje solo menciona el grado, grupo_solicitado=null; si solo menciona el grupo, grado_solicitado=null — NUNCA inventes el campo que no se mencionó. Si no puedes resolver NI grado NI grupo dentro de esos dominios válidos, no uses esta intención — usa "conversacion_general" en su lugar. requiere_confirmacion=false (la confirmación la da la propia respuesta del sistema tras guardar, no una pregunta previa).
18. requiere_consulta_oficial=true SOLO cuando el mensaje pregunta por información OFICIAL de la SEP/autoridades educativas que puede cambiar con el tiempo y cuya fecha/vigencia exacta el modelo no puede saber con certeza por su cuenta: calendario escolar oficial (inicio/término de ciclo, periodos vacacionales oficiales, días de CTE oficiales a nivel SEP), planes y programas de estudio vigentes, campos formativos vigentes, lineamientos, normas, trámites oficiales, acuerdos publicados por SEP o DOF. Es un campo INDEPENDIENTE de intencion_principal (puede coexistir con "consultar_calendario" si la pregunta es sobre el calendario OFICIAL de la SEP, no el calendario personal que el docente registró en la app, o con "conversacion_general" si no encaja en ninguna otra intención). Ejemplos que SÍ son requiere_consulta_oficial=true: "¿cuándo termina el ciclo escolar 2025-2026?", "¿cuándo inicia el siguiente ciclo escolar?", "¿cuáles son los campos formativos vigentes?", "¿qué dice el plan de estudios sobre...?", "¿cuándo son las vacaciones de verano según la SEP?". IMPORTANTE: distingue esto de "consultar_calendario" (regla 8), que es sobre eventos que EL DOCENTE registró en su propio calendario dentro de la app ("¿qué tengo mañana?", "¿hay junta el viernes?") — si la pregunta es sobre SU agenda personal, requiere_consulta_oficial=false aunque intencion_principal sea "consultar_calendario". requiere_consulta_oficial=false SIEMPRE para: datos internos del grupo (asistencias, alumnos, incidencias, documentos ya guardados en la app), y para conversación casual. Nunca lo actives "por si acaso" — solo cuando la pregunta específicamente requiera una fecha o dato oficial vigente que no está en DATOS DEL MAESTRO.
19. Si pide REGISTRAR/REPORTAR/ANOTAR/DOCUMENTAR/LEVANTAR una incidencia, reporte o problema de conducta/comportamiento de UN alumno mencionado por nombre → intencion_principal="registrar_incidencia", nivel_ejecucion=1, requiere_ia=false, requiere_contexto_memoria=false. Ejemplos: "repórtale una incidencia a [nombre] por interrumpir la clase", "registra que [nombre] se peleó con un compañero", "anota una incidencia de conducta para [nombre]", "levanta un reporte a [nombre] porque no trajo material", "documenta que [nombre] fue grosero con un compañero", "pon una incidencia a [nombre]: no hizo la tarea". Extrae dos campos SOLO de lo que el maestro realmente dijo, sin inventar ni completar HECHOS que no dio: tipo_incidencia (una categoría breve, 2-4 palabras, la que mejor describa lo ocurrido — ej. "Conducta", "Falta de material", "Conflicto entre compañeros", "Incumplimiento de tarea") y descripcion_incidencia. descripcion_incidencia va a quedar guardada tal cual en el expediente oficial del alumno, así que NUNCA la copies literal en el lenguaje coloquial del maestro — redáctala en registro formal y administrativo, el mismo tono objetivo y en tercera persona que usarías para un reporte oficial SEP, PRESERVANDO EXACTAMENTE los mismos hechos que el maestro relató: nunca agregues, quites, minimices, exageres ni inventes ningún detalle — solo cambia el registro/tono de la redacción, nunca el contenido. Ejemplo: si el maestro dice "se portó mal, no trabajó y le jaló el pelo a Luis Ángel", descripcion_incidencia debe quedar como "La alumna mostró conducta inapropiada durante la jornada escolar y no participó en las actividades académicas programadas. Se registró un incidente de agresión física hacia un compañero, consistente en jalón de cabello, ocasionado a Luis Ángel." Si el maestro solo dice "repórtale una incidencia a [nombre]" sin decir qué pasó, agrega "descripcion_incidencia" a datos_faltantes — nunca inventes tipo ni descripción para rellenar. Esto es DISTINTO de 2.1 (asistencia: presente/falta/retardo) — llegar tarde por sí solo es un asunto de asistencia (retardo), no una incidencia de conducta, a menos que el maestro relacione explícitamente el retraso con un problema de comportamiento.
20. Si el docente pregunta por planeaciones YA GUARDADAS en la aplicación — listado general, filtradas por trimestre/periodo, por estado (borrador/publicada/archivada), la vigente/actual, la más reciente/última, o busca una en particular por nombre o tema — → intencion_principal="planeacion_consultar", nivel_ejecucion=4, requiere_ia=true, requiere_contexto_memoria=true. Ejemplos: "¿qué planeaciones tengo?", "muéstrame las planeaciones del primer trimestre", "¿cuál es mi planeación actual?", "abre la planeación de leyendas", "¿qué fechas tiene mi última planeación?", "¿cuáles están archivadas?". Resuelve tipo_consulta_planeacion así: "listado_general" si no especifica ningún filtro; "por_periodo" + periodo_planeacion_consulta (el trimestre/periodo tal cual lo dijo, ej. "primer trimestre") si menciona un periodo o trimestre; "por_estado" + estado_planeacion_consulta ("borrador"|"publicada"|"archivada") si menciona un estado; "actual" si pregunta por la vigente o la de este momento; "ultima" si pregunta por la más reciente o la última que creó; "por_nombre" + nombre_planeacion_consulta (el nombre o tema mencionado) si busca una planeación específica. Si el mensaje es una referencia vaga de continuación sin nombre propio (ej. "ábrela", "muéstrame esa", "ábreme esa planeación") Y el ÚLTIMO turno del ASISTENTE en "ÚLTIMOS TURNOS DE LA CONVERSACIÓN" menciona el nombre de UNA planeación específica, usa tipo_consulta_planeacion="por_nombre" con nombre_planeacion_consulta tomado de ese turno anterior — nunca inventado si no aparece ahí. DISTINGUE esto de "planeacion_generar" (regla 4 — pedir CREAR, GENERAR o AJUSTAR una planeación nueva) y de una pregunta general o pedagógica sobre qué es una planeación o cómo planear (esos casos NO son esta intención aunque mencionen la palabra "planeación") — en esos casos usa "conversacion_general".`;
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
