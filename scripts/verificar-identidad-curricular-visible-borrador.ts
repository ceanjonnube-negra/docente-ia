// scripts/verificar-identidad-curricular-visible-borrador.ts
//
// PLN-1D1 — pruebas de lib/planeacion/identidadCurricularVisibleBorrador.ts:
// la identidad curricular VISIBLE (chat/Word/PDF) debe provenir
// exclusivamente de los candidatos YA VALIDADOS server-side, nunca de
// la propuesta cruda/paráfrasis de Claude. 0 red, 0 IA — reutiliza el
// fixture real de PLN-1B/1C/1D (los 86 items del PA canónico real
// publicado).
//
// Se ejecuta con `npx tsx scripts/verificar-identidad-curricular-visible-borrador.ts`.

import { readFileSync } from 'node:fs'
import {
  construirIdentidadCurricularVisible,
  renderizarBloqueIdentidadCurricularVisible,
  insertarIdentidadCurricularVisibleEnBorrador,
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

// Texto de borrador FALSO con formato realista (paráfrasis inventada
// por "Claude" en la sección narrativa Y en el bloque de resumen) —
// usado para probar que la identidad visible construida server-side
// nunca depende de, ni se confunde con, ese texto.
function borradorFalsoConParafrasis(): string {
  return [
    '📋 PLANEACIÓN DIDÁCTICA',
    'Grado: 4° | Grupo: B | Fase: 4',
    'Campo Formativo: Lenguajes',
    '',
    '🎯 PROPÓSITO GENERAL',
    'Un propósito de prueba.',
    '',
    '📚 PROCESOS DE DESARROLLO DE APRENDIZAJE (PDA)',
    '- Esta es una paráfrasis COMPLETAMENTE INVENTADA que Claude pudo haber escrito, sin relación con ningún PDA real.',
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
    'Contenidos: Otra paráfrasis inventada como contenido',
    'PDA: Otra paráfrasis inventada como PDA',
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

async function main() {
  // CASO A — item oficial: solo sus PDA canónicos.
  {
    const item = candidatosReales.find((c) => c.procedencia === 'oficial' && c.pda.length > 0)!
    const identidad = construirIdentidadCurricularVisible([item])
    verificar(identidad !== null, 'CASO A precondición: identidad construida')
    if (identidad) {
      verificar(identidad.contenidos.length === 1 && identidad.contenidos[0] === item.contenidoOficial, 'CASO A. contenidos = título oficial real, verbatim')
      const textosPdaReales = new Set(item.pda.map((p) => p.texto))
      verificar(identidad.pda.length === item.pda.length && identidad.pda.every((t) => textosPdaReales.has(t)), 'CASO A. PDA = exactamente los PDA canónicos reales del item, nada más')
    }
  }

  // CASO B — item contextualizado: conserva PDA canónicos, textoContextualizado nunca se convierte en PDA.
  {
    const item = candidatosReales.find((c) => c.procedencia === 'contextualizado' && c.pda.length > 0)!
    const identidad = construirIdentidadCurricularVisible([item])
    verificar(identidad !== null, 'CASO B precondición: identidad construida')
    if (identidad) {
      verificar(identidad.contenidos[0] === item.textoContextualizado, 'CASO B. contenidos = texto contextualizado real (identidad, no PDA)')
      verificar(!identidad.pda.includes(item.textoContextualizado!), 'CASO B. el texto contextualizado NUNCA aparece dentro de la lista de PDA')
      const textosPdaReales = new Set(item.pda.map((p) => p.texto))
      verificar(identidad.pda.every((t) => textosPdaReales.has(t)), 'CASO B. todos los PDA mostrados son canónicos reales de ese item')
    }
  }

  // CASO C — item local con pda=[]: no genera PDA falso.
  {
    const local = candidatosReales.find((c) => c.procedencia === 'local')!
    verificar(local.pda.length === 0, 'CASO C precondición: el item local real tiene pda=[]')
    const identidad = construirIdentidadCurricularVisible([local])
    verificar(identidad !== null && identidad.contenidos[0] === local.textoLocal, 'CASO C. contenidos = texto local real')
    verificar(identidad !== null && identidad.pda.length === 0, 'CASO C. pda=[] — nunca se fabrica un PDA para un item local')
  }

  // CASO D — varios items con el mismo PDA no producen duplicados visibles.
  {
    const pdaCompartido = { programaAnaliticoItemPdaId: 'pda-compartido-1', curriculoPdaId: 'curriculo-pda-x', curriculoPdaGradoId: 'curriculo-pda-grado-x', texto: 'Un PDA que dos contenidos distintos comparten legítimamente.' }
    const itemA: CandidatoCurricularPlaneacion = {
      programaAnaliticoId: 'pa-1', programaAnaliticoVersionId: 'v-1', programaAnaliticoItemId: 'item-a',
      procedencia: 'oficial', curriculoContenidoId: 'contenido-a',
      campoFormativo: { id: 'campo-1', clave: 'lenguajes', nombre: 'Lenguajes' },
      contenidoOficial: 'Contenido A', textoContextualizado: null, textoLocal: null,
      pda: [pdaCompartido],
    }
    const itemB: CandidatoCurricularPlaneacion = {
      ...itemA, programaAnaliticoItemId: 'item-b', curriculoContenidoId: 'contenido-b', contenidoOficial: 'Contenido B',
      pda: [pdaCompartido, { ...pdaCompartido, programaAnaliticoItemPdaId: 'pda-compartido-2', texto: 'Otro PDA distinto, solo de B.' }],
    }
    const identidad = construirIdentidadCurricularVisible([itemA, itemB])
    verificar(identidad !== null, 'CASO D precondición: identidad construida')
    if (identidad) {
      verificar(identidad.contenidos.length === 2, 'CASO D. 2 contenidos distintos, ambos presentes')
      verificar(identidad.pda.length === 2, `CASO D. PDA compartido deduplicado — 2 PDA únicos en total, no 3 (tiene ${identidad.pda.length})`)
      verificar(identidad.pda.filter((t) => t === pdaCompartido.texto).length === 1, 'CASO D. el PDA compartido aparece exactamente 1 vez, nunca repetido')
    }
  }

  // CASO E — una paráfrasis falsa de Claude en "PDA:" nunca se convierte en la identidad final cuando existe trazabilidad canónica.
  {
    const itemReal = candidatosReales.find((c) => c.procedencia === 'oficial' && c.pda.length > 0)!
    const identidadReal = construirIdentidadCurricularVisible([itemReal])!
    const textoFalso = borradorFalsoConParafrasis()
    const textoFinal = insertarIdentidadCurricularVisibleEnBorrador(textoFalso, identidadReal)

    verificar(textoFinal.includes(itemReal.contenidoOficial!), 'CASO E. el texto final SÍ contiene el contenido oficial REAL')
    verificar(textoFinal.includes(itemReal.pda[0].texto), 'CASO E. el texto final SÍ contiene un PDA canónico REAL')
    verificar(textoFinal.includes('IDENTIDAD CURRICULAR OFICIAL VALIDADA'), 'CASO E. la sección de identidad validada aparece rotulada de forma inequívoca')
    // La paráfrasis inventada de Claude SIGUE presente (no se borra su
    // narrativa/resumen — PLN-1D1 nunca reescribe la prosa de Claude),
    // pero la identidad REAL ahora también está, de forma inequívoca,
    // en el mismo documento.
    verificar(textoFinal.includes('COMPLETAMENTE INVENTADA'), 'CASO E. la narrativa original de Claude se conserva intacta (nunca se reescribe su prosa)')
    verificar(textoFinal.indexOf('IDENTIDAD CURRICULAR OFICIAL VALIDADA') < textoFinal.indexOf(ETIQUETA_INICIO_BLOQUE), 'CASO E. el bloque de identidad real se inserta ANTES del resumen — en un punto 100% determinista')
  }

  // CASO F — IDs/PDA inventados no aparecen: construirIdentidadCurricularVisible
  // solo lee de CandidatoCurricularPlaneacion (ya validados) — nunca de
  // ningún campo "propuesto"/crudo. Verificación estructural + comportamiento real.
  {
    const item = candidatosReales.find((c) => c.procedencia === 'oficial')!
    const identidad = construirIdentidadCurricularVisible([item])!
    // Ningún texto en la identidad visible puede ser distinto de lo
    // que ya existe verbatim en el candidato validado.
    const textosValidosDelItem = new Set([item.contenidoOficial, item.textoContextualizado, item.textoLocal, ...item.pda.map((p) => p.texto)].filter((t): t is string => !!t))
    verificar([...identidad.contenidos, ...identidad.pda].every((t) => textosValidosDelItem.has(t)), 'CASO F. cada texto mostrado proviene literalmente del candidato validado — imposible que aparezca algo inventado')

    const contenidoFuente = readFileSync(new URL('../lib/planeacion/identidadCurricularVisibleBorrador.ts', import.meta.url), 'utf-8')
    verificar(!/programaAnaliticoItemIdsPropuestos|textoBorradorAcumulado/.test(contenidoFuente), 'CASO F. el módulo nunca lee la propuesta cruda de Claude ni el texto libre del borrador — solo CandidatoCurricularPlaneacion ya validado')
  }

  // CASO G — snapshots V1/V2/V3 siguen funcionando (referencia — ya
  // cubierto exhaustivamente en scripts/verificar-snapshot-v4-trazabilidad-curricular.ts
  // CASO J; PLN-1D1 no tocó planeacionActiva.ts en absoluto).
  {
    const contenidoPlaneacionActiva = readFileSync(new URL('../lib/planeacion/planeacionActiva.ts', import.meta.url), 'utf-8')
    verificar(!contenidoPlaneacionActiva.includes('identidadCurricularVisibleBorrador'), 'CASO G. planeacionActiva.ts no fue tocado por PLN-1D1 (ningún import nuevo) — V1/V2/V3/V4 siguen exactamente como PLN-1D los dejó')
  }

  // CASO H — grupo sin PA conserva comportamiento anterior: identidad=null → texto sin cambios.
  {
    const textoOriginal = borradorFalsoConParafrasis()
    const textoSinCambios = insertarIdentidadCurricularVisibleEnBorrador(textoOriginal, null)
    verificar(textoSinCambios === textoOriginal, 'CASO H. identidad=null (grupo sin Programa Analítico) → texto devuelto IDÉNTICO, sin ninguna inserción')
  }
  {
    // Fail-closed adicional: si el marcador no aparece (borrador
    // incompleto/conflicto=true), tampoco se inserta nada — nunca se
    // adivina un punto de inserción alternativo.
    const identidadDePrueba = { contenidos: ['x'], pda: ['y'] }
    const textoSinMarcador = 'Un borrador incompleto sin bloque de resumen.'
    const resultado = insertarIdentidadCurricularVisibleEnBorrador(textoSinMarcador, identidadDePrueba)
    verificar(resultado === textoSinMarcador, 'CASO H2. sin el marcador de resumen (fail-closed) → texto devuelto sin cambios, nunca se inventa dónde insertar')
  }

  // CASO I — 0 llamadas IA adicionales (verificación estructural).
  {
    const archivos = ['lib/planeacion/identidadCurricularVisibleBorrador.ts']
    for (const archivo of archivos) {
      const contenido = readFileSync(new URL(`../${archivo}`, import.meta.url), 'utf-8')
      verificar(!/anthropic|messages\.create|messages\.stream|new Anthropic/i.test(contenido), `CASO I. ${archivo} no contiene ninguna llamada/import de Anthropic`)
    }
    const contenidoRoute = readFileSync(new URL('../app/api/chat/route.ts', import.meta.url), 'utf-8')
    const bloqueNuevo = contenidoRoute.slice(contenidoRoute.indexOf('PLN-1D1 — valida la selección curricular'), contenidoRoute.indexOf('Telemetría segura — cuenta cuántos adjuntos'))
    verificar(!/anthropic\.messages|\.stream\(\)/i.test(bloqueNuevo), 'CASO I. el nuevo bloque de route.ts (validación + inserción) no contiene ninguna llamada a Anthropic')
  }

  // Render — verificación de forma del bloque (nunca JSON, mismo estilo "Etiqueta: valor").
  {
    const bloque = renderizarBloqueIdentidadCurricularVisible({ contenidos: ['C1', 'C2'], pda: ['P1'] })
    verificar(bloque.startsWith('📌 IDENTIDAD CURRICULAR OFICIAL VALIDADA'), 'extra. el bloque renderizado empieza con el encabezado inequívoco')
    verificar(bloque.includes('Contenidos: C1 · C2'), 'extra. Contenidos usa el mismo formato de lista que el resto del documento')
    verificar(bloque.includes('PDA: P1'), 'extra. PDA usa el mismo formato de lista que el resto del documento')
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
