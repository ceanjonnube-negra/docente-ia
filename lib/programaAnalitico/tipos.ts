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

// ============================================================
// PA-3B — generador de propuesta (no publica).
// ============================================================

// Único caso real hoy: el catálogo curricular cerrado quedó vacío
// (no debería ocurrir si resolverContextoCurricularGrupo ya validó
// cobertura, pero se cubre por si acaso). Deliberadamente NO incluye
// nada relacionado a diagnóstico/contexto comunitario — esos son
// siempre opcionales, nunca bloquean la generación (ver informe PA-3B §7).
export type FaltanteInformacionGeneracion = 'CATALOGO_CURRICULAR_VACIO'

export type DiagnosticoPropuestaIaInvalida =
  | ErrorValidacionPropuesta
  | { tipo: 'JSON_INVALIDO' }
  | { tipo: 'FORMA_INESPERADA' }
  | { tipo: 'DELTA_CONTENIDO_DUPLICADO'; curriculoContenidoId: string }
  | { tipo: 'DELTA_CONTENIDO_NO_ENCONTRADO_EN_BASE'; curriculoContenidoId: string }

// PA-3B1 — categorías concretas de contexto pedagógico que, de existir,
// permitirían codiseño real (contextualizar/agregar contenido nuevo)
// en vez de publicar la base oficial tal cual. Reportadas TODAS juntas
// cuando se dispara requiereContexto (no hay forma de distinguir cuál
// en particular falta cuando ninguna está presente).
export type CategoriaContextoPedagogico =
  | 'CARACTERISTICAS_GRUPO'
  | 'NECESIDADES_PRIORIDADES'
  | 'PROBLEMATICA_COMUNIDAD'
  | 'INTERESES'
  | 'RECURSOS'
  | 'PRIORIDADES_PEDAGOGICAS'

export type ObservabilidadGeneracion = {
  requestId: string
  grupoId: string
  modelo: string
  cantidadCandidatosContenido: number
  cantidadCandidatosPda: number
  cantidadItemsPropuestos: number
  duracionMs: number
  tokensEntrada?: number
  tokensSalida?: number
  exito: boolean
}

export type ResultadoGenerarPropuesta =
  | { ok: true; propuesta: PropuestaProgramaAnalitico; observabilidad: ObservabilidadGeneracion }
  | { ok: false; requiereContexto: true; categorias: CategoriaContextoPedagogico[] }
  | { ok: false; requiereInformacion: true; faltantes: FaltanteInformacionGeneracion[] }
  | { ok: false; error: { tipo: 'CONTEXTO_CURRICULAR_NO_RESUELTO'; detalle: string } }
  | { ok: false; error: { tipo: 'PROPUESTA_IA_INVALIDA'; diagnostico: DiagnosticoPropuestaIaInvalida } }
  | { ok: false; error: { tipo: 'ERROR_GENERACION'; mensaje: string } }
