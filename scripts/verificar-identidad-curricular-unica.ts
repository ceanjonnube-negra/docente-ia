// scripts/verificar-identidad-curricular-unica.ts
//
// PLN-1D2 — cierra la brecha explícita que PLN-1D1 dejó documentada
// (informe PLN-1D1 §N): la planeación debe tener UNA sola identidad
// curricular visible bajo el rótulo "PDA"/"Contenidos" — nunca dos
// representaciones (la canónica insertada + la paráfrasis de Claude en
// el propio bloque "📎 RESUMEN PARA GUARDAR", que sigue siendo visible
// en el chat). 0 red, 0 IA — reutiliza el fixture real de PLN-1B/1C/1D
// (los 86 items del PA canónico real publicado).
//
// Se ejecuta con `npx tsx scripts/verificar-identidad-curricular-unica.ts`.

import { readFileSync } from 'node:fs'
import {
  construirIdentidadCurricularVisible,
  insertarIdentidadCurricularVisibleEnBorrador,
  sustituirContenidosYPdaEnBloqueResumen,
  type IdentidadCurricularVisible,
} from '../lib/planeacion/identidadCurricularVisibleBorrador'
import { ETIQUETA_INICIO_BLOQUE } from '../lib/planeacion/extraerBorrador'
import type { CandidatoCurricularPlaneacion } from '../lib/planeacion/resolverCurricularPlaneacion'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const candidatosReales: CandidatoCurricularPlaneacion[] = JSON.parse(
  readFileSync(new URL('./fixtures/pln1b-candidatos-pa-real.json', import.meta.url), 'utf-8')
)

// Simula un borrador que Claude PUDO haber redactado incluso pese a la
// instrucción de PLN-1D2 (defensa en profundidad: el pipeline aplicado
// aquí debe seguir dando el resultado correcto aunque el modelo no
// cumpla al pie de la letra) — incluye una sección narrativa "PDA" con
// paráfrasis inventada Y un bloque de resumen con su propia paráfrasis
// inventada distinta.
function borradorFalsoConParafrasisDoble(): string {
  return [
    '📋 PLANEACIÓN DIDÁCTICA',
    'Grado: 4° | Grupo: B | Fase: 4',
    'Campo Formativo: Lenguajes',
    '',
    '🎯 PROPÓSITO GENERAL',
    'Un propósito de prueba.',
    '',
    '📚 PROCESOS DE DESARROLLO DE APRENDIZAJE (PDA)',
    '- Paráfrasis narrativa INVENTADA número 1, distinta de cualquier PDA real.',
    '',
    ETIQUETA_INICIO_BLOQUE,
    'Nombre: Proyecto de prueba',
    'Grupo: 4°B',
    'Periodo de evaluación: sin periodo configurado',
    'Fecha de inicio: 2026-09-01',
    'Fecha de fin: 2026-09-10',
    'Duración: 8 días efectivos',
    'Propósito: Un propósito de prueba.',
    'Campos formativos: Lenguajes',
    'Contenidos: Paráfrasis inventada número 2, como contenido',
    'PDA: Paráfrasis inventada número 3, distinta de la número 1',
    'Ejes articuladores: Inclusión',
    'Metodología: Proyecto',
    'Producto final: Un producto',
    'Secuencia didáctica: Día 1: actividad',
    'Recursos: recurso1',
    'Evidencias: evidencia1',
    'Indicadores de evaluación: i1; i2; i3; i4; i5',
    'PROGRAMA_ANALITICO_ITEMS: ',
    '',
    '¿Deseas corregir algo o aprobarla para guardarla?',
  ].join('\n')
}

// Pipeline real, EXACTAMENTE en el mismo orden que route.ts (PLN-1D2).
function aplicarPipelineCompleto(texto: string, identidad: IdentidadCurricularVisible | null): string {
  const conInsercion = insertarIdentidadCurricularVisibleEnBorrador(texto, identidad)
  return sustituirContenidosYPdaEnBloqueResumen(conInsercion, identidad)
}

// Extrae el valor de la línea "PDA:" exacta dentro del bloque de
// resumen (mismo criterio que extraerLista) — para verificar qué
// terminó persistido/visible ahí.
function valorLineaPdaResumen(texto: string): string | null {
  const indice = texto.indexOf(ETIQUETA_INICIO_BLOQUE)
  if (indice === -1) return null
  const match = texto.slice(indice).match(/^PDA:\s*(.+)$/m)
  return match ? match[1].trim() : null
}

function valorLineaPdaOficiales(texto: string): string | null {
  const match = texto.match(/^PDA oficiales:\s*(.+)$/m)
  return match ? match[1].trim() : null
}

async function main() {
  const itemOficial = candidatosReales.find((c) => c.procedencia === 'oficial' && c.pda.length > 0)!
  const itemContextualizado = candidatosReales.find((c) => c.procedencia === 'contextualizado' && c.pda.length > 0)!
  const itemLocal = candidatosReales.find((c) => c.procedencia === 'local')!

  // CASO A — con PA válido existe UNA sola representación visible denominada PDA (mismo contenido en ambos lugares).
  {
    const identidad = construirIdentidadCurricularVisible([itemOficial])!
    const textoFinal = aplicarPipelineCompleto(borradorFalsoConParafrasisDoble(), identidad)
    const valorResumen = valorLineaPdaResumen(textoFinal)
    const valorOficiales = valorLineaPdaOficiales(textoFinal)
    verificar(valorResumen !== null && valorOficiales !== null, 'CASO A precondición: ambas líneas "PDA" existen en el texto final')
    verificar(valorResumen === itemOficial.pda[0].texto || valorResumen === itemOficial.pda.map((p) => p.texto).join('; '), 'CASO A. la línea "PDA:" del resumen contiene EXACTAMENTE el/los PDA canónico(s), nunca la paráfrasis inventada')
    // Ambas representaciones (resumen + sección insertada) deben
    // contener el MISMO conjunto de PDA reales — nunca dos identidades
    // distintas bajo el mismo rótulo "PDA".
    const setResumen = new Set((valorResumen ?? '').split(';').map((s) => s.trim()))
    const setOficiales = new Set((valorOficiales ?? '').split('·').map((s) => s.trim()))
    verificar(setResumen.size === setOficiales.size && [...setResumen].every((t) => setOficiales.has(t)), 'CASO A. la línea del resumen y la sección insertada representan EXACTAMENTE el mismo conjunto de PDA — una sola identidad, nunca dos divergentes')
  }

  // CASO B — esa representación contiene únicamente PDA canónicos.
  {
    const identidad = construirIdentidadCurricularVisible([itemOficial])!
    const textoFinal = aplicarPipelineCompleto(borradorFalsoConParafrasisDoble(), identidad)
    const textosPdaReales = new Set(itemOficial.pda.map((p) => p.texto))
    const valorResumen = valorLineaPdaResumen(textoFinal)!
    verificar(valorResumen.split(';').map((s) => s.trim()).every((t) => textosPdaReales.has(t)), 'CASO B. todo lo que aparece en "PDA:" del resumen es un PDA canónico real, nada más')
  }

  // CASO C — una paráfrasis de Claude no puede aparecer identificada como PDA oficial.
  {
    const identidad = construirIdentidadCurricularVisible([itemOficial])!
    const textoOriginal = borradorFalsoConParafrasisDoble()
    const textoFinal = aplicarPipelineCompleto(textoOriginal, identidad)
    verificar(!textoFinal.includes('Paráfrasis inventada número 3'), 'CASO C. la paráfrasis inventada que Claude escribió en la línea "PDA:" del resumen ya NO existe ahí — fue reemplazada')
    const valorResumen = valorLineaPdaResumen(textoFinal)
    verificar(valorResumen !== 'Paráfrasis inventada número 3, distinta de la número 1', 'CASO C. la identidad "PDA:" final nunca es la paráfrasis original')
    // La narrativa libre de Claude (fuera de cualquier etiqueta exacta
    // "PDA:") puede seguir existiendo como prosa — PLN-1D2 la evita
    // desde el prompt (no verificable aquí sin una llamada real), pero
    // el pipeline determinista nunca la trata como la identidad "PDA"
    // final en ninguna de las dos líneas etiquetadas.
    verificar(textoFinal.includes('Paráfrasis narrativa INVENTADA número 1'), 'CASO C2. la prosa narrativa libre (fuera de la etiqueta exacta) se conserva tal cual — PLN-1D2 nunca reescribe prosa, solo corrige lo etiquetado')
  }

  // CASO D — los contenidos curriculares visibles proceden de los items validados.
  {
    const identidad = construirIdentidadCurricularVisible([itemContextualizado])!
    const textoFinal = aplicarPipelineCompleto(borradorFalsoConParafrasisDoble(), identidad)
    const indice = textoFinal.indexOf(ETIQUETA_INICIO_BLOQUE)
    const matchContenidos = textoFinal.slice(indice).match(/^Contenidos:\s*(.+)$/m)
    verificar(matchContenidos !== null && matchContenidos[1].trim() === itemContextualizado.textoContextualizado, 'CASO D. "Contenidos:" del resumen = texto contextualizado real del item validado, nunca la paráfrasis inventada')
  }

  // CASO E — item local sin PDA no recibe PDA inventado.
  {
    verificar(itemLocal.pda.length === 0, 'CASO E precondición: el item local real tiene pda=[]')
    const identidad = construirIdentidadCurricularVisible([itemLocal])!
    const textoFinal = aplicarPipelineCompleto(borradorFalsoConParafrasisDoble(), identidad)
    // identidad.pda=[] → sustituirContenidosYPdaEnBloqueResumen NO
    // reemplaza la línea "PDA:" (guardia `pda.length > 0`) — se
    // documenta este comportamiento y se verifica que, en cualquier
    // caso, ningún PDA real aparece atribuido al item local.
    verificar(identidad.pda.length === 0, 'CASO E. identidad visible de un item local no trae ningún PDA')
    verificar(!textoFinal.includes('PDA oficiales:'), 'CASO E. sin PDA que mostrar, la sección insertada no incluye una línea "PDA oficiales:" (nunca fabrica una vacía o inventada)')
  }

  // CASO F — no hay duplicados (contenidos y PDA).
  {
    const otroContextualizado = candidatosReales.find((c) => c.procedencia === 'contextualizado' && c.programaAnaliticoItemId !== itemContextualizado.programaAnaliticoItemId && c.pda.some((p) => itemContextualizado.pda.some((p2) => p2.curriculoPdaGradoId === p.curriculoPdaGradoId)))
    // Si no existe un PDA real compartido en el fixture, se construye
    // un caso sintético mínimo para probar la deduplicación de forma
    // determinista (misma función real, datos de prueba controlados).
    const pdaCompartido = { programaAnaliticoItemPdaId: 'x', curriculoPdaId: 'y', curriculoPdaGradoId: 'z', texto: 'PDA compartido de prueba' }
    const itemA: CandidatoCurricularPlaneacion = { ...itemOficial, programaAnaliticoItemId: 'item-f-a', curriculoContenidoId: 'contenido-f-a', contenidoOficial: 'Contenido F-A', textoContextualizado: null, textoLocal: null, pda: [pdaCompartido] }
    const itemB: CandidatoCurricularPlaneacion = { ...itemOficial, programaAnaliticoItemId: 'item-f-b', curriculoContenidoId: 'contenido-f-b', contenidoOficial: 'Contenido F-B', textoContextualizado: null, textoLocal: null, pda: [pdaCompartido] }
    const identidad = construirIdentidadCurricularVisible([itemA, itemB])!
    verificar(identidad.pda.length === 1, `CASO F. PDA compartido entre 2 items → 1 solo en la identidad visible (tiene ${identidad.pda.length})`)
    verificar(identidad.contenidos.length === 2, 'CASO F. 2 contenidos distintos, ambos presentes sin duplicar')
    void otroContextualizado
  }

  // CASO G — grupo sin PA conserva el comportamiento anterior sin romperse.
  {
    const textoOriginal = borradorFalsoConParafrasisDoble()
    const textoFinal = aplicarPipelineCompleto(textoOriginal, null)
    verificar(textoFinal === textoOriginal, 'CASO G. identidad=null (grupo sin Programa Analítico) → pipeline completo devuelve el texto IDÉNTICO, sin ninguna inserción ni sustitución')
  }

  // CASO H — snapshots históricos (V1/V2/V3) siguen siendo válidos — referencia estructural.
  {
    const contenidoPlaneacionActiva = readFileSync(new URL('../lib/planeacion/planeacionActiva.ts', import.meta.url), 'utf-8')
    verificar(!contenidoPlaneacionActiva.includes('identidadCurricularVisibleBorrador'), 'CASO H. planeacionActiva.ts sigue sin ningún import de este módulo — PLN-1D2 no tocó el snapshot en absoluto, V1/V2/V3/V4 exactamente como PLN-1D los dejó')
  }

  // CASO I — ajustar una planeación V4 conserva el mismo contrato (mismo pipeline, sin importar crear/ajustar).
  {
    const identidad = construirIdentidadCurricularVisible([itemOficial])!
    const textoAjuste = aplicarPipelineCompleto(borradorFalsoConParafrasisDoble(), identidad)
    const valorResumenAjuste = valorLineaPdaResumen(textoAjuste)
    verificar(valorResumenAjuste !== null && itemOficial.pda.some((p) => valorResumenAjuste!.includes(p.texto)), 'CASO I. el pipeline aplicado en un turno de ajuste (misma función, route.ts no distingue crear/ajustar para este paso) produce igualmente identidad canónica')
  }

  // CASO J — 0 llamadas IA adicionales (verificación estructural).
  {
    const contenido = readFileSync(new URL('../lib/planeacion/identidadCurricularVisibleBorrador.ts', import.meta.url), 'utf-8')
    verificar(!/anthropic|messages\.create|messages\.stream|new Anthropic/i.test(contenido), 'CASO J. identidadCurricularVisibleBorrador.ts no contiene ninguna llamada/import de Anthropic')
    const contenidoRoute = readFileSync(new URL('../app/api/chat/route.ts', import.meta.url), 'utf-8')
    const bloque = contenidoRoute.slice(contenidoRoute.indexOf('PLN-1D1 — valida la selección curricular'), contenidoRoute.indexOf('Telemetría segura — cuenta cuántos adjuntos'))
    verificar(!/anthropic\.messages|\.stream\(\)/i.test(bloque), 'CASO J. el bloque de validación+inserción+sustitución en route.ts no contiene ninguna llamada a Anthropic')
  }

  // Extra — verificación estructural del cambio de prompt (PLN-1D2 principio A).
  {
    const contenidoInstrucciones = readFileSync(new URL('../lib/asistente/instruccionesPlaneacionGenerar.ts', import.meta.url), 'utf-8')
    verificar(contenidoInstrucciones.includes('NO redactes tú una sección de "Contenidos" ni de "PDA" en el cuerpo del borrador'), 'extra. las instrucciones ahora prohíben explícitamente a Claude redactar su propia sección "Contenidos"/"PDA" cuando existe contexto curricular canónico')
    verificar(contenidoInstrucciones.includes('OMITE este elemento por completo'), 'extra. la lista de elementos del borrador marca Contenidos/PDA como condicionales, no siempre obligatorios')
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
