// Perfeccionamiento Word/PDF, etapa 2 — Word de planeaciones con la maqueta
// y el estilo compartidos. Sin red, sin IA, sin Storage: se inspecciona el
// XML del .docx generado (contenido, propiedades nativas de paginación,
// encabezados, pie con numeración automática).
//   npx tsx scripts/verificar-word-planeacion.ts

import JSZip from 'jszip'
import { Packer } from 'docx'
import { analizarContenido } from '../lib/documentGen/parseContenido'
import { sinEmoji } from '../lib/documentGen/maquetaDocumento'
import { construirDocumentoWord } from '../lib/documentGen/construirDocumentoWord'

let fallos = 0
let total = 0
function verificar(ok: boolean, nombre: string) {
  total++
  if (!ok) fallos++
  console.log(`${ok ? '✓' : '✗'} ${nombre}`)
}

const FRASE = 'El grupo comenta en equipos lo que observó y registra sus ideas principales en el cuaderno'
const parrafo = (n: number) => Array.from({ length: n }, (_, i) => `${FRASE} (${i + 1}).`).join(' ')
function planeacion({ sesiones, version = '3' }: { sesiones: number; version?: string | null }) {
  const l = ['📋 PLANEACIÓN DIDÁCTICA', ...(version ? [`Versión: ${version}`] : []), 'Fase: Fase 4', 'Campo Formativo: Lenguajes', '', '🎯 PROPÓSITO GENERAL', parrafo(2), 'Ordenan la cadena causa → hecho → consecuencia.', '', '📦 MATERIALES', '- Cuentos impresos', '- Hojas blancas', '']
  for (let s = 1; s <= sesiones; s++) {
    l.push(`📅 DÍA ${s} — Sesión número ${s}`, `Fecha estimada: lunes ${s} de diciembre de 2026`, '')
    for (const [m, min] of [['Inicio', 10], ['Desarrollo', 35], ['Cierre', 10]] as const) l.push(`🔷 ${m} (${min} min)`, parrafo((s % 3) + 1), '')
    l.push(`Evaluación: Registro del avance de la sesión ${s}.`, '')
  }
  l.push('📊 INDICADORES DE EVALUACIÓN', '1. Identifica los elementos del texto.', '2. Explica relaciones de causa y efecto.', '3. Planea su propio cuento.', '', 'Nota: la evaluación registrada con la hoja SG-TEST conserva sus criterios originales.')
  return l.join('\n')
}
const PERFIL = { escuela: 'Escuela Primaria Prueba', nombre: 'Docente Prueba', grado: '3°', grupo: 'A' }

type Docx = { documento: string; archivos: Record<string, string> }
async function abrir(texto: string, perfil: object): Promise<Docx> {
  const zip = await JSZip.loadAsync(await Packer.toBuffer(construirDocumentoWord(texto, perfil, 'America/Hermosillo')))
  const archivos: Record<string, string> = {}
  for (const n of Object.keys(zip.files)) if (n.endsWith('.xml')) archivos[n] = await zip.files[n].async('string')
  return { documento: archivos['word/document.xml'], archivos }
}
const desescapar = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const textoXml = (xml: string) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => desescapar(m[1])).join(' ')
const parrafos = (xml: string) => [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>|<w:p\s[\s\S]*?<\/w:p>/g)].map((m) => ({ xml: m[0], texto: textoXml(m[0]) }))
const palabras = (t: string) => t.toLocaleLowerCase('es').split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean)
const encabezados = (d: Docx) => Object.entries(d.archivos).filter(([n]) => /word\/header\d*\.xml/.test(n)).map(([, x]) => x)
const pies = (d: Docx) => Object.entries(d.archivos).filter(([n]) => /word\/footer\d*\.xml/.test(n)).map(([, x]) => x)

;(async () => {
  const texto = planeacion({ sesiones: 3 })
  const d = await abrir(texto, PERFIL)
  const ps = parrafos(d.documento)
  const busca = (re: RegExp) => ps.filter((p) => re.test(p.texto))

  // Contenido canónico íntegro y en orden (Word conserva Unicode: flechas tal cual).
  const esperado = palabras(analizarContenido(texto).map((x) => sinEmoji(x.texto)).join(' '))
  let k = 0
  for (const w of palabras(textoXml(d.documento))) if (k < esperado.length && w === esperado[k]) k++
  verificar(k === esperado.length, `1 contenido canónico íntegro y en orden (${k}/${esperado.length})`)
  verificar(textoXml(d.documento).includes('causa → hecho → consecuencia'), '2 las flechas se conservan tal cual')
  const d2 = await abrir(texto, PERFIL)
  verificar(d2.documento === d.documento, '3 generación determinista')

  // Propiedades nativas de paginación.
  const tiene = (p: { xml: string }, etiqueta: string) => new RegExp(`<w:${etiqueta}(\\s*/>|\\s+w:val="(true|1|on)"\\s*/>)`).test(p.xml)
  verificar(busca(/^(PROPÓSITO GENERAL|MATERIALES|INDICADORES DE EVALUACIÓN)$/).every((p) => tiene(p, 'keepNext')), '4 títulos de sección unidos al siguiente (keepNext)')
  verificar(busca(/^DÍA \d+$|^Sesión número \d+$|^Fecha estimada:/).every((p) => tiene(p, 'keepNext')) && busca(/^DÍA \d+$/).length === 3, '5 encabezado de sesión (día, título, fecha) unido al primer momento')
  verificar(busca(/■\s+(Inicio|Desarrollo|Cierre)/).length === 9 && busca(/■\s+(Inicio|Desarrollo|Cierre)/).every((p) => tiene(p, 'keepNext')), '6 momentos didácticos unidos a su contenido')
  verificar(busca(/^Evaluación:/).every((p) => tiene(p, 'keepLines') && /<w:shd /.test(p.xml)), '7 evaluaciones en recuadro y sin partirse')
  const indicadores = busca(/^[123]\.\s/)
  verificar(indicadores.length === 3 && indicadores.every((p) => tiene(p, 'keepLines')) && tiene(indicadores[0], 'keepNext') && tiene(indicadores[1], 'keepNext') && tiene(indicadores[2], 'keepNext'), '8 indicadores: ninguno se parte; el título va con el primero y los dos últimos con la firma')
  const t7 = planeacion({ sesiones: 1 }).replace('3. Planea su propio cuento.', [3, 4, 5, 6, 7].map((n) => `${n}. Indicador número ${n}.`).join('\n'))
  const p7 = parrafos((await abrir(t7, PERFIL)).documento).filter((p) => /^\d\.\s/.test(p.texto))
  verificar(p7.length === 7 && p7.map((p) => tiene(p, 'keepNext')).join() === [true, false, false, false, false, true, true].join(), '8b indicadores intermedios pueden repartirse entre páginas (sin huecos grandes)')
  const vinetas = busca(/^Cuentos impresos$|^Hojas blancas$/)
  verificar(vinetas.length === 2 && tiene(vinetas[0], 'keepNext') && !tiene(vinetas[1], 'keepNext'), '8c el último elemento de una lista nunca queda solo')
  const iFirma = ps.findIndex((p) => p.texto.includes('______'))
  verificar(iFirma > 0 && tiene(ps[iFirma - 1], 'keepNext') && tiene(ps[iFirma], 'keepNext') && ps[ps.length - 1].texto === 'Docente de grupo', '9 firma unida al final del contenido (nunca sola)')
  const cuerpoSinPanel = parrafos(d.documento.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, '')).filter((p) => p.texto && !p.texto.includes('______') && !/^Docente/.test(p.texto))
  verificar(cuerpoSinPanel.length > 30 && cuerpoSinPanel.every((p) => tiene(p, 'widowControl')), '10 control de viudas y huérfanas en todos los párrafos del contenido')

  // Panel, encabezados y pie.
  verificar(/<w:tbl>/.test(d.documento) && /VERSIÓN/.test(textoXml(d.documento)) && /CAMPO FORMATIVO/.test(textoXml(d.documento)), '11 panel de datos generales (tabla editable)')
  verificar(/<w:titlePg\s*\/>|<w:titlePg w:val="(true|1)"\s*\/>/.test(d.documento), '12 primera página con encabezado propio')
  const enc = encabezados(d).map(textoXml)
  verificar(enc.some((t) => t.includes('Escuela Primaria Prueba') && t.includes('Docente: Docente Prueba')) && enc.some((t) => t.includes('Escuela Primaria Prueba') && !t.includes('Docente:') && t.includes('Planeación didáctica')), '13 encabezado completo en la primera página y compacto en las demás')
  verificar(pies(d).length >= 1 && pies(d).every((x) => /PAGE/.test(x) && /NUMPAGES/.test(x) && textoXml(x).includes('Versión 3')), '14 pie con versión real y numeración automática (PAGE / NUMPAGES)')

  // Datos reales únicamente.
  const vacio = await abrir(planeacion({ sesiones: 1, version: null }), {})
  const todo = [vacio.documento, ...encabezados(vacio), ...pies(vacio)].map(textoXml).join(' ')
  verificar(!/\bEscuela\b/.test(todo) && !/Docente:/.test(todo) && !/Versión/.test(todo) && !todo.includes('Docente Prueba'), '15 sin escuela, docente ni versión: no aparecen marcadores inventados')

  // Otros documentos: generador anterior intacto.
  const cit = await abrir('CITATORIO\nSe solicita su presencia el día lunes.', PERFIL)
  verificar(!/titlePg/.test(cit.documento) && !pies(cit).length && encabezados(cit).some((x) => textoXml(x).includes('Ciclo Escolar:')), '16 citatorios y demás documentos conservan su Word anterior')

  console.log(`\n${total - fallos}/${total} verificaciones correctas`)
  process.exit(fallos ? 1 : 0)
})()
