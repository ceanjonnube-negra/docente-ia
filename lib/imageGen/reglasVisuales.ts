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

export const ESTILO_POR_DEFECTO: EstiloVisual = 'ilustrado-amigable'

const DESCRIPCION_ESTILO: Record<EstiloVisual, string> = {
  'infantil': 'estilo infantil, colores cálidos y amigables, formas simples y redondeadas',
  'limpio': 'diseño limpio, ordenado, sin elementos innecesarios',
  'imprimible': 'optimizado para imprimir: fondo claro, líneas definidas, buen contraste sobre papel',
  'alto-contraste': 'alto contraste, colores bien diferenciados, fácil de distinguir a distancia',
  'didactico': 'estilo didáctico y explicativo, claro para que niñas y niños de educación básica lo entiendan',
  'profesional-docente': 'estilo profesional y sobrio, apropiado para un documento institucional escolar',
  'minimalista': 'minimalista, pocos elementos, composición sencilla',
  'ilustrado-amigable': 'ilustración amigable estilo libro de texto escolar, colores agradables, sin recargar',
}

// "dos modos visuales reales" — reemplaza al preset único
// 'escolar_cartel_premium' de la fase anterior (nunca usado fuera de
// este archivo, confirmado por auditoría — se retira sin dejar
// residuo). Un cartel de reunión/pago/convocatoria no debe verse igual
// que uno de bienvenida/regreso a clases — ver inferirModoVisual.
export type ModoVisualPieza = 'escolar_alegre' | 'institucional_limpio'

const DESCRIPCION_MODO_VISUAL: Record<ModoVisualPieza, string> = {
  escolar_alegre: 'ilustración colorida, cálida y amigable — estética atractiva para preescolar/primaria, colores vivos pero armónicos (nunca estridentes), formas amigables, ambiente festivo y de bienvenida, sin perder orden ni jerarquía visual; apariencia de cartel escolar alegre bien diseñado, nunca de boceto genérico.',
  institucional_limpio: 'diseño limpio, profesional y sobrio — apropiado para un comunicado institucional escolar, paleta de colores reducida y elegante, composición ordenada y formal, énfasis total en la claridad del mensaje sobre la decoración; apariencia de aviso oficial bien diseñado, nunca de cartel infantil ni de boceto genérico.',
}

// Default conservador cuando no hay señal suficiente para decidir
// (ver inferirModoVisual) — un aviso institucional mal etiquetado como
// alegre se ve peor (infantilizado) que uno alegre mal etiquetado como
// institucional (solo se ve algo más sobrio de lo ideal); por eso el
// default es el más seguro de los dos.
const MODO_VISUAL_POR_DEFECTO: ModoVisualPieza = 'institucional_limpio'

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

// "dos modos visuales reales" — determinista, sin llamada a IA
// adicional (mismo criterio que inferirTipoPieza). Prioridad: (1)
// palabras festivas/de bienvenida explícitas en el mensaje ganan
// siempre, sin importar tipoPieza (ej. "fiesta de bienvenida para el
// regreso a clases" sigue siendo alegre, pero también "convivio de fin
// de cursos" aunque tipoPieza caiga en el fallback general); (2) si no
// hay señal festiva, regreso_clases es el único tipoPieza que por
// naturaleza es más alegre/bienvenida; (3) cualquier otro caso —
// reunión, pago, convocatoria, aviso general — cae en el default
// conservador institucional_limpio (ver MODO_VISUAL_POR_DEFECTO).
const PALABRAS_ALEGRE = /\b(bienvenida|bienvenidos|fiesta|festejo|festival|celebracion(es)?|celebrar|convivio|feria)\b/

export function inferirModoVisual(tipoPieza: TipoPiezaVisual, textoDocente: string): ModoVisualPieza {
  const t = normalizarParaInferencia(textoDocente)
  if (PALABRAS_ALEGRE.test(t)) return 'escolar_alegre'
  if (tipoPieza === 'regreso_clases') return 'escolar_alegre'
  return MODO_VISUAL_POR_DEFECTO
}

// "no inventar datos" — campos explícitos que SÍ se pueden extraer de
// forma determinista y confiable del mensaje real del docente, con
// evidencia razonable de precisión (fecha/hora/costo tienen patrones
// de escritura en español acotados; lugar es más abierto, por eso es
// "mejor esfuerzo" — ver comentario en REGEX_LUGAR). destinatario y
// nombreEvento se evaluaron y se dejaron FUERA a propósito: su
// fraseo es demasiado abierto para un patrón confiable sin arriesgar
// capturas incorrectas — más vale omitir que inventar con falsa
// confianza (mismo criterio conservador que pide esta tarea).
export type DatosExplicitosPieza = {
  fecha?: string
  hora?: string
  lugar?: string
  costo?: string
}

const MESES = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre'
// Cubre "31 de agosto", "1 y 2 de septiembre", "24 al 28 de agosto" —
// los 3 patrones reales de los casos de referencia de esta tarea.
const REGEX_FECHA = new RegExp(`\\b(\\d{1,2}\\s*(?:y|al)?\\s*(?:\\d{1,2}\\s*)?de\\s+(?:${MESES}))\\b`, 'i')
// "8:00 a.m.", "8:00am", "14:00 hrs", "8 pm", "8:00 horas".
// Sin \b final a propósito: "a.m."/"p.m." terminan en punto (no es
// carácter de palabra), así que un \b justo después nunca hace match
// — se confía en que cada alternativa ya delimita su propio final.
const REGEX_HORA = /\b(\d{1,2}(:\d{2})?\s*(?:a\.?\s?m\.?|p\.?\s?m\.?|hrs?\.?|horas))/i
// "$150", "$1,200.00", "150 pesos".
const REGEX_COSTO = /(\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*\s*pesos\b)/i
// Mejor esfuerzo, no perfecto: captura la frase después de "en el/la/
// los/las" hasta la siguiente puntuación, acotada a 40 caracteres para
// no arrastrar el resto de la oración si no hay puntuación cercana. Un
// acierto parcial (capturar de más/de menos) es un problema de calidad
// visual menor — nunca inventa un lugar que no esté en el texto real.
const REGEX_LUGAR = /\ben\s+(?:el|la|los|las)\s+([a-zA-ZáéíóúñÁÉÍÓÚÑ0-9][a-zA-ZáéíóúñÁÉÍÓÚÑ0-9\s]{2,40}?)(?=[.,;]|$)/

export function extraerDatosExplicitosPieza(textoDocente: string): DatosExplicitosPieza {
  const datos: DatosExplicitosPieza = {}
  const fecha = textoDocente.match(REGEX_FECHA)
  if (fecha) datos.fecha = fecha[1].trim()
  const hora = textoDocente.match(REGEX_HORA)
  if (hora) datos.hora = hora[1].trim()
  const costo = textoDocente.match(REGEX_COSTO)
  if (costo) datos.costo = costo[1].trim()
  const lugar = textoDocente.match(REGEX_LUGAR)
  if (lugar) datos.lugar = lugar[1].trim()
  return datos
}

// "optimización inteligente de costo/calidad" — determinista, sin
// llamada a IA adicional. CORRECCIÓN — se retiró el disparador
// genérico de "regeneración/insatisfacción" ("no me gustó", "hazla de
// nuevo", "otra vez"...): si al maestro no le gustó el color, la
// composición o el estilo, quality:'high' no resuelve eso — solo
// encarece la siguiente generación sin garantizar que mejore lo que
// en realidad se quería cambiar. 'high' ahora sube ÚNICAMENTE con una
// señal explícita relacionada con calidad/impresión/nitidez —
// "hazla de nuevo"/"cambia los colores"/"hazla más formal"/"quiero
// otra opción" se quedan en 'medium', que es donde deben quedarse.
// Cualquier otro caso se queda en 'medium' — ver CALIDAD_CARTEL_ESCOLAR
// en ImageGenerationService.ts, que sigue siendo el default cuando
// quien llama no puede calcular esta decisión (ej. sin
// mensajeOriginalDocente). datosExplicitos se conserva en la firma
// (sin usarse en el cuerpo) para no romper el wiring existente en
// herramientas.ts ni obligar a tocar ese archivo en esta corrección.
// CORRECCIÓN — "mas profesional" retirado a propósito: es una
// petición de estilo/composición ("hazla más profesional/formal/
// elegante"), no de calidad técnica — debe resolverse con prompt/
// estilo en 'medium', nunca disparando el costo de 'high'.
const PALABRAS_CALIDAD_PREMIUM = /\b(mejor calidad|alta calidad|maxima calidad|calidad premium|premium|para imprimir|version final|mejor resolucion|mas nitida|mayor nitidez|calidad de impresion)\b/

export function decidirCalidadCartel(textoDocente: string, datosExplicitos: DatosExplicitosPieza): 'medium' | 'high' {
  const t = normalizarParaInferencia(textoDocente)
  if (PALABRAS_CALIDAD_PREMIUM.test(t)) return 'high'
  return 'medium'
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
  // Aditivo — ver ModoVisualPieza arriba. Ausente (llamador viejo o
  // sin mensajeOriginalDocente) cae al default conservador dentro de
  // construirPromptCartelEscolar, nunca rompe.
  modoVisual?: ModoVisualPieza
  // Aditivo — ver DatosExplicitosPieza arriba. Ausente/objeto vacío
  // preserva el comportamiento de "sin datos extra" — el prompt nunca
  // asume hora/lugar/costo que no se detectaron.
  datosExplicitos?: DatosExplicitosPieza
  // CORRECCIÓN — "fuente de verdad completa": el mensaje REAL del
  // docente, tal cual, nunca la descripción que redactó Claude (esa
  // sigue viajando en `prompt`, ver construirPromptCartelEscolar).
  // datosExplicitos es solo un SUBCONJUNTO estructurado de este texto
  // (fecha/hora/lugar/costo) — mensajeOriginalDocente es la fuente
  // completa, y por eso conceptos que no caben en esos 4 campos (ej.
  // "Jornada Ampliada", "pago trimestral", "reunión de padres") siguen
  // teniendo respaldo real sin necesitar un regex por concepto.
  // Nombre deliberadamente distinto de "prompt"/"promptOriginal" para
  // que nunca se confunda con la dirección visual de Claude. Ausente
  // (llamador viejo) hace que construirPromptCartelEscolar caiga a la
  // jerarquía de autoridad más estrecha de antes (solo
  // datosExplicitos), nunca rompe.
  mensajeOriginalDocente?: string
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
  const modoVisual = solicitud.modoVisual ?? MODO_VISUAL_POR_DEFECTO
  const descripcionEstilo = solicitud.estilo ? DESCRIPCION_ESTILO[solicitud.estilo] : DESCRIPCION_MODO_VISUAL[modoVisual]
  const datos = solicitud.datosExplicitos ?? {}

  // CORRECCIÓN — "hueco semántico": datosExplicitos es solo un
  // SUBCONJUNTO estructurado (fecha/hora/lugar/costo) del mensaje real
  // del docente — tratarlo como la ÚNICA fuente de verdad (versión
  // anterior de esta función) descartaba hechos reales que el docente
  // sí escribió pero que no caben en esos 4 campos (ej. "Jornada
  // Ampliada", "pago trimestral", "reunión de padres"). Ahora la
  // fuente de verdad completa es solicitud.mensajeOriginalDocente
  // (ver SolicitudImagen arriba); datosExplicitos pasa a ser metadata
  // derivada de esa misma fuente, útil solo para JERARQUÍA/énfasis —
  // nunca agrega información que la solicitud original no tenga.
  const lineasDatos = [
    datos.fecha ? `Fecha: ${datos.fecha}.` : '',
    datos.hora ? `Hora: ${datos.hora}.` : '',
    datos.lugar ? `Lugar: ${datos.lugar}.` : '',
    datos.costo ? `Costo/cuota: ${datos.costo}.` : '',
  ].filter((l) => l.length > 0)
  // CAMBIO 3 — sin campos estructurados NO significa "sin hechos": el
  // mensaje original puede seguir conteniendo información real
  // ("Reunión de padres", "Jornada Ampliada") que simplemente no
  // encaja en fecha/hora/lugar/costo. El texto ya no afirma que no hay
  // "datos factuales" en general — solo que no se detectó ESTE
  // subconjunto estructurado.
  const datosEstructuradosConfirmados = lineasDatos.length > 0
    ? lineasDatos.join('\n')
    : 'No se detectaron campos estructurados adicionales de fecha/hora/lugar/costo.'
  const solicitudOriginal = solicitud.mensajeOriginalDocente?.trim()

  // JERARQUÍA TIPOGRÁFICA condicionada a lo que de verdad existe —
  // antes esta sección siempre mencionaba "fecha"/"hora y lugar" como
  // si existieran por defecto, lo cual empujaba al modelo a
  // completarlos por su cuenta cuando no venían. Ahora solo se pide
  // jerarquía para los campos que SÍ se detectaron.
  const partesJerarquia = [
    'título principal grande y muy legible, dominante en la composición',
    datos.fecha ? 'la fecha debe ser el segundo elemento más destacado, en tamaño grande y bien visible' : '',
    (datos.hora || datos.lugar) ? 'hora y/o lugar (solo los que se listan en DATOS ESTRUCTURADOS CONFIRMADOS) en una zona clara, legibles pero secundarios frente al título y la fecha' : '',
    'si hay texto de cuerpo adicional, debe ser breve, corto y con tipografía legible — nunca amontonado ni diminuto',
  ].filter((p) => p.length > 0)

  // "bajar el nivel de genérico/recargado" — decoración diferenciada
  // por modo: institucional_limpio pide deliberadamente MENOS
  // elementos que escolar_alegre, nunca al revés.
  const elementosDecorativos = modoVisual === 'institucional_limpio'
    ? 'decoración mínima y discreta — como máximo 1 elemento gráfico sutil relacionado con el entorno escolar (ej. un ícono institucional simple); nunca ilustraciones infantiles, nunca stickers, nunca varios elementos decorativos compitiendo entre sí.'
    : 'iconografía o ilustraciones escolares relacionadas con el tipo de aviso (según corresponda: personas en un salón de clases, calendario, mochila, útiles escolares, campana escolar, edificio escolar...) como acento visual — máximo 1-2 elementos decorativos, nunca deben opacar ni competir con el texto principal.'

  // Regla de jerarquía — condicionada a si de verdad tenemos la
  // solicitud original completa. Con ella (caso real de
  // ejecutarGeneracionImagen, ver herramientas.ts): 3 capas, la
  // solicitud original manda. Sin ella (llamador que no la pasa,
  // backward-compat): se conserva la jerarquía más estrecha de la
  // corrección anterior — solo DATOS ESTRUCTURADOS CONFIRMADOS tiene
  // autoridad, nunca rompe ni queda sin regla.
  const reglaJerarquiaAutoridad = solicitudOriginal
    ? 'REGLA CRÍTICA — JERARQUÍA DE AUTORIDAD: la "SOLICITUD ORIGINAL DEL DOCENTE" es la fuente de verdad completa y con máxima autoridad. "DATOS ESTRUCTURADOS CONFIRMADOS" es un subconjunto derivado de esa misma solicitud (sirve solo para jerarquía/énfasis) — nunca agrega información que la solicitud original no tenga. "DIRECCIÓN VISUAL Y COMPOSITIVA" únicamente aporta diseño (composición, ambiente, objetos, estética, distribución, estilo) — si menciona una fecha, hora, lugar, costo, nombre, cantidad, evento o cualquier otro hecho que NO esté contenido o sustentado por la "SOLICITUD ORIGINAL DEL DOCENTE", ese dato debe ser IGNORADO por completo. Nunca completes datos faltantes por contexto, sentido común o costumbre escolar.'
    : 'REGLA CRÍTICA — JERARQUÍA DE AUTORIDAD: SOLO "DATOS ESTRUCTURADOS CONFIRMADOS" tiene autoridad para fecha, hora, lugar y costo. Si "DIRECCIÓN VISUAL Y COMPOSITIVA" menciona un dato factual que NO aparezca ahí, debe ser IGNORADO por completo — nunca lo incluyas en la imagen. Nunca completes datos faltantes por contexto, sentido común o costumbre escolar.'

  const secciones = [
    `TIPO DE PIEZA: ${DESCRIPCION_TIPO_PIEZA[tipoPieza]}.`,
    'OBJETIVO VISUAL: comunicar la información de forma clara e inmediata a quien la vea (madre, padre de familia o docente), con apariencia de pieza gráfica profesional real — nunca una imagen improvisada o genérica.',
    'FORMATO Y COMPOSICIÓN: cartel vertical tipo póster escolar. Composición limpia, llamativa y bien organizada, con bloques de contenido SOLO cuando sean necesarios (nunca bloques vacíos o rellenos de relleno) y bien alineados — nunca todo el contenido disperso o distribuido de forma plana sin estructura.',
    `ESTILO VISUAL: ${descripcionEstilo}.`,
    `JERARQUÍA TIPOGRÁFICA: ${partesJerarquia.join('; ')}.`,
    // CAMBIO 1/2 — nueva capa: la solicitud completa del docente,
    // fuente de verdad primaria (ver SolicitudImagen.mensajeOriginalDocente
    // arriba). Solo se omite si el llamador no la pasó.
    solicitudOriginal ? `SOLICITUD ORIGINAL DEL DOCENTE — FUENTE DE VERDAD COMPLETA (texto real y completo escrito por el maestro, máxima autoridad sobre cualquier hecho):\n${solicitudOriginal}` : '',
    `DATOS ESTRUCTURADOS CONFIRMADOS (subconjunto de fecha/hora/lugar/costo derivado de la solicitud original — SOLO para jerarquía/énfasis, nunca agrega información):\n${datosEstructuradosConfirmados}`,
    `DIRECCIÓN VISUAL Y COMPOSITIVA (texto redactado por Claude/Sonnet — composición, ambiente, objetos, estética, distribución, estilo; NUNCA tiene autoridad para introducir hechos): ${solicitud.prompt.trim()}`,
    `ELEMENTOS DECORATIVOS: ${elementosDecorativos}`,
    // "copy creativo breve sí, eslogan largo no" — un saludo/título
    // corto de bienvenida no es un dato factual (no lo restringe la
    // jerarquía de autoridad de abajo), pero tampoco debe crecer hasta
    // volverse texto promocional.
    'COPY Y TONO: un saludo o título creativo breve (ej. "¡Bienvenidos de regreso!", "¡Los esperamos!") está permitido si no afirma ningún dato nuevo; evita eslóganes largos, bloques promocionales, hechos nuevos o nombres/fechas/horarios/lugares/cantidades/eventos inventados que opaquen la información principal.',
    'RESTRICCIONES VISUALES: evitar apariencia genérica, improvisada o de boceto simple; evitar saturación de elementos o de colores distintos; evitar exceso de globos, íconos, cajas o stickers simultáneos; la decoración siempre subordinada al mensaje, nunca al revés; evitar texto demasiado pequeño o ilegible; evitar distribución plana sin jerarquía visual; mantener márgenes limpios; evitar que la pieza se vea como una plantilla infantil genérica repetida.',
    reglaJerarquiaAutoridad,
  ].filter((s) => s.length > 0)

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
