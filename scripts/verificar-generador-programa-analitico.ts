// scripts/verificar-generador-programa-analitico.ts
//
// Prueba aislada (sin credenciales, sin red, sin llamadas IA) del
// generador de propuesta PA-3B1 (base determinista + deltas IA). Mismo
// doble mínimo de SupabaseClient de la serie. La prueba real de
// generación (1 llamada IA real con contexto, y 1 caso de 0 llamadas
// sin contexto) se hizo aparte — ver el reporte de PA-3B1.
//
// Se ejecuta con `npx tsx scripts/verificar-generador-programa-analitico.ts`.

import type { SupabaseClient } from '@supabase/supabase-js'
import { recuperarCatalogoCurricularCerrado } from '../lib/programaAnalitico/candidatosCurriculares'
import {
  construirBaseProgramaAnalitico,
  evaluarRequiereContexto,
  incorporarDeltasIa,
} from '../lib/programaAnalitico/generarPropuestaProgramaAnalitico'
import { aplicarDeltasSobreBase, type DeltaBorrador } from '../lib/programaAnalitico/borradorProgramaAnalitico'
import { validarEstructuraPropuesta } from '../lib/programaAnalitico/publicarProgramaAnalitico'
import { validarReferenciasPropuesta, type CatalogoContenido, type CatalogoPdaGrado, type CatalogoPeriodo } from '../lib/programaAnalitico/validacionReferencial'
import type { ContextoCurricularGrupo } from '../lib/curriculo/resolverContextoCurricularGrupo'
import type { ContextoInternoGrupo } from '../lib/programaAnalitico/contextoInterno'
import type { PropuestaProgramaAnalitico } from '../lib/programaAnalitico/tipos'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// --- Mismo doble mínimo de SupabaseClient que el resto de la serie. ---
type Fila = Record<string, unknown>

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
  private filtrosIn: Array<[string, unknown[]]> = []
  constructor(private cliente: ClienteSupabaseFalso, private tabla: string) {}
  select(_c: string) { void _c; return this }
  eq(c: string, v: unknown) { this.filtros.push([c, v]); return this }
  in(c: string, vs: unknown[]) { this.filtrosIn.push([c, vs]); return this }
  private ejecutar(): { data: Fila[] | null; error: null } {
    const filas = this.cliente._tabla(this.tabla)
    const resultado = filas.filter((f) => {
      if (!this.filtros.every(([c, v]) => f[c] === v)) return false
      if (!this.filtrosIn.every(([c, vs]) => vs.includes(f[c]))) return false
      return true
    })
    return { data: resultado, error: null }
  }
  then<T1 = unknown, T2 = never>(
    onf?: ((v: { data: Fila[] | null; error: null }) => T1 | PromiseLike<T1>) | null,
    onr?: ((r: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return Promise.resolve(this.ejecutar()).then(onf, onr)
  }
}

class ClienteSupabaseFalso {
  private tablas = new Map<string, Fila[]>()
  constructor(datos: Record<string, Fila[]> = {}) {
    for (const [t, fs] of Object.entries(datos)) this.tablas.set(t, fs.map((f) => ({ ...f })))
  }
  from(tabla: string) { return new ConsultaFalsa(this, tabla) }
  _tabla(tabla: string): Fila[] {
    if (!this.tablas.has(tabla)) this.tablas.set(tabla, [])
    return this.tablas.get(tabla)!
  }
}

function clienteFalso(datos: Record<string, Fila[]> = {}): SupabaseClient {
  return new ClienteSupabaseFalso(datos) as unknown as SupabaseClient
}

const GRADO_ID = 'grado-4-real'
const VERSION_ID = 'version-1'
const CAMPO_CUBIERTO = 'campo-lenguajes'
const CONTENIDO_A = 'contenido-a'
const CONTENIDO_B = 'contenido-b'

const CONTEXTO_BASE: ContextoCurricularGrupo = {
  grupoId: 'grupo-4b',
  cicloEscolarId: 'ciclo-actual',
  nivelEducativo: 'primaria',
  gradoGrupo: '4',
  curriculoGradoId: GRADO_ID,
  curriculoFaseId: 'fase-4',
  curriculoFaseClave: 'fase_4',
  curriculoVersionId: VERSION_ID,
  fallbackBorrador: true,
  camposConCobertura: [{ id: CAMPO_CUBIERTO, clave: 'lenguajes', nombre: 'Lenguajes' }],
}

function internoBase(overrides: Partial<ContextoInternoGrupo> = {}): ContextoInternoGrupo {
  return {
    nivelEducativo: 'primaria',
    gradoGrupo: '4',
    cicloEscolarId: 'ciclo-actual',
    institucionNombre: 'Escuela de prueba',
    totalAlumnosActivos: 28,
    calendarioRelevante: [],
    periodosDisponibles: [],
    necesidadesApoyo: [],
    ...overrides,
  }
}

async function main() {
  // --- 1. sin contexto suficiente → requiereContexto, 0 IA ---
  {
    const r = evaluarRequiereContexto(null, internoBase())
    verificar(r.requiereContexto === true, '1. sin contextoDocente ni necesidades → requiereContexto:true')
    if (r.requiereContexto) verificar(r.categorias.length === 6, '1b. reporta las 6 categorías concretas')

    const r2 = evaluarRequiereContexto('   ', internoBase())
    verificar(r2.requiereContexto === true, '1c. contextoDocente en blanco cuenta como ausente')

    const r3 = evaluarRequiereContexto('Grupo con alta rotación de alumnos migrantes.', internoBase())
    verificar(r3.requiereContexto === false, '1d. con contextoDocente real → requiereContexto:false')

    const r4 = evaluarRequiereContexto(null, internoBase({ necesidadesApoyo: [{ tipo: 'lectura', descripcion: 'Apoyo en comprensión lectora.' }] }))
    verificar(r4.requiereContexto === false, '1e. sin contextoDocente pero con necesidades confirmadas → requiereContexto:false')
  }

  // --- 2. base oficial determinista ---
  {
    const sb = clienteFalso({
      curriculo_contenido: [
        { id: CONTENIDO_A, titulo: 'Narración', campo_formativo_id: CAMPO_CUBIERTO, curriculo_version_id: VERSION_ID },
        { id: CONTENIDO_B, titulo: 'Descripción', campo_formativo_id: CAMPO_CUBIERTO, curriculo_version_id: VERSION_ID },
      ],
      curriculo_pda_grado: [
        { id: 'pdagrado-1', curriculo_pda_id: 'pda-1', contenido_id: CONTENIDO_A, curriculo_grado_id: GRADO_ID, curriculo_version_id: VERSION_ID },
        { id: 'pdagrado-2', curriculo_pda_id: 'pda-2', contenido_id: CONTENIDO_A, curriculo_grado_id: GRADO_ID, curriculo_version_id: VERSION_ID },
      ],
      curriculo_pda: [{ id: 'pda-1', texto: 'x' }, { id: 'pda-2', texto: 'y' }],
    })
    const catalogo = await recuperarCatalogoCurricularCerrado(sb, CONTEXTO_BASE)
    const base = construirBaseProgramaAnalitico(catalogo)
    verificar(base.length === 2, '2. base tiene 1 item por cada contenido candidato')
    verificar(base.every((i) => i.tipoDecision === 'sin_ajuste'), '2b. todos los items base son sin_ajuste')
    const itemA = base.find((i) => i.curriculoContenidoId === CONTENIDO_A)!
    verificar(itemA.curriculoPdaGradoIds.length === 2, '2c. item base incluye TODOS los PDA candidatos del contenido, sin IA')
    const itemB = base.find((i) => i.curriculoContenidoId === CONTENIDO_B)!
    verificar(itemB.curriculoPdaGradoIds.length === 0, '2d. contenido sin PDA candidatos → lista vacía, no inventada')
    verificar(base.map((i) => i.orden).sort().join(',') === '1,2', '2e. orden determinista 1..N')
  }

  const base2 = [
    { claveLocal: 'contenido:A', tipoDecision: 'sin_ajuste' as const, curriculoContenidoId: CONTENIDO_A, textoContextualizado: null, textoLocal: null, resultadoEsperadoLocal: null, periodoEvaluacionId: null, orden: 1, curriculoPdaGradoIds: ['pdagrado-1', 'pdagrado-2'] },
    { claveLocal: 'contenido:B', tipoDecision: 'sin_ajuste' as const, curriculoContenidoId: CONTENIDO_B, textoContextualizado: null, textoLocal: null, resultadoEsperadoLocal: null, periodoEvaluacionId: null, orden: 2, curriculoPdaGradoIds: [] },
  ]

  // --- 3. delta contextualizado válido ---
  {
    const decisiones: DeltaBorrador[] = [{ decision: 'contextualizar', curriculoContenidoId: CONTENIDO_A, textoContextualizado: 'Adaptado al contexto real.' }]
    const r = aplicarDeltasSobreBase(base2, decisiones)
    verificar(r.ok === true, '3. delta contextualizado válido se aplica')
    if (r.ok) {
      const item = r.items.find((i) => i.curriculoContenidoId === CONTENIDO_A)!
      verificar(item.tipoDecision === 'contextualizado' && item.textoContextualizado === 'Adaptado al contexto real.', '3b. item queda contextualizado con el texto de la IA')
      verificar(item.curriculoPdaGradoIds.length === 2, '3c. sin selección explícita de PDA, conserva todos los PDA de la base')
    }
  }

  // --- 4. delta con contenido inventado → rechazo ---
  {
    const decisiones: DeltaBorrador[] = [{ decision: 'contextualizar', curriculoContenidoId: 'contenido-inventado', textoContextualizado: 'x' }]
    const r = aplicarDeltasSobreBase(base2, decisiones)
    verificar(!r.ok && r.error.tipo === 'DELTA_CONTENIDO_NO_ENCONTRADO_EN_BASE', '4. contenido inventado por la IA → DELTA_CONTENIDO_NO_ENCONTRADO_EN_BASE')
  }

  // --- 5. delta con PDA incompatible → rechazo (validación referencial final) ---
  {
    const decisiones: DeltaBorrador[] = [{ decision: 'contextualizar', curriculoContenidoId: CONTENIDO_A, textoContextualizado: 'x', curriculoPdaGradoIdsSeleccionados: ['pdagrado-de-otro-contenido'] }]
    const r = aplicarDeltasSobreBase(base2, decisiones)
    verificar(r.ok === true, '5. aplicarDeltasSobreBase no valida pertenencia (responsabilidad de validarReferenciasPropuesta)')
    if (r.ok) {
      const pdaGradoPorId = new Map<string, CatalogoPdaGrado>([
        ['pdagrado-1', { id: 'pdagrado-1', contenidoId: CONTENIDO_A, curriculoGradoId: GRADO_ID, curriculoVersionId: VERSION_ID }],
        ['pdagrado-2', { id: 'pdagrado-2', contenidoId: CONTENIDO_A, curriculoGradoId: GRADO_ID, curriculoVersionId: VERSION_ID }],
        ['pdagrado-de-otro-contenido', { id: 'pdagrado-de-otro-contenido', contenidoId: CONTENIDO_B, curriculoGradoId: GRADO_ID, curriculoVersionId: VERSION_ID }],
      ])
      const contenidoPorId = new Map<string, CatalogoContenido>([
        [CONTENIDO_A, { id: CONTENIDO_A, campoFormativoId: CAMPO_CUBIERTO, curriculoVersionId: VERSION_ID }],
        [CONTENIDO_B, { id: CONTENIDO_B, campoFormativoId: CAMPO_CUBIERTO, curriculoVersionId: VERSION_ID }],
      ])
      const errorRef = validarReferenciasPropuesta(r.items, {
        curriculoVersionId: VERSION_ID, curriculoGradoId: GRADO_ID, cicloEscolarId: 'ciclo-actual',
        camposCubiertosIds: new Set([CAMPO_CUBIERTO]), contenidoPorId, pdaGradoPorId, periodoPorId: new Map(),
      })
      verificar(errorRef?.tipo === 'PDA_NO_PERTENECE_AL_ITEM', '5b. PDA seleccionado de otro contenido → PDA_NO_PERTENECE_AL_ITEM en la validación final')
    }
  }

  // --- 6. delta nuevo válido ---
  {
    const decisiones: DeltaBorrador[] = [{ decision: 'nuevo', claveLocal: 'clave-nuevo-test6', textoLocal: 'Contenido local de la región.', resultadoEsperadoLocal: 'Logra X.' }]
    const r = aplicarDeltasSobreBase(base2, decisiones)
    verificar(r.ok === true, '6. delta nuevo válido se aplica')
    if (r.ok) {
      const nuevo = r.items.find((i) => i.tipoDecision === 'nuevo')!
      verificar(!!nuevo && nuevo.curriculoContenidoId === null && nuevo.curriculoPdaGradoIds.length === 0, '6b. item nuevo sin contenido oficial ni PDA')
    }
  }

  // --- 7. contenido nuevo con PDA oficial → rechazo (validación de estructura) ---
  {
    const propuestaConNuevoConPda: PropuestaProgramaAnalitico = {
      grupoId: 'grupo-4b', idempotencyKey: 'k', contextoNotas: null,
      items: [{ claveLocal: 'nuevo:0', tipoDecision: 'nuevo', curriculoContenidoId: null, textoContextualizado: null, textoLocal: 'x', resultadoEsperadoLocal: null, periodoEvaluacionId: null, orden: 1, curriculoPdaGradoIds: ['pdagrado-1'] }],
    }
    const errores = validarEstructuraPropuesta(propuestaConNuevoConPda)
    verificar(errores.some((e) => e.tipo === 'ITEM_NUEVO_CON_PDA'), '7. nuevo con PDA oficial → ITEM_NUEVO_CON_PDA')
  }

  // --- 8. combinación base+deltas → propuesta PA-3A válida completa ---
  {
    const decisiones: DeltaBorrador[] = [
      { decision: 'excluir', curriculoContenidoId: CONTENIDO_B },
      { decision: 'contextualizar', curriculoContenidoId: CONTENIDO_A, textoContextualizado: 'Adaptado.' },
      { decision: 'nuevo', claveLocal: 'clave-nuevo-test8', textoLocal: 'Local.', resultadoEsperadoLocal: null },
    ]
    const r = aplicarDeltasSobreBase(base2, decisiones)
    verificar(r.ok === true, '8. combinación se aplica sin error')
    if (r.ok) {
      const propuestaFinal: PropuestaProgramaAnalitico = { grupoId: 'grupo-4b', idempotencyKey: 'k', contextoNotas: 'Notas.', items: r.items }
      const errores = validarEstructuraPropuesta(propuestaFinal)
      verificar(errores.length === 0, '8b. propuesta combinada pasa validarEstructuraPropuesta sin errores')
      verificar(r.items.length === 2, '8c. B excluido, A contextualizado, 1 nuevo → 2 items finales')
    }
  }

  // --- 9. contenido no modificado conserva sin_ajuste ---
  {
    const decisiones: DeltaBorrador[] = [{ decision: 'contextualizar', curriculoContenidoId: CONTENIDO_A, textoContextualizado: 'x' }]
    const r = aplicarDeltasSobreBase(base2, decisiones)
    if (r.ok) {
      const itemB = r.items.find((i) => i.curriculoContenidoId === CONTENIDO_B)!
      verificar(itemB.tipoDecision === 'sin_ajuste', '9. contenido sin decisión conserva sin_ajuste tal cual la base')
    }
  }

  // --- 10. no duplicar items (dos decisiones sobre el mismo contenido → rechazo) ---
  {
    const decisiones: DeltaBorrador[] = [
      { decision: 'contextualizar', curriculoContenidoId: CONTENIDO_A, textoContextualizado: 'x' },
      { decision: 'excluir', curriculoContenidoId: CONTENIDO_A },
    ]
    const r = aplicarDeltasSobreBase(base2, decisiones)
    verificar(!r.ok && r.error.tipo === 'DELTA_CONTENIDO_DUPLICADO', '10. dos decisiones sobre el mismo contenido → DELTA_CONTENIDO_DUPLICADO, nunca duplica el item')
  }

  // --- 11. orden final determinista ---
  {
    const decisiones: DeltaBorrador[] = [{ decision: 'nuevo', claveLocal: 'clave-a', textoLocal: 'a', resultadoEsperadoLocal: null }, { decision: 'nuevo', claveLocal: 'clave-b', textoLocal: 'b', resultadoEsperadoLocal: null }]
    const r = aplicarDeltasSobreBase(base2, decisiones)
    if (r.ok) {
      const ordenes = r.items.map((i) => i.orden).sort((a, b) => a - b)
      verificar(JSON.stringify(ordenes) === JSON.stringify([1, 2, 3, 4]), '11. orden final renumerado 1..N sin huecos ni repeticiones')
    }
  }

  // --- 12. grupo/contexto curricular nunca provienen de IA ---
  {
    const jsonIa = {
      grupoId: 'grupo-inventado-por-ia', curriculoVersionId: 'version-inventada',
      contextoPedagogico: 'Notas.', decisiones: [{ decision: 'nuevo', textoLocal: 'x', justificacionContenidoNuevo: 'Ningún contenido oficial del catálogo cubre esta necesidad específica.' }],
    }
    const incorporado = incorporarDeltasIa(jsonIa)
    verificar(incorporado.ok === true, '12. JSON con forma válida se incorpora')
    if (incorporado.ok) {
      const decision = incorporado.decisiones[0] as Record<string, unknown>
      verificar(!('grupoId' in decision) && !('curriculoVersionId' in decision), '12b. grupoId/curriculoVersionId de la IA nunca se propagan a la decisión incorporada')
    }
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
