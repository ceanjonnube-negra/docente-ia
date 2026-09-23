// scripts/verificar-snapshot-v4-trazabilidad-curricular.ts
//
// PLN-1D — pruebas de trazabilidadCurricular en el snapshot V4
// (lib/planeacion/planeacionActiva.ts): construirTrazabilidadCurricular,
// construirPlaneacionActivaCreada/Ajustada, esPlaneacionActivaValida.
// 0 red, 0 IA — reutiliza el fixture real de PLN-1B/1C (los 86 items
// del PA canónico real publicado) más el mismo doble mínimo de
// SupabaseClient de 2 versiones ya usado en PLN-1C.
//
// Se ejecuta con `npx tsx scripts/verificar-snapshot-v4-trazabilidad-curricular.ts`.

import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  construirTrazabilidadCurricular,
  construirPlaneacionActivaCreada,
  construirPlaneacionActivaAjustada,
  esPlaneacionActivaValida,
  type PlaneacionActivaV4,
} from '../lib/planeacion/planeacionActiva'
import { validarSeleccionItemsProgramaAnalitico } from '../lib/planeacion/validarSeleccionCurricularPlaneacion'
import { cargarCandidatosProgramaAnaliticoVigente, type CandidatoCurricularPlaneacion } from '../lib/planeacion/resolverCurricularPlaneacion'
import type { ResumenBorrador } from '../lib/planeacion/extraerBorrador'

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

function resumenBorradorFixture(idsPropuestos: string[]): ResumenBorrador {
  return {
    nombre: 'Proyecto de prueba',
    grupoTexto: '4°B',
    periodoTexto: 'Trimestre 1',
    fechaInicio: '2026-09-01',
    fechaFin: '2026-09-10',
    duracionDias: 8,
    proposito: 'Propósito de prueba',
    camposFormativos: ['Lenguajes'],
    contenidos: ['Contenido de prueba'],
    pda: ['PDA de prueba'],
    ejesArticuladores: ['Inclusión'],
    metodologia: 'Aprendizaje basado en proyectos',
    productoFinal: 'Producto de prueba',
    secuenciaDidactica: [{ dia: 1, resumen: 'Actividad día 1' }],
    recursos: ['Recurso 1'],
    evidencias: ['Evidencia 1'],
    indicadores: ['Ind1', 'Ind2', 'Ind3', 'Ind4', 'Ind5'],
    programaAnaliticoItemIdsPropuestos: idsPropuestos,
  }
}

// ============================================================
// Doble mínimo de SupabaseClient — 2 versiones de PA (mismo patrón de
// scripts/verificar-integracion-curricular-planeacion.ts).
// ============================================================

type Fila = Record<string, unknown>

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
  private filtrosIn: Array<[string, unknown[]]> = []
  constructor(private cliente: ClienteSupabaseFalso, private tabla: string) {}
  select(_c: string) { void _c; return this }
  eq(c: string, v: unknown) { this.filtros.push([c, v]); return this }
  in(c: string, vs: unknown[]) { this.filtrosIn.push([c, vs]); return this }
  private ejecutar(): { data: Fila[] | null; error: { message: string } | null } {
    const filas = this.cliente._tabla(this.tabla)
    const resultado = filas.filter((f) => {
      if (!this.filtros.every(([c, v]) => f[c] === v)) return false
      if (!this.filtrosIn.every(([c, vs]) => vs.includes(f[c]))) return false
      return true
    })
    return { data: resultado, error: null }
  }
  async maybeSingle() {
    const { data, error } = this.ejecutar()
    if (error) return { data: null, error }
    return { data: data && data.length > 0 ? data[0] : null, error: null }
  }
  then<T1 = unknown, T2 = never>(
    onf?: ((v: { data: Fila[] | null; error: { message: string } | null }) => T1 | PromiseLike<T1>) | null,
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

const PA_ID = '88888888-8888-4888-8888-888888888888'
const GRUPO_ID = '99999999-9999-4999-8999-999999999999'
const VERSION_VIGENTE = '66666666-6666-4666-8666-666666666666'
const VERSION_ANTIGUA = '77777777-7777-4777-8777-777777777777'
const ITEM_VIGENTE = '11111111-1111-4111-8111-111111111111'
const ITEM_ANTIGUO = '22222222-2222-4222-8222-222222222222'

function clienteFalsoDosVersiones(): SupabaseClient {
  const datos: Record<string, Fila[]> = {
    programa_analitico: [{ id: PA_ID, grupo_id: GRUPO_ID, version_vigente_id: VERSION_VIGENTE }],
    programa_analitico_item: [
      { id: ITEM_VIGENTE, programa_analitico_version_id: VERSION_VIGENTE, curriculo_contenido_id: '33333333-3333-4333-8333-333333333333', tipo_decision: 'sin_ajuste', texto_contextualizado: null, texto_local: null },
      { id: ITEM_ANTIGUO, programa_analitico_version_id: VERSION_ANTIGUA, curriculo_contenido_id: '44444444-4444-4444-8444-444444444444', tipo_decision: 'sin_ajuste', texto_contextualizado: null, texto_local: null },
    ],
    curriculo_contenido: [
      { id: '33333333-3333-4333-8333-333333333333', titulo: 'Contenido A vigente', campo_formativo_id: '55555555-5555-4555-8555-555555555555' },
      { id: '44444444-4444-4444-8444-444444444444', titulo: 'Contenido B de versión antigua', campo_formativo_id: '55555555-5555-4555-8555-555555555555' },
    ],
    curriculo_campo_formativo: [{ id: '55555555-5555-4555-8555-555555555555', clave: 'lenguajes', nombre: 'Lenguajes' }],
    programa_analitico_item_pda: [],
  }
  return new ClienteSupabaseFalso(datos) as unknown as SupabaseClient
}

async function main() {
  // CASO A — id válido ofrecido → entra en V4.
  {
    const item = candidatosReales.find((c) => c.procedencia === 'oficial')!
    const validado = validarSeleccionItemsProgramaAnalitico([item], [item.programaAnaliticoItemId])
    const trazabilidad = construirTrazabilidadCurricular(item.programaAnaliticoId, item.programaAnaliticoVersionId, validado.aceptados)
    verificar(trazabilidad.items.length === 1 && trazabilidad.items[0].programaAnaliticoItemId === item.programaAnaliticoItemId, 'CASO A. id real y ofrecido → entra en trazabilidadCurricular.items')

    const snapshot = construirPlaneacionActivaCreada(resumenBorradorFixture([item.programaAnaliticoItemId]), 'texto completo del borrador', GRUPO_ID, null, trazabilidad)
    verificar(snapshot.schemaVersion === 4, 'CASO A. construirPlaneacionActivaCreada produce schemaVersion=4')
    verificar(esPlaneacionActivaValida(snapshot), 'CASO A. el snapshot V4 resultante es válido según esPlaneacionActivaValida')
  }

  // CASO B — id inventado → no entra.
  {
    const item = candidatosReales.find((c) => c.procedencia === 'oficial')!
    const validado = validarSeleccionItemsProgramaAnalitico([item], ['00000000-0000-4000-8000-000000000000'])
    const trazabilidad = construirTrazabilidadCurricular(item.programaAnaliticoId, item.programaAnaliticoVersionId, validado.aceptados)
    verificar(trazabilidad.items.length === 0, 'CASO B. id inventado (uuid válido pero inexistente) → NO entra en trazabilidadCurricular')
  }

  // CASO C — id real de OTRA versión → no entra.
  {
    const cargado = await cargarCandidatosProgramaAnaliticoVigente(clienteFalsoDosVersiones(), GRUPO_ID)
    verificar(cargado.ok === true, 'CASO C precondición: fixture de 2 versiones carga correctamente')
    if (cargado.ok) {
      const validado = validarSeleccionItemsProgramaAnalitico(cargado.candidatos, [ITEM_ANTIGUO])
      const trazabilidad = construirTrazabilidadCurricular(cargado.programaAnaliticoId, cargado.programaAnaliticoVersionId, validado.aceptados)
      verificar(trazabilidad.items.length === 0, 'CASO C. id real pero de versión ANTIGUA → NO entra en trazabilidadCurricular')
      verificar(trazabilidad.programaAnaliticoVersionId === VERSION_VIGENTE, 'CASO C. trazabilidadCurricular.programaAnaliticoVersionId sigue siendo la VIGENTE, nunca la antigua')
    }
  }

  // CASO D — id real del PA pero NO ofrecido en el conjunto cerrado de MODO A → no entra.
  {
    const itemOfrecido = candidatosReales.find((c) => c.procedencia === 'oficial')!
    const otroItemReal = candidatosReales.find((c) => c.procedencia === 'oficial' && c.programaAnaliticoItemId !== itemOfrecido.programaAnaliticoItemId)!
    const validado = validarSeleccionItemsProgramaAnalitico([itemOfrecido], [otroItemReal.programaAnaliticoItemId])
    const trazabilidad = construirTrazabilidadCurricular(itemOfrecido.programaAnaliticoId, itemOfrecido.programaAnaliticoVersionId, validado.aceptados)
    verificar(trazabilidad.items.length === 0, 'CASO D. id real del PA vigente pero fuera del conjunto cerrado ofrecido → NO entra en trazabilidadCurricular')
  }

  // CASO E — selección vacía → V4 válido con items=[].
  {
    const item = candidatosReales.find((c) => c.procedencia === 'oficial')!
    const validado = validarSeleccionItemsProgramaAnalitico([item], [])
    const trazabilidad = construirTrazabilidadCurricular(item.programaAnaliticoId, item.programaAnaliticoVersionId, validado.aceptados)
    verificar(trazabilidad.items.length === 0, 'CASO E. selección vacía → items=[]')
    verificar(trazabilidad.programaAnaliticoId === item.programaAnaliticoId, 'CASO E. programaAnaliticoId sigue presente (PA disponible, solo sin selección)')
    const snapshot = construirPlaneacionActivaCreada(resumenBorradorFixture([]), 'texto completo', GRUPO_ID, null, trazabilidad)
    verificar(esPlaneacionActivaValida(snapshot), 'CASO E. el snapshot V4 con trazabilidadCurricular.items=[] sigue siendo VÁLIDO (nunca se trata como error)')
  }

  // CASO F — item local: procedencia=local, curriculoContenidoId=null, pda=[].
  {
    const local = candidatosReales.find((c) => c.procedencia === 'local')!
    const validado = validarSeleccionItemsProgramaAnalitico([local], [local.programaAnaliticoItemId])
    const trazabilidad = construirTrazabilidadCurricular(local.programaAnaliticoId, local.programaAnaliticoVersionId, validado.aceptados)
    verificar(trazabilidad.items.length === 1, 'CASO F precondición: el item local entra en trazabilidadCurricular')
    const it = trazabilidad.items[0]
    verificar(it.procedencia === 'local', 'CASO F. procedencia=local')
    verificar(it.curriculoContenidoId === null, 'CASO F. curriculoContenidoId=null')
    verificar(it.campoFormativo === null, 'CASO F. campoFormativo=null')
    verificar(it.pda.length === 0, 'CASO F. pda=[]')
    const snapshot = construirPlaneacionActivaCreada(resumenBorradorFixture([local.programaAnaliticoItemId]), 'texto completo', GRUPO_ID, null, trazabilidad)
    verificar(esPlaneacionActivaValida(snapshot), 'CASO F. el snapshot V4 con un item local es válido')
  }

  // CASO G — item oficial/contextualizado: IDs reales y PDA reales.
  {
    const oficialConPda = candidatosReales.find((c) => c.procedencia === 'oficial' && c.pda.length > 0)!
    const contextualizado = candidatosReales.find((c) => c.procedencia === 'contextualizado')!
    for (const item of [oficialConPda, contextualizado]) {
      const validado = validarSeleccionItemsProgramaAnalitico([item], [item.programaAnaliticoItemId])
      const trazabilidad = construirTrazabilidadCurricular(item.programaAnaliticoId, item.programaAnaliticoVersionId, validado.aceptados)
      const it = trazabilidad.items[0]
      verificar(it.curriculoContenidoId === item.curriculoContenidoId, `CASO G. curriculoContenidoId real preservado para procedencia=${item.procedencia}`)
      verificar(it.campoFormativo !== null && it.campoFormativo.id === item.campoFormativo!.id, `CASO G. campoFormativo real preservado para procedencia=${item.procedencia}`)
      if (item.pda.length > 0) {
        verificar(it.pda.length === item.pda.length && it.pda[0].curriculoPdaId === item.pda[0].curriculoPdaId, `CASO G. PDA reales preservados (no de texto libre) para procedencia=${item.procedencia}`)
      }
    }
  }

  // CASO H — programaAnaliticoId/versionId NUNCA provienen del modelo (verificación estructural sobre route.ts).
  {
    const rutaRoute = new URL('../app/api/chat/route.ts', import.meta.url)
    const contenidoRoute = readFileSync(rutaRoute, 'utf-8')
    verificar(
      contenidoRoute.includes('construirTrazabilidadCurricular(cargadoParaValidar.programaAnaliticoId, cargadoParaValidar.programaAnaliticoVersionId,'),
      'CASO H. route.ts construye trazabilidadCurricular con programaAnaliticoId/VersionId tomados del contexto server-side recién cargado (cargadoParaValidar), nunca de resumenParaSnapshot ni de nada escrito por Claude'
    )
  }

  // CASO I — ajuste V4 reemplaza correctamente la selección validada (nunca mezcla vieja con nueva).
  {
    const itemViejo = candidatosReales.find((c) => c.procedencia === 'oficial')!
    const itemNuevo = candidatosReales.find((c) => c.procedencia === 'oficial' && c.programaAnaliticoItemId !== itemViejo.programaAnaliticoItemId)!
    const trazabilidadVieja = construirTrazabilidadCurricular(itemViejo.programaAnaliticoId, itemViejo.programaAnaliticoVersionId, [itemViejo])
    const snapshotV4Anterior = construirPlaneacionActivaCreada(resumenBorradorFixture([itemViejo.programaAnaliticoItemId]), 'texto viejo', GRUPO_ID, null, trazabilidadVieja) as PlaneacionActivaV4

    const trazabilidadNueva = construirTrazabilidadCurricular(itemNuevo.programaAnaliticoId, itemNuevo.programaAnaliticoVersionId, [itemNuevo])
    const snapshotAjustado = construirPlaneacionActivaAjustada(snapshotV4Anterior, resumenBorradorFixture([itemNuevo.programaAnaliticoItemId]), 'texto nuevo', null, trazabilidadNueva)

    verificar(snapshotAjustado.schemaVersion === 4, 'CASO I. el ajuste produce schemaVersion=4')
    verificar(snapshotAjustado.version === snapshotV4Anterior.version + 1, 'CASO I. version incrementa en +1')
    verificar(
      snapshotAjustado.trazabilidadCurricular !== null &&
        snapshotAjustado.trazabilidadCurricular.items.length === 1 &&
        snapshotAjustado.trazabilidadCurricular.items[0].programaAnaliticoItemId === itemNuevo.programaAnaliticoItemId,
      'CASO I. la trazabilidad del ajuste es EXACTAMENTE la nueva, nunca la vieja'
    )
    verificar(
      !snapshotAjustado.trazabilidadCurricular!.items.some((it) => it.programaAnaliticoItemId === itemViejo.programaAnaliticoItemId),
      'CASO I. el item viejo NO sobrevive en la trazabilidad del ajuste (nunca se mezclan silenciosamente)'
    )

    // Fail-closed: si el llamador no tiene contexto curricular este
    // turno, debe pasar null explícito — nunca hereda la trazabilidad
    // anterior "por si acaso".
    const snapshotAjustadoSinPa = construirPlaneacionActivaAjustada(snapshotV4Anterior, resumenBorradorFixture([]), 'texto sin PA', null, null)
    verificar(snapshotAjustadoSinPa.trazabilidadCurricular === null, 'CASO I. fail-closed: sin contexto curricular disponible este turno → trazabilidadCurricular=null, nunca hereda la anterior')
  }

  // CASO J — snapshot V3 histórico sigue siendo legible/usable.
  {
    const snapshotV3Historico = {
      schemaVersion: 3,
      version: 1,
      estado: 'borrador',
      implementadaEn: null,
      contexto: { grupoId: GRUPO_ID },
      borrador: resumenBorradorFixture([]),
      contenidoCompleto: 'texto histórico v3',
      origenMensajeId: null,
      actualizadoEn: new Date().toISOString(),
    }
    verificar(esPlaneacionActivaValida(snapshotV3Historico), 'CASO J. un snapshot V3 histórico (sin trazabilidadCurricular, campo inexistente) sigue siendo válido')
  }

  // CASO K — la propuesta cruda de Claude nunca se interpreta como selección canónica sin validación.
  {
    // construirTrazabilidadCurricular NUNCA lee ResumenBorrador.programaAnaliticoItemIdsPropuestos
    // — solo recibe candidatosAceptados YA VALIDADOS explícitamente.
    const item = candidatosReales.find((c) => c.procedencia === 'oficial')!
    const resumenConPropuestaMaliciosa = resumenBorradorFixture(['id-inventado-1', 'id-inventado-2'])
    const trazabilidadIgnorandoPropuesta = construirTrazabilidadCurricular(item.programaAnaliticoId, item.programaAnaliticoVersionId, [])
    const snapshot = construirPlaneacionActivaCreada(resumenConPropuestaMaliciosa, 'texto', GRUPO_ID, null, trazabilidadIgnorandoPropuesta)
    verificar(snapshot.trazabilidadCurricular!.items.length === 0, 'CASO K. una propuesta cruda con ids inventados en ResumenBorrador NUNCA influye en trazabilidadCurricular (solo el parámetro explícito ya validado importa)')

    const rutaRoute = new URL('../app/api/chat/route.ts', import.meta.url)
    const contenidoRoute = readFileSync(rutaRoute, 'utf-8')
    verificar(
      contenidoRoute.includes('const resumenSinPropuestaCruda = { ...resumenParaSnapshot, programaAnaliticoItemIdsPropuestos: [] as string[] }'),
      'CASO K. route.ts vacía explícitamente la propuesta cruda antes de persistir el snapshot (PLN-1D §8, opción B) — nunca queda en el JSONB persistido'
    )
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
