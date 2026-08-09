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

export type SolicitudImagen = {
  prompt: string
  estilo?: EstiloVisual
  tema?: string
  nivelEscolar?: string
  restriccionImpresion?: RestriccionImpresion
  // 'cuadrado' es el default: funciona bien tanto suelto en el chat
  // como embebido en un documento vertical (Word/PDF, ver Fase 2).
  formato?: 'cuadrado' | 'horizontal' | 'vertical'
}

// Único punto que decide el texto REAL que recibe el proveedor —
// nunca se manda solicitud.prompt tal cual. Determinista y pura: el
// mismo SolicitudImagen siempre produce el mismo prompt final.
export function construirPromptFinal(solicitud: SolicitudImagen): string {
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
