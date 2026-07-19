// lib/asistente/deteccionFinTurno.ts
//
// Detección inteligente de fin de turno para el modo voz — reemplaza
// "esperar silencio fijo" por "leer la transcripción acumulada y decidir
// qué tan probable es que el maestro ya haya terminado su idea". Es
// heurística y local (regex sobre texto, cero llamadas de red): agregar
// aquí una clasificación con IA sería contradictorio con el objetivo de
// reducir latencia, ya que agregaría exactamente el tipo de viaje redondo
// que se está tratando de eliminar.
//
// Los tres tiempos de silencio (CASO A/B, ver analizarComplecionFrase) y
// el techo de seguridad (CASO D) viven aquí, en un solo lugar, para que
// nunca queden como números mágicos sueltos en motorOpenAIRealtime.ts.

export const CONFIG_FIN_TURNO = {
  // CASO A — la transcripción acumulada tiene toda la forma de una idea
  // ya terminada (termina en . ? !): basta una pausa breve para cerrar
  // el turno y pedir la respuesta.
  silencioFraseCompletaMs: 900,
  // CASO B — no hay señal clara de que la idea haya terminado (sin
  // puntuación de cierre, o termina en una palabra que normalmente
  // introduce algo más). Se espera más antes de cerrar, dándole al
  // maestro tiempo real de continuar sin cortarlo.
  silencioFraseIncompletaMs: 2500,
  // CASO D — respaldo final si nada de lo anterior aplicó (por ejemplo,
  // una transcripción vacía que después sí llega). No es el mecanismo
  // principal — ver SILENCIO_MAXIMO_MS en motorOpenAIRealtime.ts, que ya
  // cumplía este rol y se conserva sin cambios.
} as const

export type EstadoComplecionFrase = 'completa' | 'incompleta' | 'espera_explicita'

// Frases que indican explícitamente que el maestro va a seguir hablando
// — mientras la transcripción acumulada termine en una de estas, nunca
// se cierra el turno automáticamente (solo el botón manual o el techo de
// silencio prolongado lo harán).
const FRASES_ESPERA_EXPLICITA = [
  'espera', 'déjame pensar', 'dejame pensar', 'a ver', 'este',
  'y también', 'y tambien', 'otra cosa', 'además', 'ademas', 'pero',
  'quiero que',
]

// Última palabra típica de una frase que se quedó a medias (preposición,
// conjunción, artículo) — señal de que sigue algo después.
const CONECTORES_COLGANTES = new Set([
  'sobre', 'que', 'para', 'con', 'de', 'del', 'al', 'el', 'la', 'los', 'las',
  'un', 'una', 'y', 'o', 'pero', 'porque', 'cuando', 'donde', 'si', 'aunque',
  'también', 'tambien', 'además', 'ademas', 'a', 'en', 'su', 'sus', 'mi',
  'mis', 'como', 'es', 'son',
])

// Analiza la transcripción ACUMULADA de todo el turno hasta ahora (no
// solo el último fragmento) y decide qué tan probable es que el maestro
// ya haya terminado. El criterio por defecto, a propósito, es
// conservador: sin una señal clara de cierre (. ? !), se trata como
// incompleta — es preferible esperar un poco más (CASO B, 2-3s) que
// cortar una instrucción de varias partes a la mitad (ej. "Hazme cinco
// problemas de resta" + pausa + "para tercer grado" nunca debe cerrarse
// después del primer fragmento).
export function analizarComplecionFrase(textoAcumulado: string): EstadoComplecionFrase {
  const texto = textoAcumulado.trim()
  if (!texto) return 'incompleta'
  const textoLower = texto.toLowerCase()

  const terminaEnEspera = FRASES_ESPERA_EXPLICITA.some(
    frase => textoLower.endsWith(frase) || textoLower.endsWith(`${frase}...`) || textoLower.endsWith(`${frase},`)
  )
  if (terminaEnEspera) return 'espera_explicita'

  const ultimaPalabra = textoLower.match(/[a-záéíóúñ]+$/)?.[0] || ''
  if (CONECTORES_COLGANTES.has(ultimaPalabra)) return 'incompleta'
  if (/[,]$|\.\.\.$|…$/.test(texto)) return 'incompleta'

  // Señal fuerte de idea terminada: signo de cierre real al final, sin
  // nada colgando después. Whisper normalmente sí puntúa el final de una
  // idea completa — se confía en esa señal en vez de adivinar por
  // longitud o estructura de la frase.
  if (/[.?!]$/.test(texto)) return 'completa'

  return 'incompleta'
}
