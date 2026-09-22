// scripts/verificar-resolver-curricular-planeacion.ts
//
// PLN-1B — pruebas del resolver curricular determinista de Planeación.
// Dos partes:
//
// 1) resolverCandidatosCurricularesPuro (0 I/O) probado contra un
//    FIXTURE REAL: los 86 items del Programa Analítico canónico
//    real publicado en PA-5K (programaAnaliticoId=7da76cef-...,
//    version=e705f1ad-...), extraído por SQL de solo lectura
//    directamente en la forma CandidatoCurricularPlaneacion (ver
//    scripts/fixtures/pln1b-candidatos-pa-real.json) — nunca
//    hardcodeado a mano, nunca construido para forzar un resultado
//    esperado (PLN-1B §11: "no fuerces esos resultados si el
//    algoritmo determinista no puede justificarlos").
//
// 2) cargarCandidatosProgramaAnaliticoVigente (I/O) probado con el
//    mismo doble mínimo de SupabaseClient ya usado en
//    scripts/verificar-publicador-programa-analitico.ts — para CASO H
//    (versión antigua excluida) y CASO I (contenido oficial fuera del
//    PA vigente nunca aparece), que necesitan 2 versiones o un
//    contenido "suelto" que HOY no existen en el PA real (solo hay 1
//    versión publicada).
//
// Se ejecuta con `npx tsx scripts/verificar-resolver-curricular-planeacion.ts`.
// 0 red, 0 IA — solo lee el fixture local.

import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolverCandidatosCurricularesPuro,
  cargarCandidatosProgramaAnaliticoVigente,
  type CandidatoCurricularPlaneacion,
} from '../lib/planeacion/resolverCurricularPlaneacion'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// ============================================================
// Parte 1 — fixture real (86 items del PA canónico real, ver cabecera).
// ============================================================

const candidatosReales: CandidatoCurricularPlaneacion[] = JSON.parse(
  readFileSync(new URL('./fixtures/pln1b-candidatos-pa-real.json', import.meta.url), 'utf-8')
)

verificar(candidatosReales.length === 86, `fixture real tiene 86 candidatos (tiene ${candidatosReales.length})`)
verificar(candidatosReales.filter((c) => c.procedencia === 'oficial').length === 79, 'fixture real: 79 oficiales (sin_ajuste)')
verificar(candidatosReales.filter((c) => c.procedencia === 'contextualizado').length === 6, 'fixture real: 6 contextualizados')
verificar(candidatosReales.filter((c) => c.procedencia === 'local').length === 1, 'fixture real: 1 local')

// CASO A — título oficial exacto → resuelto/alta.
{
  const item = candidatosReales.find((c) => c.procedencia === 'oficial' && c.pda.length > 0)!
  const r = resolverCandidatosCurricularesPuro(candidatosReales, { tema: null, contenidoExplicito: item.contenidoOficial })
  verificar(r.estado === 'resuelto' && r.confianza === 'alta', `CASO A. título oficial exacto ("${item.contenidoOficial!.slice(0, 40)}...") → resuelto/alta`)
  verificar(r.candidatos.length === 1 && r.candidatos[0].programaAnaliticoItemId === item.programaAnaliticoItemId, 'CASO A. resuelve exactamente el item real correspondiente')
  verificar(r.motivoResolucion === 'coincidencia exacta con título oficial', 'CASO A. motivoResolucion determinista correcto')
}

// CASO B — PDA exacto → resuelto/alta.
{
  const item = candidatosReales.find((c) => c.procedencia === 'oficial' && c.pda.length > 0)!
  const pdaTexto = item.pda[0].texto
  const r = resolverCandidatosCurricularesPuro(candidatosReales, { tema: null, pdaExplicito: pdaTexto })
  verificar(r.estado === 'resuelto' && r.confianza === 'alta', `CASO B. PDA exacto ("${pdaTexto.slice(0, 40)}...") → resuelto/alta`)
  verificar(r.candidatos.length === 1 && r.candidatos[0].programaAnaliticoItemId === item.programaAnaliticoItemId, 'CASO B. resuelve exactamente el item real dueño de ese PDA')
  verificar(r.motivoResolucion === 'coincidencia exacta con PDA', 'CASO B. motivoResolucion determinista correcto')
}

// CASO C — texto contextualizado del PA real → resuelto, procedencia=contextualizado.
{
  const item = candidatosReales.find((c) => c.procedencia === 'contextualizado')!
  const r = resolverCandidatosCurricularesPuro(candidatosReales, { tema: null, contenidoExplicito: item.textoContextualizado })
  verificar(r.estado === 'resuelto' && r.confianza === 'alta', 'CASO C. texto contextualizado real → resuelto/alta')
  verificar(r.candidatos.length === 1 && r.candidatos[0].procedencia === 'contextualizado', 'CASO C. procedencia=contextualizado (nunca oficial)')
  verificar(r.candidatos[0].curriculoContenidoId === item.curriculoContenidoId, 'CASO C. conserva el curriculoContenidoId oficial real bajo la contextualización')
}

// CASO D — contenido local real → resuelto, procedencia=local, curriculoContenidoId=null, pda=[].
{
  const local = candidatosReales.find((c) => c.procedencia === 'local')!
  const r = resolverCandidatosCurricularesPuro(candidatosReales, { tema: null, contenidoExplicito: local.textoLocal })
  verificar(r.estado === 'resuelto' && r.confianza === 'alta', 'CASO D. texto local real exacto → resuelto/alta')
  verificar(r.candidatos.length === 1 && r.candidatos[0].procedencia === 'local', 'CASO D. procedencia=local')
  verificar(r.candidatos[0].curriculoContenidoId === null, 'CASO D. curriculoContenidoId=null (nunca falsifica identidad oficial)')
  verificar(r.candidatos[0].pda.length === 0, 'CASO D. pda=[] (un local nunca tiene PDA oficiales)')
  verificar(r.motivoResolucion === 'coincidencia exacta con contenido local', 'CASO D. motivoResolucion determinista correcto')
}

// CASO E — coincidencia léxica fuerte pero varios candidatos reales →
// requiere_seleccion. "manifestaciones culturales" aparece literalmente
// (cobertura 1.0) en 3 items reales distintos del PA — verificado por
// separado contra el fixture antes de escribir esta prueba, nunca
// construido para forzarlo.
{
  const r = resolverCandidatosCurricularesPuro(candidatosReales, { tema: 'manifestaciones culturales' })
  verificar(r.estado === 'requiere_seleccion' && r.confianza === 'media', 'CASO E. "manifestaciones culturales" (real, 3 coincidencias fuertes) → requiere_seleccion/media')
  verificar(r.candidatos.length >= 2, `CASO E. conjunto cerrado con 2+ candidatos (${r.candidatos.length})`)
  verificar(r.candidatos.length <= 8, 'CASO E. nunca devuelve un conjunto sin límite (tope de candidatos cerrados)')
  verificar(r.motivoResolucion === 'varios candidatos léxicamente relacionados con coincidencia fuerte', 'CASO E. motivoResolucion determinista correcto')
}

// CASO F — sin correspondencia (tokens inventados, ausentes de
// cualquier currículo real) → sin_correspondencia, candidatos=[].
{
  const r = resolverCandidatosCurricularesPuro(candidatosReales, { tema: 'xilófono robótico marciano' })
  verificar(r.estado === 'sin_correspondencia' && r.confianza === 'ninguna', 'CASO F. tema sin ninguna relación léxica → sin_correspondencia/ninguna')
  verificar(r.candidatos.length === 0, 'CASO F. candidatos=[]')
}

// CASO G — "leyendas" contra el PA real completo. Verificado por
// separado (búsqueda literal) que NINGÚN texto de los 86 items ni sus
// PDA contiene la palabra "leyenda" — el resultado correcto y
// honesto es sin_correspondencia, NUNCA forzar un ganador entre
// "cuentos"/"narración"/"fantasía" por similitud temática (eso sería
// razonamiento semántico, prohibido en este resolver). Si en el
// futuro el catálogo cambia y aparece esa palabra, este assert debe
// aceptar también 'requiere_seleccion' (nunca 'resuelto' sin más de 1
// candidato con score real), pero jamás inventar contenido/PDA.
{
  const r = resolverCandidatosCurricularesPuro(candidatosReales, { tema: 'leyendas' })
  verificar(
    r.estado === 'sin_correspondencia' || r.estado === 'requiere_seleccion',
    `CASO G. "leyendas" → ${r.estado} (nunca 'resuelto' fingiendo una única respuesta correcta sin evidencia léxica real)`
  )
  verificar(r.estado !== 'resuelto', 'CASO G. nunca finge una resolución única para "leyendas" sin coincidencia léxica real')
  if (r.estado === 'sin_correspondencia') {
    verificar(r.candidatos.length === 0, 'CASO G. sin_correspondencia real: candidatos=[] (honesto, no inventa contenido/PDA)')
  } else {
    verificar(r.candidatos.length <= 8, 'CASO G. si hubiera candidatos léxicos reales, seguirían siendo un conjunto cerrado y pequeño')
  }
  console.log(`  [CASO G real] estado=${r.estado} confianza=${r.confianza} candidatos=${r.candidatos.length} motivo="${r.motivoResolucion}"`)
}

// Fail-closed puro — sin tema ni referencia explícita.
{
  const r = resolverCandidatosCurricularesPuro(candidatosReales, { tema: null })
  verificar(r.estado === 'sin_correspondencia' && r.confianza === 'ninguna', 'extra. sin tema ni referencia explícita → sin_correspondencia (nunca asume ni adivina)')
}

// ============================================================
// Parte 2 — carga real (I/O) con doble mínimo de SupabaseClient.
// Mismo patrón que scripts/verificar-publicador-programa-analitico.ts.
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

function clienteFalso(datos: Record<string, Fila[]> = {}): SupabaseClient {
  return new ClienteSupabaseFalso(datos) as unknown as SupabaseClient
}

async function pruebasCargaReal() {
  // CASO H + CASO I combinados: un PA con 2 versiones (solo una
  // vigente) y un contenido oficial "suelto" que nunca fue incluido en
  // ningún item del PA — ninguno de los dos debe aparecer.
  const datosBase: Record<string, Fila[]> = {
    programa_analitico: [{ id: 'pa-1', grupo_id: 'grupo-x', version_vigente_id: 'version-vigente' }],
    programa_analitico_item: [
      { id: 'item-vigente-1', programa_analitico_version_id: 'version-vigente', curriculo_contenido_id: 'contenido-a', tipo_decision: 'sin_ajuste', texto_contextualizado: null, texto_local: null },
      { id: 'item-antigua-1', programa_analitico_version_id: 'version-antigua', curriculo_contenido_id: 'contenido-b', tipo_decision: 'sin_ajuste', texto_contextualizado: null, texto_local: null },
    ],
    curriculo_contenido: [
      { id: 'contenido-a', titulo: 'Contenido A vigente', campo_formativo_id: 'campo-1' },
      { id: 'contenido-b', titulo: 'Contenido B de versión antigua', campo_formativo_id: 'campo-1' },
      { id: 'contenido-c-no-en-pa', titulo: 'Contenido C oficial nunca incluido en el PA', campo_formativo_id: 'campo-1' },
    ],
    curriculo_campo_formativo: [{ id: 'campo-1', clave: 'lenguajes', nombre: 'Lenguajes' }],
    programa_analitico_item_pda: [],
  }

  const sb = clienteFalso(datosBase)
  const cargado = await cargarCandidatosProgramaAnaliticoVigente(sb, 'grupo-x')
  verificar(cargado.ok === true, 'carga real: PA con grupo válido resuelve ok:true')
  if (cargado.ok) {
    verificar(cargado.candidatos.length === 1, `CASO H/I. solo 1 candidato devuelto (el de la versión vigente) — tiene ${cargado.candidatos.length}`)
    verificar(cargado.candidatos[0]?.programaAnaliticoItemId === 'item-vigente-1', 'CASO H. item de la versión vigente presente')
    verificar(!cargado.candidatos.some((c) => c.curriculoContenidoId === 'contenido-b'), 'CASO H. item de versión ANTIGUA (contenido-b) NUNCA aparece')
    verificar(!cargado.candidatos.some((c) => c.curriculoContenidoId === 'contenido-c-no-en-pa'), 'CASO I. contenido oficial fuera del PA vigente (contenido-c-no-en-pa) NUNCA es candidato, aunque exista en curriculo_contenido')
    verificar(cargado.candidatos[0]?.programaAnaliticoVersionId === 'version-vigente', 'carga real: programaAnaliticoVersionId es siempre la vigente, nunca la antigua')
  }

  // Fail-closed — PA inexistente para el grupo.
  const sbSinPa = clienteFalso({ programa_analitico: [] })
  const sinPa = await cargarCandidatosProgramaAnaliticoVigente(sbSinPa, 'grupo-sin-pa')
  verificar(!sinPa.ok && sinPa.error.tipo === 'SIN_PROGRAMA_ANALITICO', 'fail-closed. grupo sin Programa Analítico → SIN_PROGRAMA_ANALITICO, nunca [] silencioso')

  // Fail-closed — version_vigente_id null (PA existe pero sin versión vigente).
  const sbSinVersion = clienteFalso({ programa_analitico: [{ id: 'pa-2', grupo_id: 'grupo-y', version_vigente_id: null }] })
  const sinVersion = await cargarCandidatosProgramaAnaliticoVigente(sbSinVersion, 'grupo-y')
  verificar(!sinVersion.ok && sinVersion.error.tipo === 'PROGRAMA_ANALITICO_SIN_VERSION_VIGENTE', 'fail-closed. PA sin version_vigente_id → PROGRAMA_ANALITICO_SIN_VERSION_VIGENTE')

  // Fail-closed — item con curriculo_contenido_id que no resuelve
  // contra curriculo_contenido (referencia inconsistente) se omite,
  // nunca se aproxima con datos parciales/inventados.
  const sbInconsistente = clienteFalso({
    programa_analitico: [{ id: 'pa-3', grupo_id: 'grupo-z', version_vigente_id: 'version-z' }],
    programa_analitico_item: [{ id: 'item-huerfano', programa_analitico_version_id: 'version-z', curriculo_contenido_id: 'contenido-inexistente', tipo_decision: 'sin_ajuste', texto_contextualizado: null, texto_local: null }],
    curriculo_contenido: [],
  })
  const inconsistente = await cargarCandidatosProgramaAnaliticoVigente(sbInconsistente, 'grupo-z')
  verificar(inconsistente.ok === true && inconsistente.candidatos.length === 0, 'fail-closed. item con curriculo_contenido_id inconsistente se omite (nunca candidato con título vacío/aproximado)')

  // Fail-closed — relación PDA con curriculo_pda_grado_id que no
  // resuelve (nunca se aproxima el PDA).
  const sbPdaInconsistente = clienteFalso({
    programa_analitico: [{ id: 'pa-4', grupo_id: 'grupo-w', version_vigente_id: 'version-w' }],
    programa_analitico_item: [{ id: 'item-w1', programa_analitico_version_id: 'version-w', curriculo_contenido_id: 'contenido-w', tipo_decision: 'sin_ajuste', texto_contextualizado: null, texto_local: null }],
    curriculo_contenido: [{ id: 'contenido-w', titulo: 'Contenido W', campo_formativo_id: 'campo-w' }],
    curriculo_campo_formativo: [{ id: 'campo-w', clave: 'lenguajes', nombre: 'Lenguajes' }],
    programa_analitico_item_pda: [{ id: 'ip-w1', programa_analitico_item_id: 'item-w1', curriculo_pda_grado_id: 'pda-grado-inexistente' }],
    curriculo_pda_grado: [],
  })
  const pdaInconsistente = await cargarCandidatosProgramaAnaliticoVigente(sbPdaInconsistente, 'grupo-w')
  verificar(pdaInconsistente.ok === true && pdaInconsistente.candidatos[0]?.pda.length === 0, 'fail-closed. relación PDA inconsistente se omite del item (nunca un PDA aproximado/vacío)')

  // Local nunca lleva PDA ni curriculoContenidoId, incluso si la fila
  // trae basura en esos campos (defensa en profundidad, nunca confía
  // ciegamente en el shape de DB).
  const sbLocal = clienteFalso({
    programa_analitico: [{ id: 'pa-5', grupo_id: 'grupo-local', version_vigente_id: 'version-local' }],
    programa_analitico_item: [{ id: 'item-local-1', programa_analitico_version_id: 'version-local', curriculo_contenido_id: null, tipo_decision: 'nuevo', texto_contextualizado: null, texto_local: 'Contenido local de prueba' }],
  })
  const local = await cargarCandidatosProgramaAnaliticoVigente(sbLocal, 'grupo-local')
  verificar(local.ok === true && local.candidatos[0]?.procedencia === 'local' && local.candidatos[0]?.curriculoContenidoId === null && local.candidatos[0]?.pda.length === 0, 'carga real: item local se ensambla con procedencia=local, curriculoContenidoId=null, pda=[]')
}

async function main() {
  await pruebasCargaReal()
  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
