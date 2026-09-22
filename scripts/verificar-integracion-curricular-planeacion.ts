// scripts/verificar-integracion-curricular-planeacion.ts
//
// PLN-1C — pruebas de la integración del resolver curricular (PLN-1B)
// con la generación de Planeación: MODO A/B (lib/planeacion/
// resolverCurricularPlaneacion.ts §6) y la validación server-side de
// lo que Claude propone (lib/planeacion/validarSeleccionCurricularPlaneacion.ts).
// 0 red, 0 IA — reutiliza el mismo fixture real de PLN-1B (los 86
// items del PA canónico real publicado) más un doble mínimo de
// SupabaseClient para el caso que necesita 2 versiones.
//
// Se ejecuta con `npx tsx scripts/verificar-integracion-curricular-planeacion.ts`.

import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolverCandidatosCurricularesPuro,
  construirCatalogoCompactoPlaneacion,
  decidirModo,
  prepararContextoCurricularPlaneacion,
  cargarCandidatosProgramaAnaliticoVigente,
  type CandidatoCurricularPlaneacion,
  type ContextoCurricularParaPrompt,
} from '../lib/planeacion/resolverCurricularPlaneacion'
import { validarSeleccionItemsProgramaAnalitico, validarPdaDeItemCurricular } from '../lib/planeacion/validarSeleccionCurricularPlaneacion'

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

// ============================================================
// Doble mínimo de SupabaseClient — 2 versiones de PA (mismo patrón que
// scripts/verificar-resolver-curricular-planeacion.ts).
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

function clienteFalsoDosVersiones(): SupabaseClient {
  const datos: Record<string, Fila[]> = {
    programa_analitico: [{ id: '88888888-8888-4888-8888-888888888888', grupo_id: '99999999-9999-4999-8999-999999999999', version_vigente_id: '66666666-6666-4666-8666-666666666666' }],
    programa_analitico_item: [
      { id: '11111111-1111-4111-8111-111111111111', programa_analitico_version_id: '66666666-6666-4666-8666-666666666666', curriculo_contenido_id: '33333333-3333-4333-8333-333333333333', tipo_decision: 'sin_ajuste', texto_contextualizado: null, texto_local: null },
      { id: '22222222-2222-4222-8222-222222222222', programa_analitico_version_id: '77777777-7777-4777-8777-777777777777', curriculo_contenido_id: '44444444-4444-4444-8444-444444444444', tipo_decision: 'sin_ajuste', texto_contextualizado: null, texto_local: null },
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
  // CASO A — resolver=resuelto → solo candidatos pertinentes en contexto.
  {
    const item = candidatosReales.find((c) => c.procedencia === 'oficial' && c.pda.length > 0)!
    const resolucion = resolverCandidatosCurricularesPuro(candidatosReales, { tema: null, contenidoExplicito: item.contenidoOficial })
    verificar(resolucion.estado === 'resuelto', 'CASO A precondición: resolucion.estado === resuelto (real)')
    verificar(decidirModo(resolucion) === 'A', 'CASO A. resuelto → decidirModo = A')
    const contexto: ContextoCurricularParaPrompt = { modo: 'A', candidatosCerrados: resolucion.candidatos }
    verificar(contexto.modo === 'A' && contexto.candidatosCerrados.length === 1, 'CASO A. contexto MODO A trae solo 1 candidato (nunca los 86)')
    verificar(contexto.candidatosCerrados[0].programaAnaliticoItemId === item.programaAnaliticoItemId, 'CASO A. el candidato inyectado es exactamente el resuelto')
  }

  // CASO B — resolver=requiere_seleccion → solo conjunto cerrado.
  {
    const resolucion = resolverCandidatosCurricularesPuro(candidatosReales, { tema: 'manifestaciones culturales' })
    verificar(resolucion.estado === 'requiere_seleccion' && resolucion.candidatos.length >= 2, 'CASO B precondición: requiere_seleccion con 2+ candidatos reales')
    verificar(decidirModo(resolucion) === 'A', 'CASO B. requiere_seleccion con candidatos no vacíos → decidirModo = A (sigue siendo un conjunto CERRADO, aunque tenga varios)')
    const contexto: ContextoCurricularParaPrompt = { modo: 'A', candidatosCerrados: resolucion.candidatos }
    verificar(contexto.modo === 'A' && contexto.candidatosCerrados.length === resolucion.candidatos.length && contexto.candidatosCerrados.length < candidatosReales.length, 'CASO B. conjunto cerrado pequeño, nunca los 86 completos')
  }

  // CASO C — resolver=sin_correspondencia ("leyendas", real) → catálogo compacto del PA completo.
  {
    const resolucion = resolverCandidatosCurricularesPuro(candidatosReales, { tema: 'leyendas' })
    verificar(resolucion.estado === 'sin_correspondencia', 'CASO C precondición: "leyendas" (real) → sin_correspondencia')
    verificar(decidirModo(resolucion) === 'B', 'CASO C. sin_correspondencia → decidirModo = B')
    const catalogoCompacto = construirCatalogoCompactoPlaneacion(candidatosReales)
    verificar(catalogoCompacto.length === 86, 'CASO C. catálogo compacto MODO B trae los 86 items reales')
    verificar(!('pda' in (catalogoCompacto[0] as unknown as Record<string, unknown>)), 'CASO C. el catálogo compacto NUNCA lleva PDA completos (campo pda ausente en el tipo compacto)')
    verificar(!('resultadoEsperadoLocal' in (catalogoCompacto[0] as unknown as Record<string, unknown>)), 'CASO C. el catálogo compacto nunca lleva resultado_esperado_local')
  }

  // CASO D — catálogo compacto: 86 IDs únicos, todos de version_vigente_id, ningún item de versión antigua.
  {
    const catalogoCompacto = construirCatalogoCompactoPlaneacion(candidatosReales)
    const idsUnicos = new Set(catalogoCompacto.map((c) => c.id))
    verificar(idsUnicos.size === 86, `CASO D. 86 ids únicos en el catálogo compacto real (tiene ${idsUnicos.size})`)

    const sb = clienteFalsoDosVersiones()
    const resultado = await prepararContextoCurricularPlaneacion(sb, '99999999-9999-4999-8999-999999999999', { tema: 'inexistente xyz123' })
    verificar(resultado.disponible === true, 'CASO D. prepararContextoCurricularPlaneacion resuelve disponible:true con PA válido')
    if (resultado.disponible && resultado.contexto.modo === 'B') {
      verificar(resultado.contexto.catalogoCompacto.length === 1, 'CASO D. el catálogo compacto MODO B solo trae el item de la versión VIGENTE (nunca el de la versión antigua)')
      verificar(resultado.contexto.catalogoCompacto[0].id === '11111111-1111-4111-8111-111111111111', 'CASO D. el único id presente es el de la versión vigente')
    } else {
      verificar(false, 'CASO D. se esperaba MODO B (tema sin coincidencia léxica alguna)')
    }
  }

  // CASO E — item local: claramente marcado LOCAL.
  {
    const catalogoCompacto = construirCatalogoCompactoPlaneacion(candidatosReales)
    const local = catalogoCompacto.find((c) => c.procedencia === 'local')!
    verificar(local.textoEfectivo.startsWith('[LOCAL] '), `CASO E. textoEfectivo del item local empieza con "[LOCAL] " (real: "${local.textoEfectivo.slice(0, 30)}...")`)
    verificar(local.procedencia === 'local', 'CASO E. procedencia="local" también presente como campo estructurado, no solo en el texto')
  }

  // CASO F — respuesta con ID válido ofrecido → aceptado.
  {
    const item = candidatosReales.find((c) => c.procedencia === 'oficial')!
    const validado = validarSeleccionItemsProgramaAnalitico([item], [item.programaAnaliticoItemId])
    verificar(validado.aceptados.length === 1 && validado.aceptados[0].programaAnaliticoItemId === item.programaAnaliticoItemId, 'CASO F. id real y ofrecido → aceptado')
    verificar(validado.rechazados.length === 0, 'CASO F. 0 rechazados')
  }

  // CASO G — UUID inventado → rechazado.
  {
    const item = candidatosReales.find((c) => c.procedencia === 'oficial')!
    const uuidInventadoValido = '00000000-0000-4000-8000-000000000000'
    const garbage = 'no-es-un-uuid'
    const validado = validarSeleccionItemsProgramaAnalitico([item], [uuidInventadoValido, garbage])
    verificar(validado.aceptados.length === 0, 'CASO G. ningún id inventado se acepta')
    verificar(validado.rechazados.some((r) => r.idPropuesto === uuidInventadoValido && r.motivo === 'NO_OFRECIDO'), 'CASO G. UUID con forma válida pero inexistente → NO_OFRECIDO')
    verificar(validado.rechazados.some((r) => r.idPropuesto === garbage && r.motivo === 'UUID_INVALIDO'), 'CASO G. texto sin forma de UUID → UUID_INVALIDO')
  }

  // CASO H — UUID real de OTRA versión → rechazado.
  {
    const sbValidar = clienteFalsoDosVersiones()
    const cargado = await cargarCandidatosProgramaAnaliticoVigente(sbValidar, '99999999-9999-4999-8999-999999999999')
    if (cargado.ok) {
      const validado = validarSeleccionItemsProgramaAnalitico(cargado.candidatos, ['22222222-2222-4222-8222-222222222222'])
      verificar(validado.aceptados.length === 0 && validado.rechazados[0]?.motivo === 'NO_OFRECIDO', 'CASO H. id real pero de versión ANTIGUA → rechazado (nunca puede estar entre los candidatos de la versión vigente)')
    } else {
      verificar(false, 'CASO H. no se pudo cargar el fixture de 2 versiones')
    }
  }

  // CASO I — ID real del PA pero NO ofrecido en el conjunto cerrado (MODO A) → rechazado.
  {
    const itemOfrecido = candidatosReales.find((c) => c.procedencia === 'oficial')!
    const otroItemRealNoOfrecido = candidatosReales.find((c) => c.procedencia === 'oficial' && c.programaAnaliticoItemId !== itemOfrecido.programaAnaliticoItemId)!
    const validado = validarSeleccionItemsProgramaAnalitico([itemOfrecido], [otroItemRealNoOfrecido.programaAnaliticoItemId])
    verificar(validado.aceptados.length === 0, 'CASO I. id real del PA vigente pero fuera del conjunto cerrado ofrecido → rechazado')
    verificar(validado.rechazados[0]?.motivo === 'NO_OFRECIDO', 'CASO I. motivo correcto: NO_OFRECIDO')
  }

  // CASO J — PDA inventado → rechazado.
  {
    const item = candidatosReales.find((c) => c.pda.length > 0)!
    const validado = validarPdaDeItemCurricular(item, ['11111111-1111-4111-8111-111111111111'])
    verificar(validado.aceptados.length === 0 && validado.rechazados.length === 1, 'CASO J. PDA inventado (uuid que no pertenece al item) → rechazado')
  }

  // CASO K — PDA de OTRO contenido → rechazado.
  {
    const itemA = candidatosReales.find((c) => c.pda.length > 0)!
    const itemB = candidatosReales.find((c) => c.pda.length > 0 && c.programaAnaliticoItemId !== itemA.programaAnaliticoItemId)!
    const pdaDeB = itemB.pda[0].curriculoPdaGradoId
    const validado = validarPdaDeItemCurricular(itemA, [pdaDeB])
    verificar(validado.aceptados.length === 0 && validado.rechazados.includes(pdaDeB), 'CASO K. PDA real pero de OTRO item/contenido → rechazado')
  }

  // CASO L — selección vacía → permitida cuando no existe correspondencia.
  {
    const item = candidatosReales.find((c) => c.procedencia === 'oficial')!
    const validado = validarSeleccionItemsProgramaAnalitico([item], [])
    verificar(validado.aceptados.length === 0 && validado.rechazados.length === 0, 'CASO L. selección vacía → aceptados=[] rechazados=[] (nunca un error, nunca obliga a elegir)')
  }

  // CASO M — 0 llamadas IA adicionales (verificación estructural de los archivos que PLN-1C tocó o creó).
  {
    const archivos = [
      'lib/planeacion/resolverCurricularPlaneacion.ts',
      'lib/planeacion/validarSeleccionCurricularPlaneacion.ts',
      'lib/planeacion/generarBorrador.ts',
      'lib/planeacion/extraerBorrador.ts',
    ]
    for (const archivo of archivos) {
      const contenido = readFileSync(new URL(`../${archivo}`, import.meta.url), 'utf-8')
      verificar(!/anthropic|messages\.create|messages\.stream|new Anthropic/i.test(contenido), `CASO M. ${archivo} no contiene ninguna llamada/import de Anthropic`)
    }
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
