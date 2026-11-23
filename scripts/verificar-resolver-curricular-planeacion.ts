// scripts/verificar-resolver-curricular-planeacion.ts
//
// Hito 1, Parte 1 — núcleo determinista de resolución curricular de
// Planeación: contexto curricular del grupo, catálogo cerrado, Programa
// Analítico vigente, resolución por tema/referencias, contexto compacto
// para el prompt, validación de identificadores e identidad visible.
//
// Sin red, sin credenciales, sin IA: Supabase se sustituye por un doble
// en memoria que aplica los mismos filtros (.eq/.in) y cuenta consultas.
// Se ejecuta con `npx tsx scripts/verificar-resolver-curricular-planeacion.ts`.

import type { SupabaseClient } from '@supabase/supabase-js'
import { claveGradoCurricular, elegirVersion, resolverContextoCurricularGrupo } from '../lib/curriculo/resolverContextoCurricularGrupo'
import { recuperarCatalogoCurricularCerrado } from '../lib/curriculo/catalogoCurricular'
import {
  cargarCandidatosCurricularesGrupo,
  prepararContextoCurricularPlaneacion,
  resolverCandidatosCurricularesPuro,
  construirCatalogoPorCampo,
} from '../lib/planeacion/resolverCurricularPlaneacion'
import { reconocerCandidatosPorTexto, validarPdaDeItemCurricular, validarSeleccionCurricular } from '../lib/planeacion/validarSeleccionCurricularPlaneacion'
import {
  construirIdentidadCurricularVisible,
  insertarIdentidadCurricularVisibleEnBorrador,
  renderizarBloqueIdentidadCurricularVisible,
  sustituirContenidosYPdaEnBloqueResumen,
  ROTULO_PENDIENTE_VALIDACION,
  ROTULO_OFICIAL_VIGENTE,
  ROTULO_PROPUESTA_NO_VERIFICADA,
} from '../lib/planeacion/identidadCurricularVisibleBorrador'
import { ETIQUETA_INICIO_BLOQUE } from '../lib/planeacion/extraerBorrador'
import { U, F4, G3, baseCurricular, conProgramaAnalitico } from './fixtures/curriculoPlaneacionFicticio'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

// ------------------------------------------------------------
// Doble de Supabase: tablas en memoria; select/eq/in/maybeSingle.
// ------------------------------------------------------------
type Fila = Record<string, unknown>
class Consulta {
  private filtros: ((f: Fila) => boolean)[] = []
  constructor(private db: BaseFalsa, private tabla: string) {}
  select() { return this }
  eq(col: string, val: unknown) { this.filtros.push((f) => f[col] === val); return this }
  in(col: string, vals: unknown[]) { this.filtros.push((f) => vals.includes(f[col])); return this }
  private filas() { this.db.consultas++; return (this.db.tablas[this.tabla] ?? []).filter((f) => this.filtros.every((p) => p(f))) }
  maybeSingle() { const r = this.filas(); return Promise.resolve({ data: r[0] ?? null, error: null }) }
  then<T>(ok: (v: { data: Fila[]; error: null }) => T) { return Promise.resolve({ data: this.filas(), error: null }).then(ok) }
}
class BaseFalsa {
  consultas = 0
  constructor(public tablas: Record<string, Fila[]>) {}
  from(tabla: string) { return new Consulta(this, tabla) }
}
const cliente = (tablas: Record<string, Fila[]>) => new BaseFalsa(tablas)
const sb = (b: BaseFalsa) => b as unknown as SupabaseClient

async function main() {
  // 1. Contexto curricular del grupo.
  verificar(claveGradoCurricular('3°') === '3' && claveGradoCurricular('3er') === '3' && claveGradoCurricular(4) === '4' && claveGradoCurricular('') === null && claveGradoCurricular(null) === null,
    '1a. Grado normalizado a la clave del catálogo ("3°", "3er" → "3"; vacío → sin clave)')
  verificar(elegirVersion([{ id: 'a', estado: 'borrador' }, { id: 'b', estado: 'vigente' }]).ok && (elegirVersion([{ id: 'a', estado: 'borrador' }, { id: 'b', estado: 'vigente' }]) as { versionId: string }).versionId === 'b'
    && !elegirVersion([{ id: 'a', estado: 'vigente' }, { id: 'b', estado: 'vigente' }]).ok
    && !elegirVersion([{ id: 'a', estado: 'borrador' }, { id: 'b', estado: 'borrador' }]).ok
    && !elegirVersion([{ id: 'h', estado: 'historico' }]).ok,
    '1b. Versión: prefiere vigente; dos vigentes o dos borradores → ambigua; histórico nunca')
  const ctx3 = await resolverContextoCurricularGrupo(sb(cliente(baseCurricular())), 'grupo-3a')
  verificar(ctx3.ok && ctx3.contexto.curriculoGradoId === G3 && ctx3.contexto.curriculoFaseId === F4 && ctx3.contexto.gradoGrupo === '3' && ctx3.contexto.fallbackBorrador && ctx3.contexto.camposConCobertura.length === 2,
    '1c. 3.º de primaria ("3°") → grado 3, Fase 4, versión en borrador marcada como fallback')
  for (const [grupo, error, etiqueta] of [
    ['grupo-de-otro-docente', 'GRUPO_NO_ENCONTRADO', 'grupo de otro docente (RLS no lo devuelve)'],
    ['grupo-pre', 'GRADO_CURRICULAR_NO_ENCONTRADO', 'preescolar sin catálogo'],
    ['grupo-sec', 'GRADO_CURRICULAR_NO_ENCONTRADO', 'secundaria sin catálogo'],
    ['grupo-5c', 'COBERTURA_INCOMPLETA', 'grado con cobertura incompleta'],
  ] as const) {
    const r = await resolverContextoCurricularGrupo(sb(cliente(baseCurricular())), grupo)
    verificar(!r.ok && r.error === error, `1d. ${etiqueta} → ${error}, nunca un currículo parcial`)
  }
  if (!ctx3.ok) return finalizar()

  // 2. Catálogo cerrado del grupo.
  const catalogo = await recuperarCatalogoCurricularCerrado(sb(cliente(baseCurricular())), ctx3.contexto)
  const idsContenido = catalogo.contenidos.map((c) => c.id).sort()
  verificar(JSON.stringify(idsContenido) === JSON.stringify([U(1), U(2), U(3)]), '2a. Solo contenidos de la fase del grupo con PDA de su grado (sin el de otra fase ni el que solo tiene PDA de 4.º)')
  verificar(catalogo.pda.every((p) => [U(101), U(102), U(103)].includes(p.curriculoPdaGradoId)) && catalogo.pda.length === 3,
    '2b. PDA solo del grado 3; sin PDA de 4.º, sin PDA de texto vacío, sin PDA de contenidos de otra fase')

  // 3. Carga por fuente.
  const sinPa = await cargarCandidatosCurricularesGrupo(sb(cliente(baseCurricular())), 'grupo-3a')
  verificar(sinPa.ok && sinPa.fuente === 'catalogo_app' && sinPa.estadoVerificacion === 'pendiente_validacion_oficial' && sinPa.programaAnalitico === null && sinPa.programaAnaliticoNoUsado === null
    && sinPa.candidatos.length === 3 && sinPa.candidatos.every((c) => c.decision === null && c.estadoVerificacion === 'pendiente_validacion_oficial' && c.pda.length === 1),
    '3a. Sin Programa Analítico → catálogo de la app, pendiente de validación oficial')
  const vigente = await cargarCandidatosCurricularesGrupo(sb(cliente(baseCurricular('vigente'))), 'grupo-3a')
  verificar(vigente.ok && vigente.estadoVerificacion === 'oficial_vigente', '3b. Con versión curricular vigente → oficial_vigente')

  const basePa = cliente(conProgramaAnalitico(baseCurricular()))
  const conPa = await cargarCandidatosCurricularesGrupo(sb(basePa), 'grupo-4b')
  const ids = conPa.ok ? conPa.candidatos.map((c) => c.id).sort() : []
  verificar(conPa.ok && conPa.fuente === 'programa_analitico' && conPa.programaAnalitico?.versionId === 'pav-2' && JSON.stringify(ids) === JSON.stringify([U(201), U(202), U(203)]),
    '3c. PA vigente compatible → solo sus items de la versión vigente (ni versión anterior, ni otro grado, ni otra fase)')
  const porId = new Map((conPa.ok ? conPa.candidatos : []).map((c) => [c.id, c]))
  verificar(porId.get(U(203))?.decision === 'local' && porId.get(U(203))?.estadoVerificacion === 'local_del_docente' && porId.get(U(203))?.curriculoContenidoId === null && porId.get(U(203))?.pda.length === 0,
    '3d. Contenido local del PA: sin identidad curricular y sin PDA')
  verificar(porId.get(U(202))?.decision === 'contextualizado' && porId.get(U(202))?.textoContextualizado === 'Historias del barrio contadas por las familias'
    && JSON.stringify(porId.get(U(202))?.pda.map((p) => p.id)) === JSON.stringify([U(302)]),
    '3e. Contextualizado conserva su texto; solo PDA del grado del PA (sin el de 3.º)')
  verificar(JSON.stringify(porId.get(U(201))?.pda.map((p) => p.id)) === JSON.stringify([U(301)]), '3f. Relación PDA inconsistente se omite, nunca se aproxima')
  verificar(basePa.consultas <= 15, `3g. Consultas acotadas para cargar el PA (${basePa.consultas})`)

  const incompatible = await cargarCandidatosCurricularesGrupo(sb(cliente(conProgramaAnalitico(baseCurricular(), G3))), 'grupo-4b')
  verificar(incompatible.ok && incompatible.fuente === 'catalogo_app' && incompatible.programaAnaliticoNoUsado === 'PROGRAMA_ANALITICO_INCOMPATIBLE',
    '3h. PA construido sobre otro grado → no se usa; catálogo del grupo con el motivo registrado')
  const paSinVersion = await cargarCandidatosCurricularesGrupo(sb(cliente({ ...conProgramaAnalitico(baseCurricular()), programa_analitico: [{ id: 'pa-4b', grupo_id: 'grupo-4b', version_vigente_id: null }] })), 'grupo-4b')
  verificar(paSinVersion.ok && paSinVersion.fuente === 'catalogo_app' && paSinVersion.programaAnaliticoNoUsado === 'PROGRAMA_ANALITICO_SIN_VERSION_VIGENTE', '3i. PA sin versión vigente → catálogo, motivo registrado')
  const paAjeno = await cargarCandidatosCurricularesGrupo(sb(cliente(conProgramaAnalitico(baseCurricular()))), 'grupo-3a')
  verificar(paAjeno.ok && paAjeno.fuente === 'catalogo_app' && paAjeno.candidatos.every((c) => c.programaAnalitico === null), '3j. El PA de otro grupo nunca se usa para este grupo')
  for (const grupo of ['grupo-pre', 'grupo-sec']) {
    const r = await cargarCandidatosCurricularesGrupo(sb(cliente(baseCurricular())), grupo)
    verificar(!r.ok && r.motivo === 'GRADO_CURRICULAR_NO_ENCONTRADO', `3k. ${grupo}: sin cobertura → no disponible con motivo (la planeación no se bloquea aquí)`)
  }
  const vacio = await cargarCandidatosCurricularesGrupo(sb(cliente({ ...baseCurricular(), curriculo_pda_grado: [] })), 'grupo-3a')
  verificar(!vacio.ok && vacio.motivo === 'CATALOGO_VACIO', '3l. Catálogo sin contenidos con PDA → CATALOGO_VACIO')

  // 4. Resolución pura.
  const cands = sinPa.ok ? sinPa.candidatos : []
  const r1 = resolverCandidatosCurricularesPuro(cands, { tema: null, contenidoExplicito: 'narración de sucesos del pasado y del presente' })
  verificar(r1.estado === 'resuelto' && r1.nivel === 1 && r1.candidatos[0]?.id === U(1) && r1.referenciasDocente.length === 0, '4a. Contenido explícito exacto (sin acentos/mayúsculas) → resuelto')
  const r2 = resolverCandidatosCurricularesPuro(cands, { tema: null, pdaExplicito: 'Describe una alimentación saludable con base en el plato del bien comer' })
  verificar(r2.estado === 'resuelto' && r2.candidatos[0]?.id === U(3), '4b. PDA explícito exacto → resuelto')
  const r3 = resolverCandidatosCurricularesPuro(cands, { tema: 'el cuidado del cuerpo humano' })
  verificar(r3.estado === 'resuelto' && r3.nivel === 2 && r3.candidatos[0]?.id === U(2), '4c. Tema con coincidencia fuerte única → resuelto')
  const r4 = resolverCandidatosCurricularesPuro(cands, { tema: 'robótica espacial cuántica' })
  verificar(r4.estado === 'sin_correspondencia' && r4.candidatos.length === 0, '4d. Tema sin coincidencia → sin correspondencia, nunca se fuerza')
  const r5 = resolverCandidatosCurricularesPuro(cands, { tema: 'alimentación', contenidoExplicito: 'Educación financiera para niños' })
  verificar(r5.referenciasDocente.length === 1 && r5.referenciasDocente[0].tipo === 'contenido' && r5.referenciasDocente[0].texto === 'Educación financiera para niños' && r5.candidatos[0]?.id === U(3),
    '4e. Contenido del docente sin correspondencia → se conserva literal; el tema sigue resolviendo')
  const r6 = resolverCandidatosCurricularesPuro(cands, { tema: null })
  verificar(r6.estado === 'sin_correspondencia' && r6.nivel === 4, '4f. Sin tema ni referencias → sin correspondencia')

  // 5. Contexto para el prompt: referencias cortas, nunca UUID.
  const ctxA = await prepararContextoCurricularPlaneacion(sb(cliente(baseCurricular())), 'grupo-3a', { tema: 'el cuidado del cuerpo humano' })
  const pA = ctxA.paraPrompt
  verificar(pA.disponible && pA.modo === 'A' && ctxA.candidatosOfrecidos.length === 1 && pA.candidatosCerrados[0].pda.length === 1 && pA.candidatosCerrados[0].texto === ctxA.candidatosOfrecidos[0].tituloContenido
    && pA.fuente === 'catalogo_app' && pA.estadoVerificacion === 'pendiente_validacion_oficial' && pA.rotuloFuente === ROTULO_PENDIENTE_VALIDACION,
    '5a. Modo A: solo los candidatos resueltos, con su texto, sus PDA reales, fuente, estado y rótulo')
  const ctxB = await prepararContextoCurricularPlaneacion(sb(cliente(baseCurricular())), 'grupo-3a', { tema: 'robótica espacial' })
  const pB = ctxB.paraPrompt
  verificar(pB.disponible && pB.modo === 'B' && pB.catalogoPorCampo.length === 2 && pB.catalogoPorCampo.flatMap((g) => g.contenidos).length === 3 && !pB.catalogoRecortado
    && pB.catalogoPorCampo.every((g) => g.contenidos.every((i) => Object.keys(i).join() === 'texto')) && ctxB.candidatosOfrecidos.length === 3 && ctxB.candidatosGrupo.length === 3,
    '5b. Modo B: catálogo del grupo agrupado por campo (solo texto), sin PDA, identificadores ni metadatos')
  const REGEX_UUID_EN_TEXTO = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  verificar(!REGEX_UUID_EN_TEXTO.test(JSON.stringify(pA)) && !REGEX_UUID_EN_TEXTO.test(JSON.stringify(pB)) && !JSON.stringify(pB).includes('grado-3'),
    '5c. Ningún identificador (UUID ni id interno) viaja al prompt (modos A y B)')
  const ctxLocal = await prepararContextoCurricularPlaneacion(sb(cliente(conProgramaAnalitico(baseCurricular()))), 'grupo-4b', { tema: 'robótica espacial' })
  const pL = ctxLocal.paraPrompt
  verificar(pL.disponible && pL.modo === 'B' && pL.fuente === 'programa_analitico' && pL.catalogoPorCampo.some((g) => g.contenidos.some((i) => i.texto === '[LOCAL] Huerto escolar de la comunidad')),
    '5d. PA: un contenido local se distingue con "[LOCAL]"')
  const ctxSec = await prepararContextoCurricularPlaneacion(sb(cliente(baseCurricular())), 'grupo-sec', { tema: 'fracciones', contenidoExplicito: 'Fracciones equivalentes' })
  const pS = ctxSec.paraPrompt
  verificar(!pS.disponible && pS.motivo === 'GRADO_CURRICULAR_NO_ENCONTRADO' && pS.referenciasDocente[0]?.texto === 'Fracciones equivalentes' && pS.rotuloFuente === ROTULO_PROPUESTA_NO_VERIFICADA && ctxSec.candidatosOfrecidos.length === 0,
    '5e. Secundaria sin catálogo: propuesta no verificada, con el contenido del docente literal')
  const citado = await prepararContextoCurricularPlaneacion(sb(cliente(baseCurricular())), 'grupo-3a', { tema: 'proyecto integrador', mensajeDocente: 'Quiero trabajar el contenido "Alimentación saludable y plato del bien comer" con mi grupo' })
  verificar(citado.paraPrompt.disponible && citado.paraPrompt.modo === 'A' && citado.candidatosOfrecidos.map((c) => c.id).join() === U(3) && citado.candidatosGrupo.length === 3,
    '5f. Contenido del catálogo citado literalmente por el docente → se usa ese, aunque el tema no coincida')
  const campoNombrado = await prepararContextoCurricularPlaneacion(sb(cliente(baseCurricular())), 'grupo-3a', { tema: 'robótica espacial', mensajeDocente: 'del campo Saberes y pensamiento científico' })
  verificar(campoNombrado.paraPrompt.disponible && campoNombrado.paraPrompt.modo === 'B' && campoNombrado.candidatosOfrecidos.every((c) => c.campoFormativo?.id === 'campo-sab') && campoNombrado.candidatosOfrecidos.length === 2,
    '5g. Campo formativo nombrado por el docente → catálogo acotado a ese campo')
  const pocos = construirCatalogoPorCampo(cands, 'cuerpo humano', 100)
  verificar(pocos.recortado && pocos.incluidos.length === 1 && pocos.incluidos[0].id === U(2), '5h. Presupuesto excedido → recorte determinista, primero lo más relacionado con el tema, marcado como recortado')
  verificar(JSON.stringify(construirCatalogoPorCampo(cands, null)) === JSON.stringify(construirCatalogoPorCampo([...cands].reverse(), null)), '5i. El catálogo es determinista: no depende del orden de carga')

  // 6. Validación de identificadores internos y reconocimiento por texto.
  const ofrecidos = ctxA.candidatosOfrecidos
  const v1 = validarSeleccionCurricular(ofrecidos, [U(2), U(2).toUpperCase(), ' ', U(1), U(777), 'contenido-1'])
  verificar(v1.aceptados.length === 1 && v1.aceptados[0].id === U(2), '6a. Solo se acepta el id ofrecido (también en mayúsculas, sin duplicar)')
  verificar(v1.rechazados.some((r) => r.idPropuesto === U(1) && r.motivo === 'NO_OFRECIDO'), '6b. Id real del catálogo pero NO ofrecido → rechazado')
  verificar(v1.rechazados.some((r) => r.idPropuesto === U(777) && r.motivo === 'NO_OFRECIDO') && v1.rechazados.some((r) => r.idPropuesto === 'contenido-1' && r.motivo === 'UUID_INVALIDO'),
    '6c. UUID inventado → NO_OFRECIDO; texto que no es UUID → UUID_INVALIDO')
  const rt = reconocerCandidatosPorTexto(cands, [
    { tipo: 'contenido', texto: 'CUERPO HUMANO estructura externa acciones para su cuidado' },
    { tipo: 'contenido', texto: 'Cuerpo humano' },
    { tipo: 'pda', texto: 'Reconoce la estructura externa del cuerpo humano y acciones para cuidarlo' },
    { tipo: 'pda', texto: 'Describe una alimentación saludable con base en el plato del bien comer.' },
    { tipo: 'contenido', texto: 'Contenido exclusivo de la Fase 5' },
  ])
  verificar(rt.aceptados.map((c) => c.id).join() === U(2), '6d. Por texto: solo coincidencia EXACTA normalizada (sin acentos, mayúsculas ni puntuación); nunca por parecido')
  verificar(JSON.stringify(rt.noReconocidas.map((e) => e.texto)) === JSON.stringify(['Cuerpo humano', 'Describe una alimentación saludable con base en el plato del bien comer.', 'Contenido exclusivo de la Fase 5']),
    '6e. Un PDA solo cuenta si es de un contenido reconocido; un texto de otra fase o un fragmento quedan sin reconocer')
  const ofrecidos4b = conPa.ok ? conPa.candidatos : []
  verificar(validarSeleccionCurricular(ofrecidos4b, [U(204), U(205), U(206), U(2)]).aceptados.length === 0,
    '6f. Ids de la versión anterior del PA, de otro grado, de otra fase o de otro grupo → todos rechazados')
  const item202 = porId.get(U(202))!
  const vp = validarPdaDeItemCurricular(item202, [U(302), U(303), U(101)])
  verificar(vp.aceptados.length === 1 && vp.aceptados[0].id === U(302) && vp.rechazados.length === 2, '6g. PDA: solo los reales del contenido aceptado')

  // 7. Identidad visible.
  const idCat = construirIdentidadCurricularVisible(v1.aceptados, [{ tipo: 'contenido', texto: 'Educación financiera para niños' }])!
  const bloqueCat = renderizarBloqueIdentidadCurricularVisible(idCat)
  verificar(bloqueCat.includes(`Fuente: ${ROTULO_PENDIENTE_VALIDACION}`) && !bloqueCat.includes(ROTULO_OFICIAL_VIGENTE) && !/OFICIAL VALIDADA|oficiales:/i.test(bloqueCat),
    '7a. Catálogo en borrador → "Catálogo curricular de la app — pendiente de validación oficial", nunca "oficial"')
  verificar(bloqueCat.includes('Contenidos de referencia: Cuerpo humano: estructura externa, acciones para su cuidado') && bloqueCat.includes('PDA de referencia: Reconoce la estructura externa')
    && bloqueCat.includes('Contenidos indicados por el docente: Educación financiera para niños'),
    '7b. Textos literales del catálogo y lo indicado por el docente, por separado')
  verificar(!/^(Contenidos|PDA):/m.test(bloqueCat), '7c. Las etiquetas nunca coinciden con "Contenidos:"/"PDA:" del bloque de resumen')
  const bloquePa = renderizarBloqueIdentidadCurricularVisible(construirIdentidadCurricularVisible([porId.get(U(202))!, porId.get(U(203))!])!)
  verificar(bloquePa.includes(`Fuente: Programa Analítico del grupo (con base en: ${ROTULO_PENDIENTE_VALIDACION})`) && bloquePa.includes('Contenidos de referencia: Historias del barrio contadas por las familias')
    && bloquePa.includes('Contenidos propios del Programa Analítico: Huerto escolar de la comunidad'),
    '7d. PA: fuente PA con su base pendiente; contextualizado y local diferenciados')
  const idVigente = construirIdentidadCurricularVisible(vigente.ok ? vigente.candidatos.slice(0, 1) : [])!
  verificar(renderizarBloqueIdentidadCurricularVisible(idVigente).includes(`Fuente: ${ROTULO_OFICIAL_VIGENTE}`), '7e. Solo una versión vigente se rotula como oficial vigente')
  const soloDocente = construirIdentidadCurricularVisible([], [{ tipo: 'pda', texto: 'Resuelve problemas con fracciones' }])!
  const bloqueDocente = renderizarBloqueIdentidadCurricularVisible(soloDocente)
  verificar(!bloqueDocente.includes('Fuente:') && bloqueDocente.includes('PDA indicados por el docente: Resuelve problemas con fracciones'), '7f. Solo datos del docente: sin atribuirlos a ningún programa')
  verificar(construirIdentidadCurricularVisible([], []) === null, '7g. Sin nada validado ni indicado → sin sección (nunca vacía ni inventada)')

  const BORRADOR = `📋 PLANEACIÓN: El cuerpo humano\n\nSecuencia didáctica...\n\n${ETIQUETA_INICIO_BLOQUE}\nNombre: El cuerpo humano\nContenidos: paráfrasis del modelo\nPDA: otra paráfrasis\n`
  const insertado = insertarIdentidadCurricularVisibleEnBorrador(BORRADOR, idCat)
  verificar(insertado.indexOf('📌 CONTENIDOS Y PDA') > 0 && insertado.indexOf('📌 CONTENIDOS Y PDA') < insertado.indexOf(ETIQUETA_INICIO_BLOQUE) && insertado.endsWith(BORRADOR.slice(BORRADOR.indexOf(ETIQUETA_INICIO_BLOQUE))),
    '7h. La sección se inserta justo antes del bloque de resumen, sin tocarlo')
  verificar(insertarIdentidadCurricularVisibleEnBorrador('Texto sin resumen', idCat) === 'Texto sin resumen' && insertarIdentidadCurricularVisibleEnBorrador(BORRADOR, null) === BORRADOR,
    '7i. Sin marcador o sin identidad → texto intacto')
  const sustituido = sustituirContenidosYPdaEnBloqueResumen(insertado, idCat)
  verificar(sustituido.includes('Contenidos: Cuerpo humano: estructura externa, acciones para su cuidado; Educación financiera para niños') && sustituido.includes('PDA: Reconoce la estructura externa')
    && !sustituido.includes('paráfrasis del modelo') && sustituido.slice(0, sustituido.indexOf(ETIQUETA_INICIO_BLOQUE)) === insertado.slice(0, insertado.indexOf(ETIQUETA_INICIO_BLOQUE)),
    '7j. El resumen guarda exactamente lo validado y lo del docente; nada antes del marcador cambia')
  const conDolar = construirIdentidadCurricularVisible([], [{ tipo: 'contenido', texto: 'Costos de $25 y $& en la tienda' }])!
  verificar(sustituirContenidosYPdaEnBloqueResumen(BORRADOR, conDolar).includes('Contenidos: Costos de $25 y $& en la tienda'), '7k. Un "$" en el texto nunca se interpreta como patrón de reemplazo')
  verificar(sustituirContenidosYPdaEnBloqueResumen(sustituido, idCat) === sustituido, '7l. Sustituir el resumen es idempotente')

  // 8. Contenidos locales del PA reconocidos por su texto propio.
  const pa4b = conPa.ok ? conPa.candidatos : []
  const rl = reconocerCandidatosPorTexto(pa4b, [{ tipo: 'contenido', texto: 'Huerto escolar de la comunidad' }, { tipo: 'contenido', texto: 'Historias del barrio contadas por las familias' }])
  verificar(rl.aceptados.map((c) => c.decision).join() === 'local,contextualizado' && rl.noReconocidas.length === 0, '8a. PA: local y contextualizado se reconocen por su propio texto')

  finalizar()
}

function finalizar() {
  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} verificación(es) fallaron`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
