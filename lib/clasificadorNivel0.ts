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
import type { CampoAlumnoCorregible } from './asistente/tipos';
import type { ReferenteContextualMetadata, TipoReferenteContextual } from './asistente/contextoConversacional';

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
    | 'consultar_dato_alumno'
    | 'corregir_dato_alumno'
    | 'revisar_datos_alumnos'
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
  // Solo para consultar_dato_alumno — ver "Consulta directa y segura
  // de datos individuales de alumnos". Cuál de los tres campos YA
  // REGISTRADOS pidió el maestro sobre un alumno específico (CURP,
  // sexo, fecha de nacimiento) — deliberadamente acotado a los
  // campos que datos_personales (contexto_alumno, ver
  // lib/asistente/herramientasModulo.ts) realmente expone hoy; no
  // incluye calificación/asistencia porque esas ya tienen su propia
  // intención dedicada (1, y ninguna equivalente existe todavía para
  // calificaciones) y no vienen en ese mismo contexto. null en
  // cualquier otra intención, o si no se pudo determinar cuál campo.
  campo_alumno_solicitado: CampoAlumnoCorregible | null;
  // Solo para corregir_dato_alumno — ver "PASO 2: corrección
  // individual segura de UN campo de UN alumno". 'proponer': el
  // mensaje ACTUAL da un alumno+campo+valor nuevo explícitos (primera
  // vez que se plantea esta corrección). 'confirmar'/'cancelar': el
  // mensaje actual es una respuesta breve a una propuesta que el
  // propio asistente presentó en el turno inmediato anterior (ver
  // regla 22.1) — en ese caso, campo_alumno_corregir y
  // valor_alumno_propuesto se resuelven del turno anterior, NUNCA del
  // mensaje actual. null en cualquier otra intención.
  accion_correccion_alumno: 'proponer' | 'confirmar' | 'cancelar' | null;
  // Ver "cerrar el hueco: comparar nunca debe poder ofrecer el botón
  // Corregir" — distingue la INTENCIÓN real del docente cuando
  // accion_correccion_alumno="proponer" (nunca aplica a "confirmar"/
  // "cancelar", que ya son inequívocamente parte del flujo de
  // corrección). 'corregir': el docente pidió explícitamente corregir/
  // cambiar/actualizar el dato (regla 22) — SÍ puede llegar a generar
  // una propuesta confirmable con botón Corregir. 'comparar': el
  // docente solo quiere comparar/revisar/verificar un valor contra el
  // registrado (regla 22.2) — JAMÁS debe generar una propuesta
  // confirmable ni el botón Corregir, sin importar si el valor es
  // válido/inválido o igual/distinto al registrado; herramientasModulo.ts
  // usa este campo como la única señal para decidirlo. null en
  // cualquier otra intención, incluidas accion_correccion_alumno=
  // "confirmar"/"cancelar".
  modo_operacion_alumno: 'corregir' | 'comparar' | null;
  campo_alumno_corregir: CampoAlumnoCorregible | null;
  // El valor EXACTO que el docente propuso — nunca completado,
  // corregido ni inferido por el clasificador (ver regla 22). Para
  // 'confirmar'/'cancelar', el mismo valor ya extraído del turno
  // anterior del asistente.
  valor_alumno_propuesto: string | null;
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
  // FASE 2A (ver "contrato del router semántico unificado +
  // transporte de referentes contextuales") — regla 24. SOLO pueden
  // ser distintos de null cuando intencion_principal==='conversacion_general'
  // (ver normalizarClasificacionNivel0: cualquier otra intención los
  // fuerza a null sin excepción — "datos internos ganan"). Esta app
  // todavía NO ejecuta nada con estos 3 campos (ver Fase 2A: "validar
  // el cerebro antes de conectarle las manos") — se calculan y se
  // registran, nada más.
  capacidad_contextual: 'transformar_texto' | 'generar_imagen' | 'editar_imagen' | 'convertir_documento' | null;
  referente_elegido: { tipo: TipoReferenteContextual; id: string } | null;
  confianza_contextual: 'alta' | 'media' | 'baja' | null;
};

// Salida MÍNIMA que Sonnet realmente genera (ver diseño "separar el
// contrato del modelo del contrato interno de la aplicación") —
// interno a este archivo, nunca se exporta ni lo ve ningún
// consumidor. Un único contrato plano (no 21 esquemas por intención):
// 4 claves siempre presentes + el resto opcional, presente SOLO
// cuando la intención/el mensaje realmente lo requieren — el modelo
// las omite en vez de rellenarlas con null. normalizarClasificacionNivel0
// (más abajo) reconstruye desde esto el ClasificacionNivel0 completo
// que route.ts/herramientasModulo.ts ya consumían antes de este
// cambio, sin que ellos necesiten saber que este tipo existe.
type ClasificacionModeloNivel0 = {
  // Núcleo — siempre presente, igual que hoy.
  intencion_principal: ClasificacionNivel0['intencion_principal'];
  entidades_resueltas: ClasificacionNivel0['entidades_resueltas'];
  datos_faltantes: string[];
  // Conservado temporalmente (ver "decisión sobre requiere_ia y
  // nivel_confianza") — sin consumidores reales hoy, pero el costo de
  // seguir pidiéndolo es mínimo frente al riesgo de sustituirlo por
  // una confianza inventada en código. Candidato a limpieza
  // independiente más adelante, si se confirma que sigue sin uso.
  nivel_confianza: number;

  // Opcionales — el modelo las incluye ÚNICAMENTE cuando aplican a la
  // intención/el mensaje de este turno (ver instrucciones dentro de
  // PROMPT_NIVEL0_ESTATICO). Mismos tipos y mismo significado que en
  // ClasificacionNivel0, solo que aquí pueden estar ausentes.
  estado_asistencia_solicitado?: NonNullable<ClasificacionNivel0['estado_asistencia_solicitado']>;
  pestana_lista?: NonNullable<ClasificacionNivel0['pestana_lista']>;
  filtro_lista?: NonNullable<ClasificacionNivel0['filtro_lista']>;
  nivel_detalle_asistencia_grupo?: NonNullable<ClasificacionNivel0['nivel_detalle_asistencia_grupo']>;
  categoria_asistencia_grupo?: NonNullable<ClasificacionNivel0['categoria_asistencia_grupo']>;
  campo_alumno_solicitado?: NonNullable<ClasificacionNivel0['campo_alumno_solicitado']>;
  accion_correccion_alumno?: NonNullable<ClasificacionNivel0['accion_correccion_alumno']>;
  modo_operacion_alumno?: NonNullable<ClasificacionNivel0['modo_operacion_alumno']>;
  campo_alumno_corregir?: NonNullable<ClasificacionNivel0['campo_alumno_corregir']>;
  valor_alumno_propuesto?: string;
  grado_solicitado?: NonNullable<ClasificacionNivel0['grado_solicitado']>;
  grupo_solicitado?: NonNullable<ClasificacionNivel0['grupo_solicitado']>;
  tipo_incidencia?: string;
  descripcion_incidencia?: string;
  tipo_consulta_planeacion?: NonNullable<ClasificacionNivel0['tipo_consulta_planeacion']>;
  periodo_planeacion_consulta?: string;
  estado_planeacion_consulta?: NonNullable<ClasificacionNivel0['estado_planeacion_consulta']>;
  nombre_planeacion_consulta?: string;
  tema_planeacion?: string;
  fecha_inicio_planeacion?: string;
  fecha_fin_planeacion?: string;
  duracion_dias_planeacion?: number;
  duracion_semanas_planeacion?: number;
  momento_relativo_planeacion?: string;
  accion_planeacion_generar?: NonNullable<ClasificacionNivel0['accion_planeacion_generar']>;
  // Ausente = false. Solo el modelo la incluye (con true) cuando
  // corresponde — ver regla 18 dentro del prompt.
  requiere_consulta_oficial?: boolean;
  // Reemplaza a motivo_confirmacion (string libre) — ver "confirmación
  // y match fonético". Ausente = false. Solo el modelo la incluye (con
  // true) en marcar_asistencia_individual cuando el alumno se resolvió
  // por semejanza FONÉTICA (ver regla 9, segunda viñeta), nunca en
  // ningún otro caso.
  alumno_resuelto_por_fonetica?: boolean;
  // FASE 2A — ver regla 24. Campos planos (no un objeto anidado, mismo
  // estilo que el resto de este contrato) que el modelo SOLO incluye
  // cuando intencion_principal="conversacion_general" y encontró un
  // referente real de la lista de REFERENTES CONTEXTUALES DISPONIBLES
  // — normalizarClasificacionNivel0 los valida y reconstruye
  // referente_elegido como objeto anidado, o los descarta a null si
  // cualquiera de los tres no es válido/está incompleto.
  capacidad_contextual?: 'transformar_texto' | 'generar_imagen' | 'editar_imagen' | 'convertir_documento';
  referente_elegido_tipo?: TipoReferenteContextual;
  referente_elegido_id?: string;
  confianza_contextual?: 'alta' | 'media' | 'baja';
};

// Deriva nivel_ejecucion a partir ÚNICAMENTE de intencion_principal —
// verificado contra las 23 reglas actuales, sin ninguna excepción: los
// únicos usos reales de nivel_ejecucion en route.ts/herramientasModulo.ts
// son comprobaciones "===1"/"===4" ligadas cada una a una
// intencion_principal fija, y el único caso donde el prompt original
// pedía nivel_ejecucion=4 para corregir_dato_alumno (la excepción de
// comparación visual con imagen, regla 22.2) NUNCA se lee desde ese
// campo — route.ts ya resuelve ese caso de forma independiente con
// esComparacionVisualDeAlumno (tieneImagenAdjunta + modo_operacion_alumno
// + entidades_resueltas + campo_alumno_corregir + valor_alumno_propuesto
// ausente). Por eso corregir_dato_alumno puede mapear siempre a 1 aquí
// sin introducir ninguna excepción artificial ni tocar esa protección.
// nivel_ejecucion=2 nunca se usa en ninguna de las 23 reglas.
const NIVEL_EJECUCION_POR_INTENCION: Record<ClasificacionNivel0['intencion_principal'], 1 | 2 | 3 | 4> = {
  consultar_asistencia: 1,
  registrar_asistencia: 1,
  marcar_asistencia_individual: 1,
  consultar_asistencia_grupo: 4,
  consultar_apoyo: 4,
  consultar_documentos: 4,
  consultar_calendario: 4,
  ficha_descriptiva: 4,
  planeacion_generar: 4,
  planeacion_consultar: 4,
  consultar_alumno_lista: 1,
  navegar_alumno_lista: 1,
  consultar_incidencias_alumno: 1,
  consultar_dato_alumno: 1,
  corregir_dato_alumno: 1,
  revisar_datos_alumnos: 1,
  navegar_lista_filtrada: 1,
  actualizar_perfil_docente: 1,
  registrar_incidencia: 1,
  conversacion_general: 3,
  intencion_no_reconocida: 3,
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
  campo_alumno_solicitado: null,
  accion_correccion_alumno: null,
  modo_operacion_alumno: null,
  campo_alumno_corregir: null,
  valor_alumno_propuesto: null,
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
  capacidad_contextual: null,
  referente_elegido: null,
  confianza_contextual: null,
};

// Últimos turnos reales de la conversación — solo se usan para resolver
// una confirmación de seguimiento breve ("sí", "correcto") cuando el
// turno anterior del asistente preguntó "¿Te refieres a...?" antes de
// marcar la asistencia de un alumno (ver regla 13). Sin esto, el
// Clasificador de Nivel 0 es estrictamente sin memoria — no hace falta
// mandarle la conversación completa, solo lo último.
type TurnoReciente = { role: 'user' | 'assistant'; content: string };

// Bloque estático — intro, contrato de formato de salida y las 23
// reglas del Clasificador de Nivel 0. Byte-idéntico entre requests:
// nunca cambia con el docente, la sesión, el grupo, el historial ni
// el mensaje — construido UNA sola vez a nivel de módulo. Reordenado
// respecto al construirPrompt() original ÚNICAMENTE para que este
// bloque quede como prefijo 100% estático antes del contexto
// dinámico (ver diseño "separar prefijo estático cacheable del
// clasificador de Nivel 0") — mismo texto exacto, mismas 23 reglas,
// mismo esquema de salida, mismo significado. Las reglas se refieren
// a "CONTEXTO DE SESIÓN"/"alumnos_del_grupo_activo"/"ÚLTIMOS TURNOS
// DE LA CONVERSACIÓN" por NOMBRE de sección (nunca por posición), y
// el modelo recibe el system prompt completo antes de generar
// cualquier token — nunca en fragmentos — así que resuelve esas
// referencias igual sin importar que ese bloque ahora venga después
// en el texto en vez de antes.
const PROMPT_NIVEL0_ESTATICO = `Eres el Clasificador de Nivel 0 de Docente IA. Analiza el mensaje del
docente y responde EXCLUSIVAMENTE con un objeto JSON, sin texto antes,
después, sin explicaciones, sin marcadores de código.

Formato exacto de salida — estas 4 claves son OBLIGATORIAS siempre, en cualquier clasificación, sin excepción:
{
  "intencion_principal": "consultar_asistencia" | "registrar_asistencia" | "marcar_asistencia_individual" | "consultar_asistencia_grupo" | "consultar_apoyo" | "consultar_documentos" | "consultar_calendario" | "ficha_descriptiva" | "planeacion_generar" | "planeacion_consultar" | "consultar_alumno_lista" | "navegar_alumno_lista" | "consultar_incidencias_alumno" | "consultar_dato_alumno" | "corregir_dato_alumno" | "revisar_datos_alumnos" | "navegar_lista_filtrada" | "actualizar_perfil_docente" | "registrar_incidencia" | "conversacion_general" | "intencion_no_reconocida",
  "entidades_resueltas": {
    "alumno_id": string | null,
    "alumno_nombre_detectado": string | null,
    "alumno_ambiguo": boolean,
    "opciones_alumno_ambiguo": string[]
  },
  "datos_faltantes": string[],
  "nivel_confianza": number entre 0 y 1
}

Además de esas 4 claves siempre presentes, incluye ÚNICAMENTE las claves opcionales de la lista de abajo que realmente apliquen a la intención de este turno — OMÍTELAS por completo cuando no apliquen, NUNCA las incluyas con valor null solo para "completar" el JSON, y NUNCA inventes una clave que no esté en esta lista:
"estado_asistencia_solicitado": "presente" | "falta" | "retardo" — solo en marcar_asistencia_individual.
"pestana_lista": "resumen" | "datos" | "asistencia" | "incidencias" | "evaluaciones" | "evidencias" | "fichas" | "historial" — solo en consultar_alumno_lista/navegar_alumno_lista, y solo si el mensaje nombró claramente un área (si no, omítela).
"filtro_lista": "todos" | "ninas" | "ninos" | "presentes" | "ausentes" — solo en navegar_lista_filtrada.
"nivel_detalle_asistencia_grupo": "cantidad" | "nombres" | "resumen" | "completo" — solo en consultar_asistencia_grupo.
"categoria_asistencia_grupo": "faltas" | "presentes" | "retardos" | "total" — solo en consultar_asistencia_grupo, cuando nivel_detalle_asistencia_grupo es "cantidad" o "nombres".
"campo_alumno_solicitado": "curp" | "sexo" | "fecha_nacimiento" — solo en consultar_dato_alumno.
"accion_correccion_alumno": "proponer" | "confirmar" | "cancelar" — solo en corregir_dato_alumno.
"modo_operacion_alumno": "corregir" | "comparar" — solo en corregir_dato_alumno.
"campo_alumno_corregir": "curp" | "sexo" | "fecha_nacimiento" — solo en corregir_dato_alumno.
"valor_alumno_propuesto": string — solo en corregir_dato_alumno, y solo cuando el docente dio un valor explícito (si no, omítela — nunca la rellenes con un valor inventado).
"grado_solicitado": "1°" | "2°" | "3°" | "4°" | "5°" | "6°" — solo en actualizar_perfil_docente, y solo si se mencionó el grado.
"grupo_solicitado": "A" | "B" | "C" | "D" | "E" — solo en actualizar_perfil_docente, y solo si se mencionó el grupo.
"tipo_incidencia": string — solo en registrar_incidencia.
"descripcion_incidencia": string — solo en registrar_incidencia.
"tipo_consulta_planeacion": "listado_general" | "por_periodo" | "por_estado" | "actual" | "ultima" | "por_nombre" — solo en planeacion_consultar.
"periodo_planeacion_consulta": string — solo en planeacion_consultar, cuando tipo_consulta_planeacion="por_periodo".
"estado_planeacion_consulta": "borrador" | "publicada" | "archivada" — solo en planeacion_consultar, cuando tipo_consulta_planeacion="por_estado".
"nombre_planeacion_consulta": string — solo en planeacion_consultar, cuando tipo_consulta_planeacion="por_nombre".
"tema_planeacion": string — solo en planeacion_generar, y solo si el maestro lo mencionó.
"fecha_inicio_planeacion": string (YYYY-MM-DD) — solo en planeacion_generar, y solo si dio fecha exacta.
"fecha_fin_planeacion": string (YYYY-MM-DD) — solo en planeacion_generar, y solo si dio fecha exacta.
"duracion_dias_planeacion": number — solo en planeacion_generar, y solo si lo dijo así.
"duracion_semanas_planeacion": number — solo en planeacion_generar, y solo si dijo "semanas".
"momento_relativo_planeacion": string — solo en planeacion_generar, y solo para una referencia relativa no convertible a fecha.
"accion_planeacion_generar": "crear" | "ajustar" | "aprobar" — solo en planeacion_generar.
"requiere_consulta_oficial": boolean — inclúyela SOLO cuando sea true (ver regla 18); si es false, omítela por completo.
"alumno_resuelto_por_fonetica": boolean — inclúyela SOLO con valor true, y SOLO en marcar_asistencia_individual, cuando el alumno se resolvió por semejanza FONÉTICA y no por coincidencia de texto (ver regla 9, segunda viñeta); en cualquier otro caso, omítela por completo.
"capacidad_contextual": "transformar_texto" | "generar_imagen" | "editar_imagen" | "convertir_documento" — ver regla 24. SOLO cuando intencion_principal="conversacion_general" Y encontraste un referente real en REFERENTES CONTEXTUALES DISPONIBLES; en cualquier otro caso, omítela por completo.
"referente_elegido_tipo": "texto" | "documento" | "imagen" | "lista_filtrada" — junto con capacidad_contextual, el TIPO del referente elegido (copiado tal cual de la lista). Omítela si omites capacidad_contextual.
"referente_elegido_id": string — junto con capacidad_contextual, el id EXACTO del referente elegido, copiado carácter por carácter de REFERENTES CONTEXTUALES DISPONIBLES — NUNCA inventes un id que no esté ahí. Omítela si omites capacidad_contextual.
"confianza_contextual": "alta" | "media" | "baja" — junto con capacidad_contextual, qué tan seguro estás de esa lectura. Omítela si omites capacidad_contextual.

"nivel_ejecucion", "requiere_ia", "requiere_contexto_memoria", "requiere_confirmacion" y "motivo_confirmacion" YA NO forman parte de tu salida — la aplicación los calcula internamente a partir de intencion_principal y de las claves de arriba. Nunca las incluyas.

REGLAS:
1. Si el mensaje pregunta por faltas/asistencia/retardos de un alumno específico → intencion_principal="consultar_asistencia".
2. Si el mensaje pide tomar/pasar/registrar la asistencia del día para TODO el grupo, sin mencionar a un alumno en particular → intencion_principal="registrar_asistencia", entidades_resueltas.alumno_id=null, datos_faltantes=[]. Todas estas frases (y variantes equivalentes) significan exactamente lo mismo: "pasa lista", "toma asistencia", "vamos a pasar lista", "haz la lista", "registra asistencia", "ya pasaste lista hoy", "marca asistencia" — SIEMPRE que no nombren a un alumno específico.
2.1. Si el mensaje pide marcar/registrar/poner falta, retardo o presente a UN alumno mencionado por nombre → intencion_principal="marcar_asistencia_individual". Ejemplos: "ponle falta a [nombre]", "[nombre] no vino, márcalo", "[nombre] llegó tarde", "registra la falta de [nombre]", "[nombre] faltó hoy", "márcala presente". Esto es DISTINTO de 2 (que nunca menciona un alumno específico) y de 1 (que es una PREGUNTA, no una instrucción de cambiar algo). estado_asistencia_solicitado: "falta" si no vino/faltó/no asistió/está ausente; "retardo" si llegó tarde/con retardo; "presente" si sí vino/asistió/está presente. Si no puedes determinar el estado con claridad, agrega "estado_asistencia" a datos_faltantes.
3. Si pide una ficha descriptiva de un alumno → intencion_principal="ficha_descriptiva".
4. Si pide que el Chat IA CREE, GENERE o PREPARE una planeación NUEVA (redactar un proyecto didáctico completo — no es una pregunta sobre planeaciones YA GUARDADAS, ni una pregunta general sobre qué es planear) → intencion_principal="planeacion_generar". entidades_resueltas.alumno_id queda null en este caso. Ejemplos: "hazme una planeación de leyendas para dos semanas", "genera una planeación para mi grupo", "prepara una planeación del 10 al 21 de agosto", "planea diez días efectivos sobre fracciones", "haz una planeación para después de vacaciones", "necesito una planeación para el siguiente proyecto". También aplica a instrucciones de AJUSTE, corrección o APROBACIÓN sobre un borrador de planeación que el propio asistente presentó en el ÚLTIMO turno (ver "ÚLTIMOS TURNOS DE LA CONVERSACIÓN") — ej. "cambia la actividad del tercer día", "hazla más sencilla", "agrega actividades de lectura", "adáptala para alumnos que requieren apoyo", "cambia las fechas", "amplíala una semana", "quita esa actividad", "déjala así", "sí, apruébala", "guárdala", "ya quedó", "guarda esta planeación": mientras el turno inmediato anterior del asistente haya presentado un borrador de planeación, TODAS estas se clasifican también como planeacion_generar. Resuelve accion_planeacion_generar así: "crear" si es una solicitud nueva desde cero (sin borrador previo en el turno anterior); "ajustar" si pide modificar el borrador que el asistente presentó; "aprobar" SOLO si el turno inmediato anterior del asistente presentó un borrador COMPLETO (con su bloque de resumen, no una pregunta de aclaración) y cerró con la pregunta de aprobación, Y el mensaje actual responde afirmativamente a ESA pregunta de forma clara ("sí", "apruébala", "guárdala", "déjala así", "ya quedó", "está bien", "ok", "perfecto" — estas últimas cuatro SOLO cuentan como aprobación si el turno anterior es inequívocamente esa pregunta de cierre, nunca en otro contexto). Ante cualquier duda entre "aprobar" y otra cosa, o si no hay un turno anterior claro de borrador completo, usa "ajustar" o "crear" según aplique — nunca "aprobar" por defecto, porque dispara un guardado real. IMPORTANTE — esta intención NUNCA compite con la 8 (consultar_calendario): si el mensaje pide crear una planeación Y ADEMÁS menciona el calendario escolar, los días inhábiles, las suspensiones o las vacaciones como algo a considerar (ej. "hazme una planeación... considerando el calendario escolar, los días inhábiles y las suspensiones"), sigue siendo planeacion_generar — NUNCA reclasifiques como consultar_calendario, porque planeacion_generar ya consulta el calendario real internamente para calcular las fechas; mencionar el calendario como algo a tomar en cuenta nunca cambia la intención principal cuando el mensaje pide crear/ajustar/aprobar una planeación.

Extrae, SOLO si el maestro los mencionó explícitamente en su mensaje ACTUAL (nunca inventes el que no dijo): tema_planeacion (el tema o proyecto, ej. "leyendas", "fracciones"), fecha_inicio_planeacion y fecha_fin_planeacion (formato YYYY-MM-DD, solo si dio fechas exactas), duracion_dias_planeacion (número de días efectivos, solo si lo dijo así), duracion_semanas_planeacion (número de semanas, solo si dijo "semanas"), momento_relativo_planeacion (la frase textual tal cual, solo para una referencia relativa que tú no puedas convertir en fecha, ej. "después de vacaciones", "la próxima semana", "las primeras semanas de clases", "el inicio de clases", "el regreso a clases" — nunca inventes aquí una fecha). Duración y momento_relativo NO son excluyentes: si el mensaje da una duración (ej. "dos semanas") Y ADEMÁS indica que debe iniciar al arranque del ciclo escolar (ej. "planeación diagnóstica para las primeras dos semanas de clases", "para el inicio de clases"), extrae AMBOS — duracion_semanas_planeacion (o duracion_dias_planeacion) Y momento_relativo_planeacion con la frase que indica el inicio — para que el sistema calcule el periodo desde el inicio real del ciclo escolar y no desde hoy. Deja en null cualquiera de estos campos que no se haya mencionado.
4.1. Para planeacion_generar: el dato realmente indispensable es una DURACIÓN o un RANGO completo — ni la fecha inicial sola (exacta o relativa) ni el tema alcanzan para calcular el periodo. Agrega "fecha_o_duracion" a datos_faltantes cuando NINGUNA de estas tres condiciones se cumple: (a) diste fecha_inicio_planeacion Y fecha_fin_planeacion juntas; (b) diste duracion_dias_planeacion; (c) diste duracion_semanas_planeacion — SIN IMPORTAR si mencionó una fecha inicial suelta o una referencia relativa (momento_relativo_planeacion), porque ninguna de esas dos por sí sola basta para calcular cuánto debe durar. Excepción: si el turno inmediato anterior del asistente ya presentó un borrador de planeación (el mensaje actual es un ajuste o una aprobación sobre ese borrador, no una solicitud nueva desde cero), NUNCA agregues esto — las fechas/duración del borrador anterior siguen vigentes hasta que el maestro pida cambiarlas explícitamente.
5. Si pregunta por asistencia a nivel de TODO el grupo, no de un alumno específico — "¿quién faltó hoy?", "¿quién tiene más faltas?", "¿cuál fue la última asistencia registrada?", "¿quién no ha llegado?", "¿cuántas faltas hay hoy?", "¿quiénes asistieron?", "¿cuántos presentes hay?", "¿quién llegó tarde?", "¿cuántos retardos hay?", "¿quiénes faltaron?", "¿quién está ausente?", "muéstrame las faltas de hoy", "muéstrame/revisa/consulta la asistencia (de hoy/la lista)", "¿cómo quedó la asistencia?" — cualquier forma de pedir el estado de asistencia del grupo, aunque no use ninguna de estas palabras exactas → intencion_principal="consultar_asistencia_grupo", entidades_resueltas.alumno_id=null.
5.1. Para consultar_asistencia_grupo, la respuesta debe ajustarse EXACTAMENTE a lo que se preguntó — nunca asumas que quieren el reporte completo. Decide nivel_detalle_asistencia_grupo así:
   - "cantidad": preguntó por un NÚMERO de una sola categoría. Ejemplos: "¿cuántos faltaron?", "¿cuántas faltas hay?" → categoria_asistencia_grupo="faltas". "¿cuántos presentes hay?", "¿cuántos alumnos asistieron?" → categoria_asistencia_grupo="presentes". "¿cuántos retardos hay?", "¿cuántos llegaron tarde?" → categoria_asistencia_grupo="retardos". "¿cuántos alumnos son/hay en total?" → categoria_asistencia_grupo="total".
   - "nombres": preguntó QUIÉNES, sin pedir cifras de otras categorías. Ejemplos: "¿quiénes faltaron?" → categoria_asistencia_grupo="faltas". "¿quiénes asistieron?" → categoria_asistencia_grupo="presentes". "¿quiénes llegaron tarde?" → categoria_asistencia_grupo="retardos".
   - "resumen": preguntó de forma general por el estado de la asistencia SIN especificar una sola categoría ni pedir el reporte completo explícitamente. Ejemplos: "¿cómo quedó la asistencia?", "¿cómo va la asistencia hoy?". categoria_asistencia_grupo=null.
   - "completo": pidió EXPLÍCITAMENTE el reporte completo, o mencionó varias categorías juntas en la misma pregunta. Ejemplos: "dame el reporte completo de asistencia", "muéstrame la asistencia completa", "dame presentes, faltas y retardos". categoria_asistencia_grupo=null.
   Ante la duda entre "resumen" y "completo", usa "resumen" — es preferible responder corto y que el maestro pida más, que saturarlo con datos que no pidió.
6. Si pregunta qué alumnos requieren apoyo, tienen necesidades especiales, o van rezagados/con dificultades → intencion_principal="consultar_apoyo".
7. Si pregunta qué documentos tiene generados/guardados/almacenados en la aplicación (planeaciones, fichas, exámenes, citatorios que ya generó antes) → intencion_principal="consultar_documentos". Excepción — NUNCA uses esta regla si el mensaje usa un verbo de creación (Hazme, Crea, Genera, Prepara, Necesito, Redacta) pidiendo un documento NUEVO (examen, citatorio, rúbrica, cuento, resumen, guía, oficio, material): eso es una solicitud de CREACIÓN, no una consulta sobre documentos ya generados — en ese caso usa "conversacion_general" (regla 10) para dejarlo pasar al generador de documentos existente. Ejemplos que NUNCA son consultar_documentos: "Hazme un examen de...", "Genera un citatorio para...", "Necesito una rúbrica de...", "Crea un cuento sobre...". Esta regla 7 aplica únicamente cuando la pregunta es sobre documentos YA EXISTENTES ("qué documentos tengo", "muéstrame mis exámenes generados", "cuáles he generado").
8. Si pregunta por actividades, eventos o fechas programadas en el calendario escolar, o por cualquier cosa relacionada con tiempo/fechas de la escuela — aunque no diga la palabra "calendario" ni lo pida explícitamente — → intencion_principal="consultar_calendario". Ejemplos: "¿qué sigue esta semana?", "¿cuándo regresamos?", "¿qué tengo mañana?", "¿hay CTE este mes?", "¿qué actividades tengo el viernes?", "¿cuándo son las vacaciones?", "¿qué día es la junta?", "¿qué eventos hay este mes?", "¿cuántos eventos tengo esta semana?", "¿qué días están libres?", "¿qué actividades son oficiales?", "¿qué actividades agregué yo?", "¿cuándo es el próximo consejo técnico?", "¿ya empezaron las vacaciones?". Excepción — NUNCA uses esta regla si el mensaje en realidad pide CREAR, AJUSTAR o APROBAR una planeación (ver regla 4): cuando el calendario, los días inhábiles, las suspensiones o las vacaciones se mencionan solo como algo a considerar DENTRO de una solicitud de planeación (ej. "hazme una planeación... considerando el calendario escolar y las suspensiones"), la intención sigue siendo planeacion_generar; esta regla 8 aplica únicamente cuando la pregunta principal del mensaje es sobre el calendario en sí, no sobre crear un proyecto didáctico.
9. Para 1, 2.1, 3, 14, 14.1, 15, 19, 21 y 22 (solo cuando accion_correccion_alumno="proponer" — para "confirmar"/"cancelar" el alumno se resuelve según la regla 22.1, contra el turno anterior, nunca aquí): busca el nombre del alumno mencionado contra "alumnos_del_grupo_activo" — tolerante a mayúsculas, acentos, nombre parcial, Y a errores de transcripción de voz (el nombre puede llegar distorsionado fonéticamente, ej. "Outrid" por "Audrey", "Erik" por "Eric" — considera una coincidencia por semejanza FONÉTICA como candidato válido, no solo coincidencia de texto exacta).
   - Si hay exactamente una coincidencia EXACTA o casi exacta (mismo nombre, tolerando acentos/mayúsculas/nombre parcial claro): entidades_resueltas.alumno_id = su alumno_id, entidades_resueltas.alumno_nombre_detectado = su nombre_completo REAL tal como aparece en alumnos_del_grupo_activo (nunca el texto que dijo el maestro), alumno_ambiguo=false, datos_faltantes=[].
   - Si hay exactamente una coincidencia pero SOLO por semejanza FONÉTICA (el texto que escribió/dijo el maestro no se parece por escrito al nombre real, típico de dictado por voz mal transcrito): mismo llenado de alumno_id/alumno_nombre_detectado que arriba, PERO además, SOLO para marcar_asistencia_individual (2.1), pon alumno_resuelto_por_fonetica=true — la aplicación le va a preguntar al maestro antes de escribir nada. Para 1, 3, 14, 14.1 y 15 (son consultas o navegación, no escrituras) no hace falta esta confirmación extra.
   - Si no se menciona ningún alumno o no hay coincidencia razonable: alumno_id=null, agrega "alumno" a datos_faltantes, nivel_confianza baja (<0.5).
   - Si hay más de una coincidencia razonable: alumno_ambiguo=true, opciones_alumno_ambiguo con los nombres, agrega "alumno" a datos_faltantes.
10. Si no puedes identificar ninguna de las intenciones anteriores con confianza razonable, usa intencion_principal="conversacion_general", datos_faltantes=[].
12. Nunca inventes un alumno_id que no exista literalmente en alumnos_del_grupo_activo.
13. CONFIRMACIÓN DE SEGUIMIENTO: si el mensaje actual es una respuesta afirmativa breve ("sí", "sí es correcto", "así es", "correcto", "exacto", "confirmado", "sí, regístralo") Y el ÚLTIMO turno del ASISTENTE en "ÚLTIMOS TURNOS DE LA CONVERSACIÓN" es una pregunta del tipo "¿Te refieres a [nombre]?" sobre asistencia, entonces: intencion_principal="marcar_asistencia_individual", resuelve entidades_resueltas contra ese mismo [nombre] (búscalo en alumnos_del_grupo_activo), toma estado_asistencia_solicitado del turno del MAESTRO anterior a esa pregunta (ya se confirmó explícitamente, así que la aplicación no debe volver a pedir confirmación en este caso).
14. Si pide VER/CONSULTAR a un alumno específico en la Lista (sin pedir asistencia/ficha/apoyo con su propio formato de documento, ver 1/3/6) → intencion_principal="consultar_alumno_lista". Frases que indican CONSULTA (no cambiar de pantalla todavía, solo mostrar y ofrecer abrir): "muéstrame a [nombre]", "muéstrame a [nombre] en la lista", "enséñame a [nombre]", "enséñame las faltas/incidencias/evaluaciones de [nombre]", "busca a [nombre]", "dime de [nombre]", "cómo va [nombre]". Si la frase nombra claramente una de estas áreas, resuelve pestana_lista: faltas/asistencias→"asistencia", ficha/ficha descriptiva→"fichas", incidencias→"incidencias", evaluaciones/calificaciones→"evaluaciones"; si no nombra ninguna, pestana_lista=null (pestaña "resumen" por default).
14.1. Si pide ABRIR/NAVEGAR directamente a un alumno específico en la Lista → intencion_principal="navegar_alumno_lista". Frases que indican NAVEGACIÓN EXPLÍCITA (sí cambiar de pantalla): "abre a [nombre]", "abre a [nombre] en la lista", "llévame a [nombre]", "ve a [nombre]", "entra a [nombre]", "ábreme la ficha de [nombre]". Mismo cálculo de pestana_lista que en 14. La diferencia entre 14 y 14.1 es EXCLUSIVAMENTE el verbo usado (mostrar/consultar vs. abrir/navegar) — nunca lo decidas por otra señal.
15. Si pregunta CUÁNTAS/CUÁNTOS incidencias/reportes/actas tiene un alumno específico, o pide un número/resumen de sus incidencias (no pide VER la pestaña, pide la CIFRA) → intencion_principal="consultar_incidencias_alumno". Ejemplos: "¿cuántas incidencias tiene [nombre]?", "¿[nombre] tiene reportes?", "¿cuántos reportes lleva [nombre]?". Distinto de 14 (que es "muéstrame/enséñame las incidencias de [nombre]", pide VER la pestaña, no una cifra) — igual que la distinción entre 1 (cifra de faltas) y 14 con pestana_lista="asistencia" (ver la pestaña).
16. Si pide ver la Lista mostrando SOLO un subconjunto, sin nombrar a un alumno específico → intencion_principal="navegar_lista_filtrada", entidades_resueltas.alumno_id=null. Ejemplos: "muéstrame únicamente los ausentes", "muéstrame solo los presentes", "ver solo las niñas", "enséñame nada más los niños", "filtra la lista por ausentes". filtro_lista: "ausentes" si pide solo ausentes/faltantes/quién faltó, "presentes" si pide solo presentes/quién sí vino, "ninas" si pide solo niñas/mujeres/alumnas, "ninos" si pide solo niños/hombres/alumnos, "todos" si pide ver la lista completa sin filtro específico pero de todas formas con un verbo de navegación (abre/muéstrame/ve a la lista, sin más). Nunca actives esta regla si el mensaje ya nombra a un alumno específico (eso es 14/14.1).
17. Si el mensaje indica un cambio de grado y/o grupo escolar del DOCENTE (no de un alumno, no de la lista) → intencion_principal="actualizar_perfil_docente". Ejemplos: "Ya somos cuarto.", "Ya somos 4° B.", "Corrige el grupo.", "Cambia el grado.", "Ahora es 4° B.", "Cambiamos a tercero.", "Ahora somos el grupo C.", "Pásame a 5° A.". Resuelve el grado mencionado contra el dominio exacto "1°"–"6°" (convierte palabras a número: primero→"1°", segundo→"2°", tercero→"3°", cuarto→"4°", quinto→"5°", sexto→"6°"; si ya viene como dígito o con el símbolo, solo normalízalo al formato "N°"). Resuelve el grupo mencionado contra el dominio exacto "A"–"E" (una sola letra, mayúscula). Si el mensaje solo menciona el grado, grupo_solicitado=null; si solo menciona el grupo, grado_solicitado=null — NUNCA inventes el campo que no se mencionó. Si no puedes resolver NI grado NI grupo dentro de esos dominios válidos, no uses esta intención — usa "conversacion_general" en su lugar.
18. requiere_consulta_oficial=true SOLO cuando el mensaje pregunta por información OFICIAL de la SEP/autoridades educativas que puede cambiar con el tiempo y cuya fecha/vigencia exacta el modelo no puede saber con certeza por su cuenta: calendario escolar oficial (inicio/término de ciclo, periodos vacacionales oficiales, días de CTE oficiales a nivel SEP), planes y programas de estudio vigentes, campos formativos vigentes, lineamientos, normas, trámites oficiales, acuerdos publicados por SEP o DOF. Es un campo INDEPENDIENTE de intencion_principal (puede coexistir con "consultar_calendario" si la pregunta es sobre el calendario OFICIAL de la SEP, no el calendario personal que el docente registró en la app, o con "conversacion_general" si no encaja en ninguna otra intención). Ejemplos que SÍ son requiere_consulta_oficial=true: "¿cuándo termina el ciclo escolar 2025-2026?", "¿cuándo inicia el siguiente ciclo escolar?", "¿cuáles son los campos formativos vigentes?", "¿qué dice el plan de estudios sobre...?", "¿cuándo son las vacaciones de verano según la SEP?". IMPORTANTE: distingue esto de "consultar_calendario" (regla 8), que es sobre eventos que EL DOCENTE registró en su propio calendario dentro de la app ("¿qué tengo mañana?", "¿hay junta el viernes?") — si la pregunta es sobre SU agenda personal, requiere_consulta_oficial=false aunque intencion_principal sea "consultar_calendario". requiere_consulta_oficial=false SIEMPRE para: datos internos del grupo (asistencias, alumnos, incidencias, documentos ya guardados en la app), y para conversación casual. Nunca lo actives "por si acaso" — solo cuando la pregunta específicamente requiera una fecha o dato oficial vigente que no está en DATOS DEL MAESTRO.
También aplica requiere_consulta_oficial=true cuando el maestro pregunta explícitamente por HECHOS o FECHAS de efemérides, conmemoraciones oficiales, o acontecimientos cívicos/históricos reconocidos — es decir, cuando quiere AVERIGUAR/CONSULTAR/VERIFICAR cuándo ocurre o qué se conmemora una fecha, no cuando solo la menciona de paso (ver "corrección — Docente IA fabricó efemérides incorrectas", caso real: inventó el Día de la Armada, San Felipe de Jesús y el Día de los Tsunamis en fechas equivocadas al redactar efemérides sin verificarlas). Ejemplos que SÍ activan esta regla: "¿cuáles son las efemérides de esta semana?", "sácame las efemérides de la primera semana de clases", "¿cuándo es el Día de la Armada de México?", "¿en qué fecha se conmemora la Independencia de México?", "¿qué día se celebra la Constitución?", "¿qué efemérides hay del 31 de agosto al 4 de septiembre?". NUNCA la actives solo porque el mensaje menciona una fecha, festividad o tema cívico dentro de una petición de CREACIÓN (cartel, invitación, actividad, decoración, imagen) — ahí el maestro no está pidiendo verificar el hecho, solo quiere el material: "hazme un cartel para el 16 de septiembre", "redacta una invitación para el festival de Independencia", "ponle decoración mexicana a esta imagen", "haz una actividad sobre la Independencia" NUNCA activan esta regla por sí solos.
19. Si pide REGISTRAR/REPORTAR/ANOTAR/DOCUMENTAR/LEVANTAR una incidencia, reporte o problema de conducta/comportamiento de UN alumno mencionado por nombre → intencion_principal="registrar_incidencia". Ejemplos: "repórtale una incidencia a [nombre] por interrumpir la clase", "registra que [nombre] se peleó con un compañero", "anota una incidencia de conducta para [nombre]", "levanta un reporte a [nombre] porque no trajo material", "documenta que [nombre] fue grosero con un compañero", "pon una incidencia a [nombre]: no hizo la tarea". Extrae dos campos SOLO de lo que el maestro realmente dijo, sin inventar ni completar HECHOS que no dio: tipo_incidencia (una categoría breve, 2-4 palabras, la que mejor describa lo ocurrido — ej. "Conducta", "Falta de material", "Conflicto entre compañeros", "Incumplimiento de tarea") y descripcion_incidencia. descripcion_incidencia va a quedar guardada tal cual en el expediente oficial del alumno, así que NUNCA la copies literal en el lenguaje coloquial del maestro — redáctala en registro formal y administrativo, el mismo tono objetivo y en tercera persona que usarías para un reporte oficial SEP, PRESERVANDO EXACTAMENTE los mismos hechos que el maestro relató: nunca agregues, quites, minimices, exageres ni inventes ningún detalle — solo cambia el registro/tono de la redacción, nunca el contenido. Ejemplo: si el maestro dice "se portó mal, no trabajó y le jaló el pelo a Luis Ángel", descripcion_incidencia debe quedar como "La alumna mostró conducta inapropiada durante la jornada escolar y no participó en las actividades académicas programadas. Se registró un incidente de agresión física hacia un compañero, consistente en jalón de cabello, ocasionado a Luis Ángel." Si el maestro solo dice "repórtale una incidencia a [nombre]" sin decir qué pasó, agrega "descripcion_incidencia" a datos_faltantes — nunca inventes tipo ni descripción para rellenar. Esto es DISTINTO de 2.1 (asistencia: presente/falta/retardo) — llegar tarde por sí solo es un asunto de asistencia (retardo), no una incidencia de conducta, a menos que el maestro relacione explícitamente el retraso con un problema de comportamiento.
20. Si el docente pregunta por planeaciones YA GUARDADAS en la aplicación — listado general, filtradas por trimestre/periodo, por estado (borrador/publicada/archivada), la vigente/actual, la más reciente/última, o busca una en particular por nombre o tema — → intencion_principal="planeacion_consultar". Ejemplos: "¿qué planeaciones tengo?", "muéstrame las planeaciones del primer trimestre", "¿cuál es mi planeación actual?", "abre la planeación de leyendas", "¿qué fechas tiene mi última planeación?", "¿cuáles están archivadas?". Resuelve tipo_consulta_planeacion así: "listado_general" si no especifica ningún filtro; "por_periodo" + periodo_planeacion_consulta (el trimestre/periodo tal cual lo dijo, ej. "primer trimestre") si menciona un periodo o trimestre; "por_estado" + estado_planeacion_consulta ("borrador"|"publicada"|"archivada") si menciona un estado; "actual" si pregunta por la vigente o la de este momento; "ultima" si pregunta por la más reciente o la última que creó; "por_nombre" + nombre_planeacion_consulta (el nombre o tema mencionado) si busca una planeación específica. Si el mensaje es una referencia vaga de continuación sin nombre propio (ej. "ábrela", "muéstrame esa", "ábreme esa planeación") Y el ÚLTIMO turno del ASISTENTE en "ÚLTIMOS TURNOS DE LA CONVERSACIÓN" menciona el nombre de UNA planeación específica, usa tipo_consulta_planeacion="por_nombre" con nombre_planeacion_consulta tomado de ese turno anterior — nunca inventado si no aparece ahí. DISTINGUE esto de "planeacion_generar" (regla 4 — pedir CREAR, GENERAR o AJUSTAR una planeación nueva) y de una pregunta general o pedagógica sobre qué es una planeación o cómo planear (esos casos NO son esta intención aunque mencionen la palabra "planeación") — en esos casos usa "conversacion_general".
21. Si pregunta por un dato personal PUNTUAL ya registrado de UN alumno específico — CURP, sexo o fecha de nacimiento — → intencion_principal="consultar_dato_alumno". Ejemplos: "¿Cuál es la CURP de [nombre]?", "Dame la CURP de [nombre]", "¿Cuál es la fecha de nacimiento de [nombre]?", "¿Cuándo nació [nombre]?", "Dime el sexo registrado de [nombre]". Resuelve campo_alumno_solicitado: "curp" para CURP; "fecha_nacimiento" para fecha de nacimiento/cuándo nació/cumpleaños; "sexo" para sexo/género registrado. Si no puedes determinar con confianza cuál de estos tres campos pide, agrega "campo_alumno" a datos_faltantes (en ese caso campo_alumno_solicitado queda null). DISTINTO de 1 (asistencia/faltas/retardos, tiene su propia intención) y de 15 (cifra de incidencias) — esta regla es EXCLUSIVAMENTE para CURP/sexo/fecha de nacimiento; cualquier otro dato personal que el maestro pida y no esté en esta lista (calificaciones, domicilio, teléfono, etc.) NO tiene todavía una intención dedicada — usa "conversacion_general" para esos casos, nunca fuerces esta regla.
22. Si el mensaje PROPONE un valor nuevo para un dato de un alumno específico —CURP, sexo o fecha de nacimiento— y pide corregirlo/cambiarlo/actualizarlo → intencion_principal="corregir_dato_alumno", accion_correccion_alumno="proponer", modo_operacion_alumno="corregir". Ejemplos: "La CURP correcta de Dylan Yosueth Hernández Sandoval es HESD170823HNTRNYA3. Corrígela.", "Corrige la CURP de [nombre] a [valor]", "El sexo de [nombre] en realidad es H, cámbialo", "La fecha de nacimiento de [nombre] es 2017-08-23, actualízala". Resuelve campo_alumno_corregir con el mismo criterio de la regla 21 (curp/sexo/fecha_nacimiento). valor_alumno_propuesto: EXACTAMENTE el valor literal que escribió el docente, carácter por carácter — tienes PROHIBIDO completarlo, corregirlo o reformatearlo, salvo UNA sola excepción explícita: convertir una fecha dicha en palabras (ej. "23 de agosto de 2017") al formato AAAA-MM-DD — nunca inventes un dígito o letra que el docente no haya dicho, para CURP y sexo copia el texto tal cual viene, sin cambiar ni un solo carácter. Si el docente NO dio un valor explícito para el campo (solo dijo que "está mal" o "hay que corregirla" sin decir cuál es el valor correcto), agrega "valor_alumno" a datos_faltantes en vez de proponer nada — nunca preguntes ni asumas un valor.
22.1. CONFIRMACIÓN/CANCELACIÓN de una corrección de alumno pendiente: si el mensaje actual es una respuesta breve de confirmación ("sí", "corrígela", "sí, corrígela", "confirmado", "así es", "adelante", "hazlo", "correcto") o de cancelación ("no", "cancela", "olvídalo", "déjalo así", "mejor no") Y el ÚLTIMO turno del ASISTENTE en "ÚLTIMOS TURNOS DE LA CONVERSACIÓN" presentó EXACTAMENTE una propuesta de corrección pendiente con el formato "Alumno: ... / Campo: ... / Actual: ... / Nuevo: ... / Fuente: ..." → intencion_principal="corregir_dato_alumno", accion_correccion_alumno="confirmar" (si confirma) o "cancelar" (si cancela), modo_operacion_alumno="corregir" (una confirmación/cancelación SIEMPRE es parte del flujo de corrección, nunca de comparación — ver regla 22.2, que nunca genera una propuesta pendiente que se pueda confirmar). En este caso, extrae campo_alumno_corregir y valor_alumno_propuesto EXACTAMENTE de las líneas "Campo:"/"Nuevo:" de ese turno anterior del asistente — nunca del mensaje actual (que no trae esos datos) — y resuelve entidades_resueltas.alumno_id/alumno_nombre_detectado contra el nombre que aparece en la línea "Alumno:" de ese mismo turno anterior, buscándolo en alumnos_del_grupo_activo con el mismo criterio de la regla 9. Si el turno inmediato anterior del asistente NO es inequívocamente esa propuesta pendiente (formato exacto de arriba), NO uses accion_correccion_alumno="confirmar"/"cancelar" bajo ninguna circunstancia — usa "conversacion_general" en su lugar, nunca asumas que una respuesta breve confirma algo fuera de ese contexto exacto.
22.2. COMPARACIÓN/VERIFICACIÓN de un dato de alumno contra un valor que el docente proporciona, SIN pedir corregirlo todavía (ver "fallo: Chat IA ignoró la CURP externa a comparar y respondió como consulta simple"): distinta de 22 (que exige pedir corregir/cambiar/actualizar) — aquí el docente solo quiere comparar, revisar o verificar, incluso diciendo explícitamente que no corrija nada. Usa esta regla SOLO cuando el mensaje trae los CUATRO elementos siguientes a la vez — si falta cualquiera de ellos, NO la actives (ver más abajo qué hacer en ese caso):
   (a) un verbo o intención explícita de comparación/revisión/verificación/contraste — "compara", "comparar", "revisa si coincide", "revisar", "verifica", "verificar", "contrasta", "contrastar", "confirma si coincide", "¿es igual a...?", "¿coincide con...?" — una palabra suelta como "compara" SIN los otros tres elementos NUNCA es suficiente por sí sola;
   (b) un alumno identificable (mismo criterio de la regla 9);
   (c) el campo concreto — por ahora principalmente CURP, también sexo o fecha de nacimiento con el mismo criterio de la regla 21;
   (d) un VALOR concreto que el propio docente escribió para comparar contra el registrado — no basta con nombrar el campo, tiene que traer el valor literal (ej. la cadena de la CURP a comparar). EXCEPCIÓN — imagen adjunta como fuente del valor (ver "auditoría de solo lectura — pérdida de imagen antes de llegar al servidor" y el ajuste de clasificación que la sigue): esta excepción existe ÚNICAMENTE cuando imagen_adjunta_a_este_mensaje="sí" (el valor EXACTO del campo de CONTEXTO DE SESIÓN de arriba — nunca lo que el mensaje del docente diga o parezca implicar). VERIFICA ESE CAMPO PRIMERO, ANTES DE CUALQUIER OTRA COSA: si imagen_adjunta_a_este_mensaje="no", esta excepción NUNCA aplica bajo ninguna circunstancia, aunque el mensaje mencione explícitamente "esta imagen", "la foto" o cualquier palabra equivalente — esa mención en el texto NUNCA es evidencia de que la imagen realmente llegó (pudo perderse antes de llegar al servidor); en ese caso trata el mensaje EXACTAMENTE como si le faltara el valor (ver el párrafo siguiente: agrega "valor_alumno" a datos_faltantes) — nunca actives la excepción de imagen. Solo cuando imagen_adjunta_a_este_mensaje="sí" Y el mensaje deja claro que el valor a comparar debe leerse de esa imagen (ej. "compárala con la de esta imagen", "lee la CURP de la foto y compárala", "verifica si coincide con la que aparece en la imagen"), (d) se considera satisfecho por la imagen — es el ÚNICO caso donde (a)+(b)+(c) bastan sin un valor de texto — esta variante necesita que el modelo lea el valor real desde la imagen adjunta, algo que no se puede resolver de forma determinista como el resto de esta intención. valor_alumno_propuesto queda ausente (nunca la incluyas) (NUNCA lo inventes ni completes con lo que crees que dice la imagen — tú no la ves, solo clasificas texto) y NO agregues "valor_alumno" a datos_faltantes en este caso específico.
Si estos cuatro elementos están presentes (el texto literal, o la excepción de imagen de arriba) → intencion_principal="corregir_dato_alumno", accion_correccion_alumno="proponer", modo_operacion_alumno="comparar" — CRÍTICO: modo_operacion_alumno="comparar" (nunca "corregir") es la única señal que usa herramientasModulo.ts para garantizar que esta operación es estrictamente de SOLO LECTURA — jamás genera una propuesta confirmable ni el botón Corregir, sin importar si el valor proporcionado es válido/inválido o igual/distinto al registrado. El mismo sub-estado accion_correccion_alumno="proponer" que ya usa la regla 22 (consulta el valor real, valida su formato y compara; NUNCA escribe por sí mismo — la escritura solo puede ocurrir después, en un turno POSTERIOR y separado, si el docente confirma explícitamente, ver regla 22.1). Resuelve campo_alumno_corregir y valor_alumno_propuesto con el MISMO criterio exacto de la regla 22: el valor EXACTO tal como lo escribió el docente, carácter por carácter, sin completar, corregir, truncar, desplazar ni inferir ningún carácter que no haya escrito.
Si el mensaje trae la intención de comparar pero le falta el alumno, el campo, o el valor concreto a comparar, NO actives esta regla ni la 22 — usa el mismo mecanismo de datos_faltantes ya existente ("alumno" si falta el alumno, "campo_alumno" si falta el campo, "valor_alumno" si falta el valor) — nunca asumas ni completes lo que el docente no dio.
Frases como "no corrijas nada todavía", "no cambies nada", "sin corregir", "no lo apliques" NUNCA impiden que esta regla se active — al contrario, son exactamente la señal de que el docente quiere solo la comparación de solo lectura, que es exactamente lo que accion_correccion_alumno="proponer" ya garantiza (nunca escribe por sí solo).
DISTINGUE esto de la regla 21 (consultar_dato_alumno): la 21 es cuando el docente SOLO pregunta por el valor YA registrado, sin traer ningún valor propio para comparar. En cuanto el mensaje trae, además del alumno y el campo, un valor concreto del propio docente para comparar contra lo registrado, es esta regla (22.2), nunca la 21.
23. REVISIÓN INTERNA de posibles errores en los datos de los alumnos (ver "fallo: Chat IA niega poder editar datos de alumnos"): si el maestro pide revisar, checar o buscar posibles errores/inconsistencias en los datos de sus alumnos o de "la lista" SIN nombrar un alumno y un campo específicos con un valor nuevo (eso ya es la regla 22) → intencion_principal="revisar_datos_alumnos", entidades_resueltas.alumno_id=null. Ejemplos: "Revisa otros posibles errores", "Revisa otros posibles errores y corrige", "Revisa la lista", "Busca errores en los datos de mis alumnos", "Corrige la lista de la app", "Quiero que corrijas la lista, de la app", "¿Hay datos mal capturados en mi grupo?", "Checa que los datos de mis alumnos estén bien". Esta regla es SIEMPRE sobre los datos YA guardados dentro de la aplicación — NUNCA la uses, y usa "conversacion_general" en su lugar, si el mensaje menciona explícitamente RENAPO, "verificación oficial", "fuente oficial", "validar oficialmente" o cualquier equivalente que pida contrastar contra una fuente externa: eso NO es esta intención, es una pregunta que el chat debe responder con honestidad (no tiene acceso a RENAPO ni a ninguna fuente oficial de identidad), nunca confundirla con revisar los datos internos.
24. CAPACIDAD CONTEXTUAL (ver REFERENTES CONTEXTUALES DISPONIBLES en el contexto dinámico más abajo) — SOLO aplica cuando intencion_principal="conversacion_general" (si cualquiera de las reglas 1-23 ya aplicó, IGNORA esta regla por completo: NUNCA incluyas capacidad_contextual/referente_elegido_tipo/referente_elegido_id/confianza_contextual en ese caso — datos internos siempre ganan). Si hay al menos un referente en esa lista, evalúa si el mensaje actual pretende TRANSFORMAR o REUTILIZAR ese contenido reciente en vez de empezar algo nuevo sin relación con él:
   - "transformar_texto": pide modificar/reescribir un texto ya generado en la conversación (más corto, más formal, traducirlo, resumirlo, cambiar el tono, simplificarlo...) — el referente elegido debe ser tipo "texto" o "documento".
   - "generar_imagen": pide convertir ese contenido ya generado en una imagen/tarjeta/gráfico visual nuevo — referente tipo "texto" o "documento".
   - "editar_imagen": pide modificar una imagen YA generada (cambiar fondo, colores, agregar/quitar algo, tipografía) — referente tipo "imagen", solo tiene sentido si existe uno en la lista.
   - "convertir_documento": pide el archivo descargable (Word/PDF/PowerPoint/Excel) de contenido ya generado — referente tipo "texto" o "documento".
   Estas 4 capacidades expresan la MISMA intención de muchas formas naturales distintas — no busques una frase exacta, entiende el significado. Pero NO fuerces ninguna solo porque existan referentes disponibles: si el mensaje pide algo nuevo sin relación con el contenido reciente, o es charla/pregunta general (ej. "cuéntame una historia sobre dinosaurios", aunque exista un texto anterior en la conversación), NO incluyas capacidad_contextual — la sola existencia de un referente NUNCA implica que el maestro quiere reutilizarlo. Si hay ambigüedad real entre dos referentes posibles o entre dos capacidades, usa confianza_contextual="media" o "baja" en vez de forzar una elección para sonar seguro. referente_elegido_id SIEMPRE debe copiarse EXACTAMENTE de la lista de REFERENTES CONTEXTUALES DISPONIBLES — un id que no aparezca ahí, tal cual, se descarta por completo.`;

// Contexto de sesión + últimos turnos — la parte que sí cambia en
// cada request (grupo, alumnos, señal de imagen, historial
// reciente). Mismo texto/etiquetas exactos que ya usaba
// construirPrompt(), sin cambios.
function construirContextoDinamico(sesion: SesionContexto, historialReciente: TurnoReciente[], tieneImagenAdjunta: boolean, referentesContextuales: ReferenteContextualMetadata[]): string {
  return `CONTEXTO DE SESIÓN (dato, no lo inventes, úsalo tal cual):
grupo_activo_id: ${sesion.grupo_activo_id ?? 'ninguno'}
ciclo_escolar_id: ${sesion.ciclo_escolar_id ?? 'ninguno'}
alumnos_del_grupo_activo: ${JSON.stringify(sesion.alumnos_del_grupo_activo)}
imagen_adjunta_a_este_mensaje: ${tieneImagenAdjunta ? 'sí' : 'no'}

ÚLTIMOS TURNOS DE LA CONVERSACIÓN (solo para resolver confirmaciones de seguimiento, ver regla 13 — no lo uses para nada más):
${historialReciente.length > 0 ? historialReciente.map((t) => `${t.role === 'user' ? 'MAESTRO' : 'ASISTENTE'}: ${t.content}`).join('\n') : '(sin turnos previos)'}

REFERENTES CONTEXTUALES DISPONIBLES (ver regla 24 — SOLO relevantes si intencion_principal="conversacion_general"; metadata breve, nunca el contenido real):
${referentesContextuales.length > 0 ? referentesContextuales.map((r) => `- id=${r.id} tipo=${r.tipo} origen=${r.origen}${r.formato ? ` formato=${r.formato}` : ''}`).join('\n') : '(ninguno disponible en este turno)'}`;
}

// Reconstruye el contrato completo (ClasificacionNivel0) que
// route.ts/herramientasModulo.ts ya consumían antes de este cambio, a
// partir de la salida mínima real del modelo (ClasificacionModeloNivel0)
// — ver diseño "separar el contrato del modelo del contrato interno de
// la aplicación". Ningún consumidor existente cambia: reciben
// exactamente los mismos nulls/false/arrays vacíos que antes cuando un
// campo no aplica, y los mismos valores reales cuando sí aplica.
function normalizarClasificacionNivel0(modelo: ClasificacionModeloNivel0, tieneImagenAdjunta: boolean, referentesContextuales: ReferenteContextualMetadata[] = []): ClasificacionNivel0 {
  const nivelEjecucion = NIVEL_EJECUCION_POR_INTENCION[modelo.intencion_principal]
  // Verificado contra las 23 reglas: requiere_contexto_memoria siempre
  // coincide exactamente con nivel_ejecucion===4 (nunca hay un caso
  // donde diverjan) — nunca fue información independiente.
  const requiereContextoMemoria = nivelEjecucion === 4
  // requiere_ia=true cuando nivel_ejecucion es 3 o 4 en las 23 reglas
  // (nunca en nivel_ejecucion=1) — MÁS la única excepción histórica
  // real: regla 22.2 (comparación visual con imagen) pedía
  // explícitamente requiere_ia=true ahí, aunque nivel_ejecucion para
  // esa intención se normalice siempre a 1 (ver
  // NIVEL_EJECUCION_POR_INTENCION — decisión ya tomada, sin excepción,
  // porque route.ts protege ese caso de forma independiente con
  // esComparacionVisualDeAlumno, que este archivo NUNCA replica ni
  // depende de). Esta es una segunda comprobación, LOCAL a este campo
  // sin consumidores reales, que existe únicamente para que
  // requiere_ia conserve su semántica histórica mientras siga en el
  // contrato — si algún día esComparacionVisualDeAlumno cambia en
  // route.ts, esta línea no se entera y no tiene por qué: ninguna
  // decisión de enrutamiento depende de ella.
  const esExcepcionHistoricaImagenComparacion =
    tieneImagenAdjunta &&
    modelo.intencion_principal === 'corregir_dato_alumno' &&
    modelo.modo_operacion_alumno === 'comparar'
  const requiereIa = nivelEjecucion !== 1 || esExcepcionHistoricaImagenComparacion

  // Regla 11 original (retirada del prompt porque era exclusivamente
  // instrucción para el modelo sobre este cálculo, que ahora vive
  // aquí): true si el alumno quedó ambiguo, si se resolvió por
  // semejanza fonética (regla 9), o si sigue faltando el alumno/estado
  // de asistencia para una intención que los necesita.
  const requiereConfirmacion =
    modelo.entidades_resueltas.alumno_ambiguo ||
    !!modelo.alumno_resuelto_por_fonetica ||
    modelo.datos_faltantes.includes('alumno') ||
    (modelo.intencion_principal === 'marcar_asistencia_individual' && modelo.datos_faltantes.includes('estado_asistencia'))

  // FASE 2A — ver regla 24 y "regla obligatoria de prioridad: si
  // intencion_principal !== conversacion_general, capacidad_contextual/
  // referente_elegido/confianza_contextual = null". Se recalcula aquí,
  // en código, nunca confiando en que el modelo haya omitido los
  // campos correctamente — cualquier intención interna (1-23) fuerza
  // los 3 a null sin excepción, pase lo que pase en la salida cruda.
  let capacidadContextual: ClasificacionNivel0['capacidad_contextual'] = null
  let referenteElegido: ClasificacionNivel0['referente_elegido'] = null
  let confianzaContextual: ClasificacionNivel0['confianza_contextual'] = null
  if (modelo.intencion_principal === 'conversacion_general') {
    const capacidadValida =
      modelo.capacidad_contextual === 'transformar_texto' ||
      modelo.capacidad_contextual === 'generar_imagen' ||
      modelo.capacidad_contextual === 'editar_imagen' ||
      modelo.capacidad_contextual === 'convertir_documento'
    const confianzaValida = modelo.confianza_contextual === 'alta' || modelo.confianza_contextual === 'media' || modelo.confianza_contextual === 'baja'
    // "Nivel0 solamente puede elegir un id presente en
    // referentesContextuales... si devuelve un id inexistente,
    // normalizar a null. No aceptar referentes inventados por el
    // modelo." — comparación exacta de id Y tipo contra la lista real
    // que se le mandó, nunca contra lo que el modelo diga que es.
    const referenteReal = modelo.referente_elegido_id
      ? referentesContextuales.find((r) => r.id === modelo.referente_elegido_id && r.tipo === modelo.referente_elegido_tipo)
      : undefined
    // Los 3 campos son todo-o-nada: una capacidad sin un referente
    // real y válido no significa nada ejecutable, así que tampoco se
    // conserva sola.
    if (capacidadValida && confianzaValida && referenteReal) {
      capacidadContextual = modelo.capacidad_contextual!
      referenteElegido = { tipo: referenteReal.tipo, id: referenteReal.id }
      confianzaContextual = modelo.confianza_contextual!
    }
  }

  return {
    intencion_principal: modelo.intencion_principal,
    nivel_ejecucion: nivelEjecucion,
    requiere_ia: requiereIa,
    requiere_contexto_memoria: requiereContextoMemoria,
    entidades_resueltas: modelo.entidades_resueltas,
    estado_asistencia_solicitado: modelo.estado_asistencia_solicitado ?? null,
    pestana_lista: modelo.pestana_lista ?? null,
    filtro_lista: modelo.filtro_lista ?? null,
    nivel_detalle_asistencia_grupo: modelo.nivel_detalle_asistencia_grupo ?? null,
    campo_alumno_solicitado: modelo.campo_alumno_solicitado ?? null,
    accion_correccion_alumno: modelo.accion_correccion_alumno ?? null,
    modo_operacion_alumno: modelo.modo_operacion_alumno ?? null,
    campo_alumno_corregir: modelo.campo_alumno_corregir ?? null,
    valor_alumno_propuesto: modelo.valor_alumno_propuesto ?? null,
    categoria_asistencia_grupo: modelo.categoria_asistencia_grupo ?? null,
    grado_solicitado: modelo.grado_solicitado ?? null,
    grupo_solicitado: modelo.grupo_solicitado ?? null,
    tipo_incidencia: modelo.tipo_incidencia ?? null,
    descripcion_incidencia: modelo.descripcion_incidencia ?? null,
    tipo_consulta_planeacion: modelo.tipo_consulta_planeacion ?? null,
    periodo_planeacion_consulta: modelo.periodo_planeacion_consulta ?? null,
    estado_planeacion_consulta: modelo.estado_planeacion_consulta ?? null,
    nombre_planeacion_consulta: modelo.nombre_planeacion_consulta ?? null,
    tema_planeacion: modelo.tema_planeacion ?? null,
    fecha_inicio_planeacion: modelo.fecha_inicio_planeacion ?? null,
    fecha_fin_planeacion: modelo.fecha_fin_planeacion ?? null,
    duracion_dias_planeacion: modelo.duracion_dias_planeacion ?? null,
    duracion_semanas_planeacion: modelo.duracion_semanas_planeacion ?? null,
    momento_relativo_planeacion: modelo.momento_relativo_planeacion ?? null,
    accion_planeacion_generar: modelo.accion_planeacion_generar ?? null,
    datos_faltantes: modelo.datos_faltantes,
    nivel_confianza: modelo.nivel_confianza,
    requiere_confirmacion: requiereConfirmacion,
    // Reconstruido para conservar el mismo log de diagnóstico que ya
    // existía (route.ts:1158) sin pedirle al modelo un string libre —
    // ver "confirmación y match fonético".
    motivo_confirmacion: modelo.alumno_resuelto_por_fonetica ? 'nombre_fonetico' : null,
    requiere_consulta_oficial: modelo.requiere_consulta_oficial ?? false,
    capacidad_contextual: capacidadContextual,
    referente_elegido: referenteElegido,
    confianza_contextual: confianzaContextual,
  }
}

// Recuperación conservadora de robustez JSON — ver "JSON inválido en
// el baseline: prosa + JSON", caso real 27-alumno-ambiguo, donde
// Sonnet respondió correctamente en semántica pero antepuso una
// explicación en español antes del JSON, rompiendo JSON.parse
// directo. Recorre el texto carácter por carácter llevando
// profundidad de llaves y estado de string — NUNCA una regex ingenua
// tipo /\{.*\}/, que se rompe con objetos anidados, llaves dentro de
// strings o backslashes escapados. Devuelve el substring del ÚNICO
// objeto JSON top-level balanceado encontrado, o null si encuentra
// cero objetos, uno incompleto/truncado, o dos o más objetos
// top-level independientes — en ese último caso nunca elige uno
// arbitrariamente, la ambigüedad se resuelve siempre hacia FALLBACK
// en el llamador. No interpreta ni corrige semántica: solo localiza
// el envoltorio.
function extraerUnicoObjetoJsonTopLevel(texto: string): string | null {
  let dentroDeString = false
  let siguienteEscapado = false
  let profundidad = 0
  let inicio = -1
  const objetos: Array<{ inicio: number; fin: number }> = []

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]

    if (dentroDeString) {
      if (siguienteEscapado) {
        siguienteEscapado = false
      } else if (c === '\\') {
        siguienteEscapado = true
      } else if (c === '"') {
        dentroDeString = false
      }
      continue
    }

    if (c === '"') {
      dentroDeString = true
      continue
    }

    if (c === '{') {
      if (profundidad === 0) inicio = i
      profundidad++
      continue
    }

    if (c === '}') {
      if (profundidad > 0) {
        profundidad--
        if (profundidad === 0 && inicio !== -1) {
          objetos.push({ inicio, fin: i + 1 })
          inicio = -1
        }
      }
      continue
    }
  }

  if (objetos.length !== 1) return null
  // Endurecimiento — un objeto completo encontrado no basta: si al
  // terminar el recorrido queda evidencia estructural de OTRO objeto
  // top-level abierto pero nunca cerrado (profundidad>0 y/o inicio
  // sigue apuntando a ese segundo `{`), la política conservadora
  // exige rechazar en vez de devolver el primero — nunca asumir que
  // el fragmento incompleto es ruido inofensivo.
  if (profundidad !== 0 || inicio !== -1) return null
  return texto.slice(objetos[0].inicio, objetos[0].fin)
}

// Normalización EXCLUSIVA para los patrones deterministas de abajo —
// NO es normalizarNombre (lib/emparejarAlumno.ts): esta función es
// local a este archivo, no se usa para resolver alumnos, y no se
// reutiliza fuera de este propósito. Solo operaciones seguras: NFD +
// strip de diacríticos, minúsculas, quitar puntuación exterior
// (¿?¡!.,;:), colapsar espacios, trim. Nunca stemming, nunca
// tolerancia de palabras parciales.
function normalizarMensajeDeterminista(mensaje: string): string {
  return mensaje
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[¿?¡!.,;:]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Allowlist cerrada — FASE 1 del fast path determinista (ver
// "auditoría técnica y diseño — fast path determinista"). Match EXACTO
// de cadena completa tras normalizar, nunca coincidencia parcial ni
// "contiene la palabra". Cualquier variante no listada aquí,
// literalmente, cae a Sonnet sin excepción — incluida deliberadamente
// "¿Cuántas niñas y cuántos niños son?" (bug independiente, fuera de
// alcance de esta intervención).
const FRASES_CANTIDAD_TOTAL_ALUMNOS = new Set([
  'cuantos alumnos tengo',
  'cuantos alumnos hay',
  'cuantos alumnos son',
  'cuantos alumnos tengo en el grupo',
])

const FRASES_NAVEGAR_LISTA_FILTRADA: Record<string, NonNullable<ClasificacionNivel0['filtro_lista']>> = {
  'muestrame todos': 'todos',
  'ensename todos': 'todos',
  'ver todos': 'todos',
  'muestrame las ninas': 'ninas',
  'ensename las ninas': 'ninas',
  'ver las ninas': 'ninas',
  'muestrame los ninos': 'ninos',
  'ensename los ninos': 'ninos',
  'ver los ninos': 'ninos',
  'muestrame los presentes': 'presentes',
  'ensename los presentes': 'presentes',
  'ver los presentes': 'presentes',
  'muestrame los ausentes': 'ausentes',
  'ensename los ausentes': 'ausentes',
  'ver los ausentes': 'ausentes',
}

// Capa determinista ANTES de Anthropic — ver diseño "fast path
// determinista, microfase 1". SOLO clasifica (nunca resuelve alumnos,
// nunca escribe, nunca genera texto de respuesta) — construye el
// mismo contrato compacto que ya genera Sonnet
// (ClasificacionModeloNivel0) para que normalizarClasificacionNivel0
// derive nivel_ejecucion/requiere_ia/requiere_contexto_memoria/
// requiere_confirmacion exactamente con la misma lógica de siempre,
// sin duplicarla aquí. Devuelve null ante cualquier mensaje que no
// coincida EXACTAMENTE, carácter por carácter tras normalizar, con una
// de las frases de la allowlist — en ese caso el llamador continúa
// hacia Sonnet sin ninguna diferencia respecto al camino actual.
function intentarClasificacionDeterminista(mensaje: string): ClasificacionModeloNivel0 | null {
  const normalizado = normalizarMensajeDeterminista(mensaje)

  if (FRASES_CANTIDAD_TOTAL_ALUMNOS.has(normalizado)) {
    return {
      intencion_principal: 'consultar_asistencia_grupo',
      entidades_resueltas: { alumno_id: null, alumno_nombre_detectado: null, alumno_ambiguo: false, opciones_alumno_ambiguo: [] },
      datos_faltantes: [],
      nivel_confianza: 1,
      nivel_detalle_asistencia_grupo: 'cantidad',
      categoria_asistencia_grupo: 'total',
    }
  }

  const filtro = FRASES_NAVEGAR_LISTA_FILTRADA[normalizado]
  if (filtro) {
    return {
      intencion_principal: 'navegar_lista_filtrada',
      entidades_resueltas: { alumno_id: null, alumno_nombre_detectado: null, alumno_ambiguo: false, opciones_alumno_ambiguo: [] },
      datos_faltantes: [],
      nivel_confianza: 1,
      filtro_lista: filtro,
    }
  }

  return null
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
  historialReciente: TurnoReciente[] = [],
  // Ver "ajuste mínimo de clasificación para imagen adjunta" — el
  // clasificador es estrictamente de texto (nunca recibe la imagen en
  // sí), pero necesita saber SI existe una para la excepción de la
  // regla 22.2 (comparar un dato de alumno usando una imagen como
  // fuente del valor). false por default: cualquier llamada que no
  // pase este parámetro explícitamente conserva el comportamiento
  // exacto de siempre.
  tieneImagenAdjunta = false,
  // Ver "medición de usage real del Clasificador de Nivel 0". Expone el
  // usage exacto de ESTA llamada (respuesta.usage, ya presente en el
  // SDK) a quien llama, sin alterar la clasificación ni su contrato de
  // retorno — parámetro opcional, así que cualquier llamada existente
  // que no lo pase conserva el comportamiento exacto de siempre.
  // Deliberadamente un callback recibido por parámetro (no una
  // variable de módulo): en Fluid Compute la misma instancia puede
  // atender requests concurrentes, así que un estado compartido a
  // nivel de módulo mezclaría el usage de una petición con el de otra.
  onUsage?: (usage: Anthropic.Usage) => void,
  // FASE 2A (ver "contrato del router semántico unificado + transporte
  // de referentes contextuales") — metadata ligera del contenido
  // reciente reutilizable de la conversación (ver
  // lib/asistente/contextoConversacional.ts). Opcional y con default
  // []: cualquier llamada existente que no lo pase conserva el
  // comportamiento exacto de siempre (sin candidatos → capacidad_
  // contextual siempre null, ver normalizarClasificacionNivel0).
  referentesContextuales: ReferenteContextualMetadata[] = []
): Promise<ClasificacionNivel0> {
  // Fast path determinista — microfase 1 (ver "auditoría técnica y
  // diseño — fast path determinista"). Se comprueba ANTES de construir
  // o enviar cualquier petición a Anthropic: si hay match, la función
  // retorna aquí mismo y el bloque try/client.messages.create de abajo
  // nunca se ejecuta — cero llamada a Sonnet, cero tokens. onUsage
  // nunca se invoca en este camino (no hay Anthropic.Usage real que
  // reportar), consistente con que ya tolera ausencia de uso. Ningún
  // otro camino (Sonnet, parser tolerante, FALLBACK) cambia.
  const determinista = intentarClasificacionDeterminista(mensaje)
  if (determinista) {
    return normalizarClasificacionNivel0(determinista, tieneImagenAdjunta, referentesContextuales)
  }

  try {
    const respuesta = await client.messages.create(
      {
        model: 'claude-sonnet-4-6',
        // Antes en 500 — el JSON de salida ya no cabe siempre ahí con
        // los campos agregados por corregir_dato_alumno
        // (valor_alumno_propuesto puede traer un texto real, ej. una
        // CURP completa, sumado a todos los demás campos ya
        // existentes). Un JSON truncado a medio string rompía el
        // parseo y caía al FALLBACK silenciosamente — ver "el
        // clasificador real no reconoció la corrección de CURP".
        max_tokens: 700,
        // Prompt caching (ver diseño "separar prefijo estático
        // cacheable del clasificador de Nivel 0") — el bloque
        // estático (PROMPT_NIVEL0_ESTATICO, ~91% del prompt total) se
        // marca con cache_control para que Anthropic lo sirva desde
        // caché en llamadas subsecuentes dentro de la ventana de TTL;
        // el contexto dinámico va en un bloque separado, SIN
        // cache_control, después del breakpoint — nunca se cachea
        // (cambia en cada request). No cambia el contenido ni el
        // orden lógico de ninguna regla, solo cómo se transmite.
        system: [
          { type: 'text', text: PROMPT_NIVEL0_ESTATICO, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: construirContextoDinamico(sesion, historialReciente, tieneImagenAdjunta, referentesContextuales) },
        ],
        messages: [{ role: 'user', content: mensaje }],
      },
      { timeout: TIMEOUT_NIVEL0_MS }
    );
    onUsage?.(respuesta.usage)

    const bloque = respuesta.content.find((b) => b.type === 'text');
    if (!bloque || bloque.type !== 'text') return FALLBACK;

    const limpio = bloque.text.replace(/```json|```/g, '').trim();

    // Camino normal: JSON.parse directo, igual que siempre. Si falla
    // (ver "JSON inválido en el baseline: prosa + JSON"), se intenta
    // UNA recuperación conservadora — localizar el único objeto JSON
    // top-level balanceado dentro del texto (extraerUnicoObjetoJsonTopLevel).
    // Si esa recuperación no encuentra exactamente un objeto (cero,
    // truncado, o dos o más ambiguos), se relanza el error ORIGINAL de
    // JSON.parse — mismo camino de siempre hacia el catch/FALLBACK de
    // abajo, mismo log, sin logging nuevo. Si el objeto recuperado
    // tampoco parsea, su propio SyntaxError sube igual al mismo catch.
    // Ninguna de las dos rutas corrige semántica: solo arregla el
    // envoltorio antes de entrar a la validación normal de abajo.
    let parsedModelo: ClasificacionModeloNivel0;
    try {
      parsedModelo = JSON.parse(limpio) as ClasificacionModeloNivel0;
    } catch (errorParseoDirecto) {
      const extraido = extraerUnicoObjetoJsonTopLevel(limpio);
      if (extraido === null) throw errorParseoDirecto;
      parsedModelo = JSON.parse(extraido) as ClasificacionModeloNivel0;
    }

    // Validación mínima de forma sobre la salida CRUDA del modelo —
    // antes de normalizar, mismo criterio de siempre (no confiar
    // ciegamente en el JSON), actualizada a los 4 campos que el
    // modelo sigue generando siempre (ver ClasificacionModeloNivel0).
    // nivel_ejecucion ya no es parte de esa salida cruda — se deriva
    // en normalizarClasificacionNivel0, nunca se valida aquí.
    if (
      !parsedModelo.intencion_principal ||
      !parsedModelo.entidades_resueltas ||
      typeof parsedModelo.nivel_confianza !== 'number'
    ) {
      return FALLBACK;
    }

    return normalizarClasificacionNivel0(parsedModelo, tieneImagenAdjunta, referentesContextuales);
  } catch (e) {
    console.error('Error en Clasificador de Nivel 0, usando fallback:', e);
    return FALLBACK;
  }
}
