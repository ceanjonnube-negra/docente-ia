// Perfeccionamiento Word/PDF, etapa 1 — maqueta compartida y PDF de
// planeaciones. Sin red, sin IA, sin Storage: planeaciones sintéticas de
// distintos tamaños; invariantes de paginación y contenido íntegro.
//   npx tsx scripts/verificar-pdf-planeacion.ts

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { analizarContenido } from '../lib/documentGen/parseContenido'
import { construirMaqueta, esPlaneacionDidactica, sinEmoji, textoMaqueta, versionDeMaqueta } from '../lib/documentGen/maquetaDocumento'
import { paginar, paginarCompacto, type Caja } from '../lib/documentGen/paginacion'
import { NIVELES_COMPACTACION, TIPOGRAFIA } from '../lib/documentGen/estiloDocumento'
import { generarPdfPlaneacion } from '../lib/documentGen/pdfPlaneacion'
import { generarPdfBuffer } from '../lib/documentGen/generarPdfServidor'
import { prepararEncabezado } from '../lib/documentGen/encabezadoDocumento'
import { sanearParaWinAnsi } from '../lib/documentGen/textoPdf'

let fallos = 0
let total = 0
function verificar(ok: boolean, nombre: string) {
  total++
  if (!ok) fallos++
  console.log(`${ok ? '✓' : '✗'} ${nombre}`)
}

// Generador determinista de texto (sin aleatoriedad real).
const FRASE = 'El grupo comenta en equipos lo que observó y registra sus ideas principales en el cuaderno con apoyo del docente'
const parrafo = (n: number) => Array.from({ length: n }, (_, i) => `${FRASE} (${i + 1}).`).join(' ')
function planeacion({ sesiones, largo, indicadores = 5, version = '3', nota = true }: { sesiones: number; largo: number; indicadores?: number; version?: string | null; nota?: boolean }) {
  const l = ['📋 PLANEACIÓN DIDÁCTICA', ...(version ? [`Versión: ${version}`] : []), 'Fase: Fase 4', 'Campo Formativo: Lenguajes', '', '🎯 PROPÓSITO GENERAL', parrafo(2), '', '📦 MATERIALES', '- Cuentos impresos', '- Hojas blancas', '']
  for (let s = 1; s <= sesiones; s++) {
    l.push(`📅 DÍA ${s} — Sesión número ${s}`, `Fecha estimada: lunes ${s} de diciembre de 2026`, '')
    for (const [m, min] of [['Inicio', 10], ['Desarrollo', 35], ['Cierre', 10]] as const) l.push(`🔷 ${m} (${min} min)`, parrafo(((s + min) % largo) + 1), '')
    l.push(`Evaluación: Registro del avance de la sesión ${s}.`, '')
  }
  l.push('🏁 PRODUCTO FINAL', parrafo(1), '', '📊 INDICADORES DE EVALUACIÓN')
  for (let i = 1; i <= indicadores; i++) l.push(`${i}. Identifica y explica ${i === 2 ? parrafo(1) : 'los elementos del texto leído'} con claridad.`)
  if (nota) l.push('', 'Nota: la evaluación registrada con la hoja SG-TEST conserva sus criterios originales.')
  return l.join('\n')
}
const enc = prepararEncabezado({ escuela: 'Escuela Primaria Prueba', nombre: 'Docente Prueba', grado: '3°', grupo: 'A' }, 'America/Hermosillo')

async function textoPdf(bytes: Uint8Array): Promise<string[]> {
  const doc = await getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0 }).promise
  const paginas: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent()
    paginas.push(c.items.map((it) => ('str' in it ? it.str : '')).join(' '))
  }
  return paginas
}
// Palabras normalizadas: la composición cambia separadores y mayúsculas
// («DÍA 1 — Título» en dos líneas, «Inicio (10 min)» → «Inicio · 10 min»,
// secciones en versalitas), nunca las palabras.
const palabras = (t: string) => t.toLocaleLowerCase('es').split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean)

;(async () => {
  // 1. Maqueta pura: mismo contenido, mismo orden.
  const t = planeacion({ sesiones: 3, largo: 4 })
  const canon = analizarContenido(t).map((x) => sinEmoji(x.texto)).filter(Boolean)
  const bloques = construirMaqueta(t)
  verificar(JSON.stringify(textoMaqueta(bloques)) === JSON.stringify(canon), '1 la maqueta reproduce exactamente las líneas canónicas, en orden')
  verificar(JSON.stringify(construirMaqueta(t)) === JSON.stringify(bloques), '2 la maqueta es determinista')
  verificar(bloques.filter((b) => b.tipo === 'sesion').length === 3 && bloques.filter((b) => b.tipo === 'momento').length === 9 && bloques.filter((b) => b.tipo === 'evaluacion').length === 3, '3 sesiones, momentos y evaluaciones identificados')
  verificar(bloques.filter((b) => b.tipo === 'numerado').length === 5, '4 indicadores numerados identificados')
  verificar(versionDeMaqueta(bloques) === '3' && versionDeMaqueta(construirMaqueta(planeacion({ sesiones: 1, largo: 1, version: null }))) === null, '5 versión solo si el texto la trae')
  verificar(esPlaneacionDidactica(t) && !esPlaneacionDidactica('CITATORIO\nSe cita al padre de familia…') && !esPlaneacionDidactica('📋 RÚBRICA DE EVALUACIÓN\n…'), '6 solo las planeaciones usan la nueva composición')

  // 2. Invariantes de paginación sobre 40 planeaciones de distintos tamaños.
  const violaciones: string[] = []
  for (let sesiones = 1; sesiones <= 10; sesiones++) for (const largo of [1, 3, 6, 12]) {
    const texto = planeacion({ sesiones, largo, indicadores: 3 + (sesiones % 4) })
    const r = await generarPdfPlaneacion(texto, enc, true)
    const id = `${sesiones}s/${largo}`
    r.paginas.forEach((pg, p) => {
      const ultimo = pg[pg.length - 1]
      const esFinal = p === r.paginas.length - 1
      if (!esFinal && ultimo.caja.unirConSiguiente) violaciones.push(`${id} p${p + 1}: título/bloque unido al pie`)
      for (const f of pg) {
        const n = f.caja.lineas.length
        const parcial = f.desde > 0 || f.hasta < n
        if (parcial && f.caja.indivisible) violaciones.push(`${id} p${p + 1}: bloque indivisible partido (${f.caja.meta.tipo})`)
        if (parcial && f.hasta - f.desde < 2) violaciones.push(`${id} p${p + 1}: fragmento de 1 línea (${f.caja.meta.tipo})`)
        if (f.y + f.alto > 792 - 50 - 58 + 0.01) violaciones.push(`${id} p${p + 1}: desborde`)
      }
      if (pg.some((f) => f.caja.meta.tipo === 'firma') && pg.length < 2) violaciones.push(`${id} p${p + 1}: firma sola`)
    })
    // Grupo de indicadores (título + indicadores + nota + firma) en una sola página.
    const conIndicadores = r.paginas.map((pg) => pg.some((f) => f.caja.meta.tipo === 'numerado'))
    if (conIndicadores.filter(Boolean).length !== 1) violaciones.push(`${id}: indicadores repartidos en ${conIndicadores.filter(Boolean).length} páginas`)
    const pgFirma = r.paginas.findIndex((pg) => pg.some((f) => f.caja.meta.tipo === 'firma'))
    if (pgFirma !== conIndicadores.indexOf(true)) violaciones.push(`${id}: firma separada de los indicadores`)
    // Contenido íntegro en el PDF: todas las palabras canónicas, en orden.
    const extraido = palabras((await textoPdf(r.bytes)).join(' '))
    const esperado = palabras(analizarContenido(texto).map((x) => sanearParaWinAnsi(sinEmoji(x.texto))).join(' '))
    let k = 0
    for (const w of extraido) if (k < esperado.length && w === esperado[k]) k++
    if (k !== esperado.length) violaciones.push(`${id}: contenido incompleto (${k}/${esperado.length}) desde «${esperado.slice(k, k + 4).join(' ')}»`)
  }
  verificar(violaciones.length === 0, `7 40 planeaciones: sin títulos al pie, sin indicadores partidos, sin viudas/huérfanas, sin desbordes, firma con indicadores, contenido íntegro${violaciones.length ? ' — ' + violaciones.slice(0, 6).join(' | ') : ''}`)

  // 3. Paginador puro: bloques más altos que una página y unidos sin fin no ciclan.
  const caja = (n: number, o: Partial<Caja> = {}): Caja => ({ lineas: Array.from({ length: n }, () => [{ texto: 'x', fuente: 'regular' as const }]), interlineado: 10, antes: 5, despues: 5, unirConSiguiente: false, indivisible: false, meta: null, ...o })
  const gigante = paginar([caja(2, { unirConSiguiente: true }), caja(250, { indivisible: true }), caja(1)], () => 100)
  const lineasColocadas = gigante.flat().reduce((s, f) => s + f.hasta - f.desde, 0)
  verificar(lineasColocadas === 253 && gigante.every((pg) => pg.every((f) => f.y + f.alto <= 100)), '8 un bloque indivisible más alto que la página se parte sin desbordar ni ciclar')
  const unidos = paginar(Array.from({ length: 40 }, () => caja(2, { unirConSiguiente: true })), () => 100)
  verificar(unidos.flat().reduce((s, f) => s + f.hasta - f.desde, 0) === 80, '9 una cadena larga de bloques unidos termina y coloca todo')

  // Regresión: un título unido no queda al pie si lo sigue un párrafo de 3
  // líneas (que nunca se parte).
  const titulo3 = paginar([caja(6), caja(1, { unirConSiguiente: true }), caja(3)], () => 100)
  verificar(titulo3[0].every((f) => !f.caja.unirConSiguiente), '10 un título no queda al pie ante un párrafo corto que baja completo')

  // Compactación: nunca más páginas que sin compactar; el nivel elegido es
  // el menos compacto que logra el mínimo; nunca cambia el tamaño de letra.
  const niveles = [{ f: 1 }, { f: 0.5 }]
  const construir = (n: { f: number }) => Array.from({ length: 12 }, () => caja(2, { antes: 20 * n.f, despues: 20 * n.f }))
  const c1 = paginarCompacto(niveles, construir, () => 300)
  verificar(c1.nivel.f === 0.5 && c1.paginas.length < paginar(construir(niveles[0]), () => 300).length, '11 la compactación elimina páginas innecesarias')
  const c2 = paginarCompacto(niveles, construir, () => 2000)
  verificar(c2.nivel.f === 1, '12 sin ahorro de páginas, el documento no se compacta')
  const tamanos = new Set<number>()
  let menosPaginas = true
  for (let sesiones = 1; sesiones <= 10; sesiones += 3) {
    const texto = planeacion({ sesiones, largo: 5 })
    const r = await generarPdfPlaneacion(texto, enc, true)
    r.paginas.flat().forEach((f) => f.caja.meta.tipo !== 'dato' && tamanos.add(f.caja.meta.tamano))
    if (NIVELES_COMPACTACION.indexOf(r.nivel) < 0) menosPaginas = false
  }
  verificar(menosPaginas && [...tamanos].every((t) => Object.values(TIPOGRAFIA).includes(t as never) || t === 10), '13 la compactación solo usa niveles definidos y conserva los tamaños de letra')

  // 4. Datos reales únicamente (nunca se inventan).
  const sinDatos = prepararEncabezado({}, 'America/Hermosillo')
  const r0 = await generarPdfPlaneacion(planeacion({ sesiones: 1, largo: 1, version: null }), sinDatos, true)
  const txt0 = (await textoPdf(r0.bytes)).join(' ')
  verificar(!/\bEscuela\b/.test(txt0.replace(/Planeación didáctica/g, '')) && !/Docente:/.test(txt0) && !/Versión/.test(txt0), '14 sin escuela, docente ni versión: no aparecen marcadores inventados')
  verificar(/Página 1 de \d+/.test(txt0), '15 numeración de páginas presente')
  const r1 = await generarPdfPlaneacion(planeacion({ sesiones: 2, largo: 2 }), enc, true)
  const pags1 = await textoPdf(r1.bytes)
  verificar(pags1.every((p, i) => p.includes(`Página ${i + 1} de ${pags1.length}`) && p.includes('Versión 3')), '16 cada página lleva la versión real y «Página X de Y»')
  verificar(pags1[0].includes('Escuela Primaria Prueba') && pags1[0].includes('Docente: Docente Prueba') && pags1.slice(1).every((p) => p.includes('Escuela Primaria Prueba') && !p.includes('Docente: Docente Prueba')), '17 encabezado completo en la primera página y compacto en las siguientes')

  const flechas = (await textoPdf((await generarPdfPlaneacion('📋 PLANEACIÓN DIDÁCTICA\n\n🎯 PROPÓSITO\nOrdenan la cadena causa → hecho → consecuencia.', enc, false)).bytes)).join(' ').replace(/\s+/g, ' ')
  verificar(flechas.includes('causa -> hecho -> consecuencia'), '18 las flechas se conservan (WinAnsi no las tiene: se escriben «->»)')

  // Sesión que continúa en otra página: «Día N · Continuación» solo ahí.
  const rc = await generarPdfPlaneacion(planeacion({ sesiones: 4, largo: 12 }), enc, true)
  const pagsC = await textoPdf(rc.bytes)
  const esperadas = rc.paginas.map((pg, i) => i > 0 && !!pg[0].caja.meta.sesion && !pg[0].caja.meta.inicioSesion ? pg[0].caja.meta.sesion : null)
  verificar(esperadas.some(Boolean) && pagsC.every((t, i) => esperadas[i] ? t.includes(`Día ${esperadas[i]} · Continuación`) : !t.includes('Continuación')), '21 «Día N · Continuación» solo en páginas donde la sesión continúa')

  // 5. Otros documentos: camino anterior intacto (sin pie nuevo).
  const citatorio = Buffer.from(await generarPdfBuffer('CITATORIO\nSe solicita su presencia el día lunes.', { escuela: 'Escuela Primaria Prueba', nombre: 'Docente Prueba' }, 'America/Hermosillo'))
  verificar(!(await textoPdf(new Uint8Array(citatorio))).join(' ').includes('Página 1 de'), '19 los citatorios y demás documentos conservan su composición anterior')
  const plan = Buffer.from(await generarPdfBuffer(planeacion({ sesiones: 2, largo: 2 }), { escuela: 'Escuela Primaria Prueba', nombre: 'Docente Prueba' }, 'America/Hermosillo'))
  verificar((await textoPdf(new Uint8Array(plan))).join(' ').includes('Página 1 de'), '20 generarPdfBuffer delega las planeaciones en la nueva composición')

  console.log(`\n${total - fallos}/${total} verificaciones correctas`)
  process.exit(fallos ? 1 : 0)
})()
