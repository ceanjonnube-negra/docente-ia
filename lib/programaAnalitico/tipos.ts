// lib/programaAnalitico/tipos.ts
//
// Contrato de entrada del publicador (PA-3A). Deliberadamente NO
// incluye curriculo_version_id / curriculo_fase_id / curriculo_grado_id
// / docente_id / institucion_id / ciclo_escolar_id — la propuesta
// (futura IA o prueba manual) nunca puede autodeclarar su contexto
// curricular; eso se resuelve server-side vía
// resolverContextoCurricularGrupo() (lib/curriculo/resolverContextoCurricularGrupo.ts).

export type TipoDecisionItem = 'sin_ajuste' | 'contextualizado' | 'nuevo'

export type ItemPropuestaProgramaAnalitico = {
  // Identificador solo para que el llamador (IA/prueba) pueda
  // referirse a este item en mensajes de error — nunca se persiste.
  claveLocal: string
  tipoDecision: TipoDecisionItem

  curriculoContenidoId?: string | null

  textoContextualizado?: string | null
  textoLocal?: string | null
  resultadoEsperadoLocal?: string | null

  periodoEvaluacionId?: string | null

  orden: number

  curriculoPdaGradoIds: string[]
}

export type PropuestaProgramaAnalitico = {
  grupoId: string
  // Identidad de operación estable para idempotencia — una repetición
  // exacta (mismo docente + misma key) devuelve el resultado anterior
  // sin crear otra versión. Generarla del lado que inicia la
  // operación (cliente o IA) y persistirla junto con el intento antes
  // de reintentar por red.
  idempotencyKey: string
  contextoNotas?: string | null
  items: ItemPropuestaProgramaAnalitico[]
}

export type ErrorValidacionPropuesta =
  | { tipo: 'GRUPO_SIN_ID' }
  | { tipo: 'IDEMPOTENCY_KEY_VACIA' }
  | { tipo: 'PROPUESTA_SIN_ITEMS' }
  | { tipo: 'CONTEXTO_NOTAS_VACIO' }
  | { tipo: 'ORDEN_DUPLICADO'; orden: number }
  | { tipo: 'ITEM_TIPO_DECISION_INVALIDO'; claveLocal: string }
  | { tipo: 'ITEM_SIN_AJUSTE_CONTENIDO_FALTANTE'; claveLocal: string }
  | { tipo: 'ITEM_SIN_AJUSTE_TEXTO_NO_PERMITIDO'; claveLocal: string }
  | { tipo: 'ITEM_CONTEXTUALIZADO_CONTENIDO_FALTANTE'; claveLocal: string }
  | { tipo: 'ITEM_CONTEXTUALIZADO_TEXTO_VACIO'; claveLocal: string }
  | { tipo: 'ITEM_CONTEXTUALIZADO_TEXTO_LOCAL_NO_PERMITIDO'; claveLocal: string }
  | { tipo: 'ITEM_NUEVO_CONTENIDO_NO_PERMITIDO'; claveLocal: string }
  | { tipo: 'ITEM_NUEVO_TEXTO_VACIO'; claveLocal: string }
  | { tipo: 'ITEM_NUEVO_CON_PDA'; claveLocal: string }
  | { tipo: 'ITEM_RESULTADO_ESPERADO_NO_PERMITIDO'; claveLocal: string }
  | { tipo: 'ITEM_RESULTADO_ESPERADO_VACIO'; claveLocal: string }
  | { tipo: 'ITEM_ORDEN_INVALIDO'; claveLocal: string }
  | { tipo: 'CONTENIDO_NO_PERTENECE_AL_CONTEXTO'; claveLocal: string }
  | { tipo: 'CONTENIDO_SIN_COBERTURA'; claveLocal: string }
  | { tipo: 'PDA_NO_ENCONTRADO'; claveLocal: string; curriculoPdaGradoId: string }
  | { tipo: 'PDA_NO_PERTENECE_AL_ITEM'; claveLocal: string; curriculoPdaGradoId: string }
  | { tipo: 'PERIODO_NO_ENCONTRADO'; claveLocal: string; periodoEvaluacionId: string }
  | { tipo: 'PERIODO_DE_OTRO_CICLO'; claveLocal: string; periodoEvaluacionId: string }

export type ResultadoPublicacion = {
  programaAnaliticoId: string
  programaAnaliticoVersionId: string
  numeroVersion: number
  reutilizadaPorIdempotencia: boolean
}

export type ResultadoPublicarProgramaAnalitico =
  | { ok: true; resultado: ResultadoPublicacion }
  | { ok: false; error: ErrorValidacionPropuesta | { tipo: 'CONTEXTO_CURRICULAR_NO_RESUELTO'; detalle: string } | { tipo: 'ERROR_PUBLICACION'; mensaje: string } }
