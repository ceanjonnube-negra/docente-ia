// lib/documentGen/paginacion.ts
//
// Paginación por bloques, pura y determinista (sin bibliotecas de render:
// la medida del texto se inyecta). Reglas:
// - un bloque "unido al siguiente" (títulos, sesiones, momentos) nunca queda
//   al pie: baja junto con el mínimo del bloque que lo sigue;
// - un bloque indivisible (indicador, elemento de lista, evaluación breve,
//   firma) no se parte; si es más alto que una página completa, se parte
//   igual (nunca desborda ni entra en ciclo);
// - un párrafo largo se divide de forma controlada: al menos 2 líneas en
//   cada página (sin viudas ni huérfanas);
// - un bloque nunca empieza con su espacio "antes" en la parte superior de
//   una página.
// Una sola pasada con lookahead: termina siempre (cada paso coloca al menos
// una línea o abre una página vacía, donde siempre se coloca algo).

export type Fuente = 'regular' | 'negrita' | 'cursiva'
export type Medidor = (texto: string, fuente: Fuente, tamano: number) => number
// tono: clave de color que interpreta el renderizador (p. ej. 'acento').
export type Token = { texto: string; fuente: Fuente; tono?: string }

export type Caja<M = unknown> = {
  lineas: Token[][]
  interlineado: number // alto de cada línea (pt)
  antes: number
  despues: number
  unirConSiguiente: boolean
  indivisible: boolean
  // Cajas consecutivas con el mismo grupo (p. ej. indicadores de evaluación
  // con su título, nota y firma) van juntas si caben en una página; si no,
  // se reparten con las reglas normales (nunca hay huecos forzados).
  grupo?: number
  meta: M // lo que el renderizador necesita (tipo, colores, sangrías…)
}

export type Fragmento<M = unknown> = { caja: Caja<M>; indice: number; desde: number; hasta: number; y: number; alto: number; primero: boolean; ultimo: boolean }

// Envuelve tokens (palabras con su fuente) en líneas de ancho máximo.
export function envolver(tokens: Token[], anchoMax: number, medir: Medidor, tamano: number): Token[][] {
  const palabras: Token[] = []
  for (const t of tokens) for (const p of t.texto.split(/\s+/).filter(Boolean)) palabras.push({ texto: p, fuente: t.fuente, ...(t.tono ? { tono: t.tono } : {}) })
  const lineas: Token[][] = []
  let actual: Token[] = []
  let ancho = 0
  for (const p of palabras) {
    const w = medir(p.texto, p.fuente, tamano)
    const espacio = actual.length ? medir(' ', p.fuente, tamano) : 0
    if (actual.length && ancho + espacio + w > anchoMax) {
      lineas.push(actual)
      actual = [p]
      ancho = w
    } else {
      actual.push(p)
      ancho += espacio + w
    }
  }
  if (actual.length) lineas.push(actual)
  return lineas.length ? lineas : [[]]
}

const alto = (c: Caja, n = c.lineas.length) => n * c.interlineado
// Lo mínimo de un bloque que puede quedar al final de una página: completo
// si es indivisible o corto (≤3 líneas nunca se parte); si no, 2 líneas.
const minimoLineas = (c: Caja) => (c.indivisible || c.lineas.length <= 3 ? c.lineas.length : 2)
// Un grupo solo se fuerza a una página nueva si ocupa como máximo esta
// fracción de la página (evita páginas anteriores casi vacías).
const FRACCION_GRUPO = 0.75

function altoGrupo(cajas: Caja[], i: number): number {
  let total = 0
  for (let j = i; j < cajas.length && cajas[j].grupo === cajas[i].grupo; j++) total += (j === i ? 0 : cajas[j].antes) + alto(cajas[j]) + cajas[j].despues
  return total
}

// Tope de lo que un bloque reserva para el siguiente: un bloque gigante que
// lo sigue nunca deja un título solo en su página.
const TOPE_RESERVA = 180

// Alto mínimo que debe acompañar a la caja i en su página: la cadena de
// bloques unidos que la siguen y el mínimo del primero que no es unido.
function altoReservado(cajas: Caja[], i: number): number {
  let total = 0
  for (let j = i + 1; j < cajas.length; j++) {
    const c = cajas[j]
    if (c.unirConSiguiente) { total += c.antes + alto(c, minimoLineas(c)) + c.despues; continue }
    total += c.antes + alto(c, minimoLineas(c))
    break
  }
  return Math.min(total, TOPE_RESERVA)
}

export function paginar<M>(cajas: Caja<M>[], altoUtil: (pagina: number) => number): Fragmento<M>[][] {
  const paginas: Fragmento<M>[][] = [[]]
  let p = 0
  let y = 0
  const nueva = () => { paginas.push([]); p++; y = 0 }
  cajas.forEach((caja, indice) => {
    const n = caja.lineas.length
    const reserva = caja.unirConSiguiente ? altoReservado(cajas, indice) : 0
    let desde = 0
    // Inicio de un grupo que cabe en una página pero no en lo que queda.
    if (caja.grupo !== undefined && (indice === 0 || cajas[indice - 1].grupo !== caja.grupo) && y > 0) {
      const g = altoGrupo(cajas, indice)
      if (g <= altoUtil(p + 1) * FRACCION_GRUPO && caja.antes + g > altoUtil(p) - y) nueva()
    }
    const colocar = (k: number) => {
      const antes = y === 0 || desde > 0 ? 0 : caja.antes
      const ultimo = desde + k >= n
      paginas[p].push({ caja, indice, desde, hasta: desde + k, y: y + antes, alto: alto(caja, k), primero: desde === 0, ultimo })
      y += antes + alto(caja, k) + (ultimo ? caja.despues : 0)
      desde += k
    }
    while (desde < n) {
      const enCima = y === 0
      const antes = enCima || desde > 0 ? 0 : caja.antes
      const disponible = altoUtil(p) - y - antes
      const restante = n - desde
      const caben = Math.max(0, Math.floor(disponible / caja.interlineado))
      // 1. Cabe completo junto con lo que debe acompañarlo.
      if (alto(caja, restante) + reserva <= disponible) { colocar(restante); continue }
      // 2. Bloque que no se parte (indivisible o título corto unido): baja
      //    completo a la página siguiente; en una página vacía se coloca
      //    (y si es más alto que la página, se parte por líneas).
      const noSeParte = caja.indivisible || (caja.unirConSiguiente && n <= 3)
      if (noSeParte) {
        if (!enCima) { nueva(); continue }
        colocar(Math.max(1, Math.min(restante, caben)))
        if (desde < n) nueva()
        continue
      }
      // 3. Divisible: al menos 2 líneas en cada página; si lo que queda es
      //    corto, baja completo.
      let k = restante <= 3 ? 0 : Math.min(caben, restante - 2)
      if (k < 2) {
        if (!enCima) { nueva(); continue }
        k = Math.max(1, Math.min(caben, restante))
      }
      colocar(k)
      if (desde < n) nueva()
    }
  })
  return paginas.filter((pg, i) => pg.length > 0 || i === 0)
}

// Prueba cada nivel (de menos a más compacto) y devuelve el primero que
// alcanza el menor número de páginas. Determinista: mismos datos, mismo
// resultado.
export function paginarCompacto<M, N>(niveles: readonly N[], construir: (nivel: N) => Caja<M>[], altoUtil: (pagina: number) => number): { nivel: N; paginas: Fragmento<M>[][] } {
  const intentos = niveles.map((nivel) => ({ nivel, paginas: paginar(construir(nivel), altoUtil) }))
  const minimo = Math.min(...intentos.map((i) => i.paginas.length))
  return intentos.find((i) => i.paginas.length === minimo)!
}
