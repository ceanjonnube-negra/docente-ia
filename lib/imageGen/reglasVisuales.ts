// lib/imageGen/reglasVisuales.ts
//
// Reglas pedagógicas fijas para cualquier imagen que genere Docente IA
// (ver diseño técnico aprobado: "Implementar en Docente IA la capacidad
// de generar imágenes y documentos ilustrados"). Puras, sin red, sin
// estado — el prompt final SIEMPRE pasa por aquí antes de llegar al
// proveedor, nunca se manda el texto crudo del maestro o de Claude sin
// envolver: el criterio pedagógico/de seguridad no puede depender de
// que Claude lo recuerde mencionar cada vez.

export type EstiloVisual =
  | 'infantil'
  | 'limpio'
  | 'imprimible'
  | 'alto-contraste'
  | 'didactico'
  | 'profesional-docente'
  | 'minimalista'
  | 'ilustrado-amigable'
  // FASE 4 — "mejora de calidad visual de imágenes escolares": preset
  // específico para carteles/avisos (nunca para ilustraciones sueltas
  // de documento, ver ESTILO_CARTEL_POR_DEFECTO más abajo) — busca
  // composición de pieza gráfica real, no una ilustración simple.
  | 'escolar_cartel_premium'

export const ESTILO_POR_DEFECTO: EstiloVisual = 'ilustrado-amigable'

// Estilo por defecto SOLO para carteles/avisos escolares (ver
// construirPromptCartelEscolar) — nunca afecta ESTILO_POR_DEFECTO, que
// sigue siendo el default de siempre para ilustraciones de documento.
export const ESTILO_CARTEL_POR_DEFECTO: EstiloVisual = 'escolar_cartel_premium'

const DESCRIPCION_ESTILO: Record<EstiloVisual, string> = {
  'infantil': 'estilo infantil, colores cálidos y amigables, formas simples y redondeadas',
  'limpio': 'diseño limpio, ordenado, sin elementos innecesarios',
  'imprimible': 'optimizado para imprimir: fondo claro, líneas definidas, buen contraste sobre papel',
  'alto-contraste': 'alto contraste, colores bien diferenciados, fácil de distinguir a distancia',
  'didactico': 'estilo didáctico y explicativo, claro para que niñas y niños de educación básica lo entiendan',
  'profesional-docente': 'estilo profesional y sobrio, apropiado para un documento institucional escolar',
  'minimalista': 'minimalista, pocos elementos, composición sencilla',
  'ilustrado-amigable': 'ilustración amigable estilo libro de texto escolar, colores agradables, sin recargar',
  'escolar_cartel_premium': 'ilustración limpia y atractiva con composición moderna de pieza gráfica profesional, jerarquía visual muy clara, colores amigables y a la vez profesionales, ambiente escolar reconocible, estética llamativa pero ordenada — apariencia de cartel bien diseñado, nunca de boceto simple o genérico; poco ruido visual, márgenes limpios, bloques de contenido bien acomodados y alineados',
}

// Restricción de impresión — nunca decidida por el proveedor de
// imágenes ni por Claude: siempre viene de la instrucción explícita
// del maestro o del valor por defecto, para que un material pensado
// para imprimir en blanco y negro nunca salga saturado de color.
export type RestriccionImpresion = 'color' | 'ahorro-tinta' | 'blanco-y-negro'

const DESCRIPCION_RESTRICCION: Record<RestriccionImpresion, string> = {
  'color': '',
  'ahorro-tinta': 'usa colores moderados, evita fondos sólidos grandes de color para ahorrar tinta al imprimir',
  'blanco-y-negro': 'imagen en blanco y negro o escala de grises, con líneas claras para colorear o imprimir sin color',
}

// Reglas fijas de seguridad/pertinencia — SIEMPRE presentes, sin
// excepción, nunca opcionales ni removibles por el prompt del maestro
// (ver ALCANCE FUNCIONAL / REGLAS DE GENERACIÓN VISUAL EDUCATIVA del
// diseño aprobado).
const REGLAS_FIJAS =
  'Contexto: educación básica en México (preescolar, primaria o secundaria). ' +
  'La imagen debe ser apropiada para niñas, niños y adolescentes: sin violencia, sin contenido sexual, ' +
  'sin texto ilegible ni marcas de agua, sin logotipos de marcas reales, sin caricaturas de personajes con derechos de autor. ' +
  'Debe ser clara, comprensible y visualmente limpia — pensada para material educativo real, no arte abstracto.'

// FASE 2 — "inferencia determinista de tipo de pieza": tipo de pieza
// visual escolar, inferido SOLO por palabras clave del mensaje real
// del docente (nunca de una llamada a IA nueva, ver
// inferirTipoPieza). Cuando está presente en SolicitudImagen,
// construirPromptFinal cambia de la prosa libre de siempre a un
// prompt estructurado por secciones (ver construirPromptCartelEscolar)
// — ausente (undefined) preserva EXACTAMENTE el camino de hoy, el que
// usan las ilustraciones sueltas de documento (ver
// generarImagenesParaDocumento en lib/documentGen/herramientas.ts,
// que nunca lo llena).
export type TipoPiezaVisual =
  | 'reunion_escolar'
  | 'regreso_clases'
  | 'aviso_escolar'
  | 'aviso_pago_escolar'
  | 'convocatoria_escolar'
  | 'cartel_escolar_general'

const DESCRIPCION_TIPO_PIEZA: Record<TipoPiezaVisual, string> = {
  reunion_escolar: 'Convocatoria/aviso de reunión escolar con madres y padres de familia',
  regreso_clases: 'Aviso de regreso o inicio a clases',
  aviso_escolar: 'Aviso o comunicado escolar general',
  aviso_pago_escolar: 'Aviso de pago, cuota o jornada escolar con fechas de pago',
  convocatoria_escolar: 'Convocatoria o invitación escolar (inscripción, evento, actividad)',
  cartel_escolar_general: 'Cartel o aviso escolar general',
}

// Quita acentos/diacríticos y pasa a minúsculas — mismo criterio que
// normalizarMensajeDeterminista (lib/clasificadorNivel0.ts): permite
// que "reunión"/"Reunión"/"REUNION" matcheen igual sin depender de
// una lista cerrada de variantes.
function normalizarParaInferencia(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

// Orden de evaluación es la prioridad real cuando el mensaje menciona
// más de una palabra clave a la vez (ej. "reunión para tratar el pago
// de la cuota" -> se queda con reunion_escolar, el propósito principal
// del mensaje). Determinista y pura — nunca IA, nunca red.
export function inferirTipoPieza(textoDocente: string): TipoPiezaVisual {
  const t = normalizarParaInferencia(textoDocente)
  if (/\breunion(es)?\b/.test(t)) return 'reunion_escolar'
  if (/\b(regreso a clases|regreso a clase|inicio (a|de) clases|primer dia de clases)\b/.test(t)) return 'regreso_clases'
  if (/\b(pago|pagos|colegiatura|colegiaturas|cuota|cuotas|jornada ampliada)\b/.test(t)) return 'aviso_pago_escolar'
  if (/\b(convocatoria|inscripcion(es)?)\b/.test(t)) return 'convocatoria_escolar'
  if (/\b(aviso|atento aviso|comunicado|circular)\b/.test(t)) return 'aviso_escolar'
  return 'cartel_escolar_general'
}

// FASE 3 — "formato por defecto": todo tipoPieza de cartel/aviso
// escolar prefiere vertical tipo póster por defecto — un solo lugar
// documentado si en el futuro algún tipoPieza específico necesita otra
// proporción (ver "dejar cuadrado solo cuando el tipo de pieza
// claramente lo justifique" — hoy ningún caso lo justifica).
export function formatoPorDefectoParaTipoPieza(_tipoPieza: TipoPiezaVisual): SolicitudImagen['formato'] {
  return 'vertical'
}

export type SolicitudImagen = {
  prompt: string
  estilo?: EstiloVisual
  tema?: string
  nivelEscolar?: string
  restriccionImpresion?: RestriccionImpresion
  // 'cuadrado' es el default: funciona bien tanto suelto en el chat
  // como embebido en un documento vertical (Word/PDF, ver Fase 2).
  formato?: 'cuadrado' | 'horizontal' | 'vertical'
  // Aditivo — ver TipoPiezaVisual arriba. Ausente = comportamiento
  // idéntico a como funcionaba este archivo antes de esta fase.
  tipoPieza?: TipoPiezaVisual
  // FASE 6 — "parámetros del proveedor": calidad explícita, opcional.
  // Cuando el llamador no la especifica, ImageGenerationService decide
  // el default (ver CALIDAD_CARTEL_ESCOLAR) — nunca este archivo, que
  // se mantiene puro/sin conocer al proveedor.
  calidad?: 'medium' | 'high'
}

// FASE 1/5 — "mejora del prompt builder" / "jerarquía visual": prompt
// estructurado por secciones explícitas para carteles/avisos
// escolares, en vez de la prosa libre de siempre. solicitud.prompt
// (la descripción visual ya redactada por Claude, ver MODO IMAGEN en
// route.ts) se coloca como el CONTENIDO real dentro de la sección
// correspondiente — nunca se pierde ni se resume, solo se envuelve
// con instrucciones de composición/jerarquía/estilo que hoy no
// existían. Determinista y pura, igual que construirPromptFinal.
function construirPromptCartelEscolar(solicitud: SolicitudImagen, tipoPieza: TipoPiezaVisual): string {
  const estilo = solicitud.estilo ?? ESTILO_CARTEL_POR_DEFECTO
  const secciones = [
    `TIPO DE PIEZA: ${DESCRIPCION_TIPO_PIEZA[tipoPieza]}.`,
    'OBJETIVO VISUAL: comunicar la información de forma clara e inmediata a quien la vea (madre, padre de familia o docente), con apariencia de pieza gráfica profesional real — nunca una imagen improvisada o genérica.',
    'FORMATO Y COMPOSICIÓN: cartel vertical tipo póster escolar. Composición limpia, llamativa y bien organizada, con bloques de contenido separados y bien alineados — nunca todo el contenido disperso o distribuido de forma plana sin estructura.',
    `ESTILO VISUAL: ${DESCRIPCION_ESTILO[estilo]}.`,
    'JERARQUÍA TIPOGRÁFICA: título principal grande y muy legible, dominante en la composición; la fecha debe ser el segundo elemento más destacado, en tamaño grande y bien visible; hora y lugar en una zona clara del cartel, legibles pero secundarios frente al título y la fecha; si hay texto de cuerpo adicional, debe ser breve, corto y con tipografía legible — nunca amontonado ni diminuto.',
    `INFORMACIÓN Y TEXTO CLAVE A REPRESENTAR: ${solicitud.prompt.trim()}`,
    'ELEMENTOS DECORATIVOS: iconografía o ilustraciones escolares relacionadas con el tipo de aviso (según corresponda: personas en un salón de clases, calendario, mochila, útiles escolares, campana escolar, edificio escolar...) como acento visual — nunca deben opacar ni competir con el texto principal.',
    'RESTRICCIONES VISUALES: evitar apariencia genérica, improvisada o de boceto simple; evitar saturación de elementos o de colores distintos; evitar texto demasiado pequeño o ilegible; evitar distribución plana sin jerarquía visual; mantener márgenes limpios; paleta de colores escolar, alegre y profesional a la vez, sin exceso de colores.',
  ]
  const partes = [
    secciones.join('\n'),
    solicitud.tema ? `Tema adicional: ${solicitud.tema}.` : '',
    solicitud.nivelEscolar ? `Nivel escolar: ${solicitud.nivelEscolar}.` : '',
    solicitud.restriccionImpresion ? DESCRIPCION_RESTRICCION[solicitud.restriccionImpresion] : '',
    REGLAS_FIJAS,
  ].filter((p) => p && p.length > 0)
  return partes.join('\n\n')
}

// Único punto que decide el texto REAL que recibe el proveedor —
// nunca se manda solicitud.prompt tal cual. Determinista y pura: el
// mismo SolicitudImagen siempre produce el mismo prompt final.
export function construirPromptFinal(solicitud: SolicitudImagen): string {
  // FASE 1/2 — solo entra aquí cuando el llamador SÍ identificó un
  // tipoPieza real (ver inferirTipoPieza) — las ilustraciones sueltas
  // de documento (generarImagenesParaDocumento) nunca lo llenan, así
  // que siguen cayendo, sin ningún cambio, en el camino de abajo.
  if (solicitud.tipoPieza) return construirPromptCartelEscolar(solicitud, solicitud.tipoPieza)

  const estilo = solicitud.estilo ?? ESTILO_POR_DEFECTO
  const partes = [
    solicitud.prompt.trim(),
    solicitud.tema ? `Tema: ${solicitud.tema}.` : '',
    solicitud.nivelEscolar ? `Nivel escolar: ${solicitud.nivelEscolar}.` : '',
    DESCRIPCION_ESTILO[estilo] + '.',
    solicitud.restriccionImpresion ? DESCRIPCION_RESTRICCION[solicitud.restriccionImpresion] : '',
    REGLAS_FIJAS,
  ].filter((p) => p && p.length > 0)
  return partes.join(' ')
}

export function tamanoParaFormato(formato: SolicitudImagen['formato']): '1024x1024' | '1536x1024' | '1024x1536' {
  if (formato === 'horizontal') return '1536x1024'
  if (formato === 'vertical') return '1024x1536'
  return '1024x1024'
}

const REGLAS_FIJAS_PARA_EDICION =
  'Apropiada para educación básica en México: sin violencia, sin contenido sexual, sin texto ilegible, sin marcas de agua, sin logotipos de marcas reales.'

// Prompt de EDICIÓN (ver "corrección — edición real de imágenes con el
// asset visual anterior como entrada"): a diferencia de
// construirPromptFinal (genera desde cero), aquí la imagen original YA
// viaja como entrada visual real al proveedor — este prompt nunca
// vuelve a describir la escena completa, solo dice QUÉ cambiar y
// ordena EXPLÍCITAMENTE conservar todo lo demás. Sin esta instrucción
// explícita, el modelo puede reinterpretar libremente lo que el
// maestro no mencionó.
export function construirPromptEdicionImagen(instruccion: string): string {
  return `Edita esta imagen exacta siguiendo esta instrucción: ${instruccion.trim()}. Conserva la MISMA composición, encuadre, elementos principales, su posición relativa y las proporciones generales de la imagen original — cambia ÚNICAMENTE lo que la instrucción pide, nunca reinterpretes ni rediseñes la escena desde cero. ${REGLAS_FIJAS_PARA_EDICION}`
}
