// scripts/verificar-borrador-curricular-servidor.ts
//
// Hito 1, Parte 2 — sección curricular del borrador construida por el
// servidor al terminar el streaming (completarBorradorCurricular): PDA
// reales también en modo B, reconocimiento por texto exacto contra el
// catálogo del grupo (nunca identificadores del modelo o del cliente),
// datos del docente literales, propuestas no verificadas, ningún dato
// técnico visible, cierre único, sin duplicados en el documento, y la
// misma regla que aplicará la aprobación (Parte 3).
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-borrador-curricular-servidor.ts`.

import type { SupabaseClient } from '@supabase/supabase-js'
import { prepararContextoCurricularPlaneacion } from '../lib/planeacion/resolverCurricularPlaneacion'
import { completarBorradorCurricular, entradasCurricularesDelResumen, PREGUNTA_CIERRE_BORRADOR } from '../lib/planeacion/completarBorradorCurricular'
import { reconocerCandidatosPorTexto } from '../lib/planeacion/validarSeleccionCurricularPlaneacion'
import { ETIQUETA_INICIO_BLOQUE, extraerResumenBorrador, extraerTextoCompletoBorrador, seleccionarBorradorVigente } from '../lib/planeacion/extraerBorrador'
import { construirIdentidadCurricularVisible, ENCABEZADO_IDENTIDAD_VISIBLE, ROTULO_PENDIENTE_VALIDACION, ROTULO_PROPUESTA_NO_VERIFICADA } from '../lib/planeacion/identidadCurricularVisibleBorrador'
import { baseCurricular, conProgramaAnalitico } from './fixtures/curriculoPlaneacionFicticio'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

type Fila = Record<string, unknown>
class Consulta {
  private filtros: ((f: Fila) => boolean)[] = []
  constructor(private tablas: Record<string, Fila[]>, private tabla: string) {}
  select() { return this }
  eq(col: string, val: unknown) { this.filtros.push((f) => f[col] === val); return this }
  in(col: string, vals: unknown[]) { this.filtros.push((f) => vals.includes(f[col])); return this }
  private filas() { return (this.tablas[this.tabla] ?? []).filter((f) => this.filtros.every((p) => p(f))) }
  maybeSingle() { return Promise.resolve({ data: this.filas()[0] ?? null, error: null }) }
  then<T>(ok: (v: { data: Fila[]; error: null }) => T) { return Promise.resolve({ data: this.filas(), error: null }).then(ok) }
}
const sb = (tablas: Record<string, Fila[]>) => ({ from: (t: string) => new Consulta(tablas, t) }) as unknown as SupabaseClient

const PDA_CUERPO = 'Reconoce la estructura externa del cuerpo humano y acciones para cuidarlo.'
const PDA_ALIMENTACION = 'Describe una alimentación saludable con base en el plato del bien comer.'

function borrador(lineas: { contenidos: string; pda: string; proposito?: string }, cierre = ''): string {
  return [
    '📋 PLANEACIÓN: Cuidamos nuestro cuerpo',
    '',
    'Día 1: Inicio, desarrollo y cierre...',
    '',
    ETIQUETA_INICIO_BLOQUE,
    'Nombre: Cuidamos nuestro cuerpo',
    'Grupo: 3° A',
    'Fecha de inicio: 2026-08-10',
    'Fecha de fin: 2026-08-14',
    'Duración: 5 días efectivos',
    'Campos formativos: Saberes y pensamiento científico',
    ...(lineas.proposito ? [`Propósito: ${lineas.proposito}`] : []),
    `Contenidos: ${lineas.contenidos}`,
    `PDA: ${lineas.pda}`,
    'Indicadores de evaluación: i1; i2; i3; i4; i5',
    cierre,
  ].join('\n').trimEnd()
}

const TITULO_CUERPO = 'Cuerpo humano: estructura externa, acciones para su cuidado'
const TITULO_ALIMENTACION = 'Alimentación saludable y plato del bien comer'
const TITULO_NARRACION = 'Narración de sucesos del pasado y del presente'
const ocurrencias = (texto: string, buscado: string) => texto.split(buscado).length - 1
const REGEX_TECNICO = /\bC-[0-9A-Z]{7}\b|sello|Verificaci[oó]n curricular|REFERENCIAS_CURRICULARES|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i

async function main() {
  const base = baseCurricular()
  const ctxB = await prepararContextoCurricularPlaneacion(sb(base), 'grupo-3a', { tema: 'robótica espacial' })
  const ctxA = await prepararContextoCurricularPlaneacion(sb(base), 'grupo-3a', { tema: 'el cuidado del cuerpo humano' })

  // 1. Modo B: el servidor resuelve los PDA reales de lo elegido.
  const textoB = borrador({ contenidos: `${TITULO_CUERPO}; ${TITULO_ALIMENTACION}`, pda: 'ninguno' })
  const b = completarBorradorCurricular({ textoModelo: textoB, curricular: ctxB, textosDocente: ['Hazme una planeación sobre el cuerpo'] })!
  verificar(!!b && b.bloqueServidor.includes(`PDA de referencia: ${PDA_CUERPO} · ${PDA_ALIMENTACION}`) && !/se incorporan/i.test(b.bloqueServidor),
    '1a. Modo B: el borrador muestra los PDA reales de los contenidos elegidos (nunca "se incorporan al aprobar")')
  verificar(b.bloqueServidor.includes(`Fuente: ${ROTULO_PENDIENTE_VALIDACION}`) && !/\bSEP\b|oficial vigente/i.test(b.bloqueServidor), '1b. Fuente "pendiente de validación oficial", sin atribución a la SEP')
  verificar(!b.bloqueServidor.includes('Propuesta') && !b.bloqueServidor.includes('indicados por el docente'), '1c. Los contenidos copiados del catálogo no se duplican como propuesta ni como del docente')
  verificar(!REGEX_TECNICO.test(b.bloqueServidor) && !REGEX_TECNICO.test(b.textoParaVistaPrevia), '1d. Ningún identificador, código, sello ni dato técnico en lo que ve el docente ni en el documento')
  const mensajeFinal = textoB + b.bloqueServidor
  verificar(ocurrencias(mensajeFinal, '¿Deseas corregir algo o aprobarla') === 1 && mensajeFinal.trimEnd().endsWith(PREGUNTA_CIERRE_BORRADOR), '1e. La pregunta de cierre aparece una sola vez, al final')
  const previa = extraerTextoCompletoBorrador(b.textoParaVistaPrevia)
  verificar(previa.includes(PDA_CUERPO) && ocurrencias(previa, ENCABEZADO_IDENTIDAD_VISIBLE) === 1 && ocurrencias(previa, PDA_CUERPO) === 1 && previa.indexOf(ENCABEZADO_IDENTIDAD_VISIBLE) > previa.indexOf('Día 1') && !previa.includes('¿'),
    '1f. Vista previa (Word/PDF): la sección con PDA reales aparece una sola vez, sin resumen ni pregunta')
  verificar(ocurrencias(mensajeFinal, ENCABEZADO_IDENTIDAD_VISIBLE) === 1 && ocurrencias(mensajeFinal, `PDA de referencia:`) === 1, '1g. En el chat, la sección curricular aparece una sola vez')

  // 2. Reconocimiento por texto contra el catálogo del grupo (base de datos).
  const textoA = borrador({ contenidos: `${TITULO_CUERPO}; ${TITULO_NARRACION}; Cuerpo humano y su cuidado`, pda: PDA_CUERPO })
  const a = completarBorradorCurricular({ textoModelo: textoA, curricular: ctxA, textosDocente: [] })!
  verificar(a.identidad?.contenidos.join(' | ') === `${TITULO_CUERPO} | ${TITULO_NARRACION}` && a.identidad?.propuestas.map((p) => p.texto).join() === 'Cuerpo humano y su cuidado',
    '2a. Un texto idéntico a un contenido del catálogo del grupo se reconoce; una paráfrasis queda como propuesta no verificada')
  const sinCatalogo = completarBorradorCurricular({ textoModelo: textoA, curricular: { ...ctxA, candidatosGrupo: [] }, textosDocente: [] })!
  verificar(sinCatalogo.identidad?.contenidos.length === 0 && sinCatalogo.identidad?.propuestas.length === 4 && !sinCatalogo.bloqueServidor.includes('Fuente:'),
    '2b. Sin catálogo cargado nada se marca como del catálogo (todo es propuesta no verificada)')
  const otroGrado = completarBorradorCurricular({ textoModelo: borrador({ contenidos: 'Leyendas y mitos de la comunidad; Contenido exclusivo de la Fase 5', pda: 'ninguno' }), curricular: ctxA, textosDocente: [] })!
  verificar(otroGrado.identidad?.contenidos.length === 0 && otroGrado.identidad?.propuestas.length === 2, '2c. Contenidos reales pero de otro grado o de otra fase nunca se reconocen para este grupo')

  // 3. Datos del docente: literales, nunca sustituidos ni atribuidos.
  const textoDocente = borrador({ contenidos: `${TITULO_CUERPO}; Educación financiera para niños (indicado por el docente); Hábitos de higiene en casa`, pda: 'Explica cómo ahorra su familia' })
  const d = completarBorradorCurricular({ textoModelo: textoDocente, curricular: ctxA, textosDocente: ['Incluye el contenido "Educación financiera para niños" y el PDA Explica cómo ahorra su familia'] })!
  verificar(d.bloqueServidor.includes('Contenidos indicados por el docente: Educación financiera para niños') && d.bloqueServidor.includes('PDA indicados por el docente: Explica cómo ahorra su familia'),
    '3a. Lo que el docente escribió se conserva literal y como suyo')
  verificar(d.bloqueServidor.includes(`${ROTULO_PROPUESTA_NO_VERIFICADA}:`) && d.bloqueServidor.includes('Contenidos propuestos: Hábitos de higiene en casa') && d.identidad?.contenidos.join() === TITULO_CUERPO,
    '3b. Lo que el modelo añadió sin respaldo queda como propuesta; lo del catálogo, como catálogo')
  const edicion = completarBorradorCurricular({ textoModelo: textoDocente, curricular: ctxA, textosDocente: [`Corrige esto:\n${textoDocente}`] })!
  verificar(!edicion.bloqueServidor.includes('indicados por el docente'), '3c. Un mensaje que reenvía el borrador (edición) no cuenta como texto del docente')

  // 4. Sin cobertura: propuesta no verificada, sin bloquear.
  const sinCobertura = await prepararContextoCurricularPlaneacion(sb(base), 'grupo-sec', { tema: 'fracciones' })
  const s = completarBorradorCurricular({ textoModelo: borrador({ contenidos: 'Fracciones equivalentes', pda: 'Compara fracciones con material concreto' }), curricular: sinCobertura, textosDocente: [] })!
  verificar(s.bloqueServidor.includes(`${ROTULO_PROPUESTA_NO_VERIFICADA}:`) && s.bloqueServidor.includes('Contenidos propuestos: Fracciones equivalentes') && s.bloqueServidor.includes('PDA propuestos: Compara fracciones') && !s.bloqueServidor.includes('Fuente:'),
    '4a. Secundaria sin catálogo: contenidos y PDA como propuesta no verificada')

  // 5. Programa Analítico.
  const ctxPa = await prepararContextoCurricularPlaneacion(sb(conProgramaAnalitico(base)), 'grupo-4b', { tema: 'historias del barrio' })
  const p = completarBorradorCurricular({ textoModelo: borrador({ contenidos: 'Historias del barrio contadas por las familias; Huerto escolar de la comunidad', pda: 'ninguno' }), curricular: ctxPa, textosDocente: [] })!
  verificar(p.bloqueServidor.includes('Fuente: Programa Analítico del grupo') && p.bloqueServidor.includes('PDA de referencia: Narra sucesos (versión de 4.º).') && p.bloqueServidor.includes('Contenidos propios del Programa Analítico: Huerto escolar de la comunidad'),
    '5a. PA compatible: fuente PA, PDA reales del grado del PA y contenido local diferenciado')

  // 6. Cierre único y compatibilidad con el flujo actual.
  const conPregunta = completarBorradorCurricular({ textoModelo: `${textoB}\n\n¿Quieres cambiar algo?`, curricular: ctxB, textosDocente: [] })!
  verificar(!conPregunta.bloqueServidor.includes(PREGUNTA_CIERRE_BORRADOR), '6a. Si el modelo ya cerró con una pregunta, no se añade otra')
  const preguntaAntes = completarBorradorCurricular({ textoModelo: `Ya preparé la planeación. ¿Deseas corregir algo o aprobarla para guardarla?\n\n${textoB}`, curricular: ctxB, textosDocente: [] })!
  verificar(!preguntaAntes.bloqueServidor.includes(PREGUNTA_CIERRE_BORRADOR), '6b. Si el modelo escribió la pregunta de aprobación en otra parte, tampoco se duplica')
  const propositoPregunta = completarBorradorCurricular({ textoModelo: borrador({ contenidos: TITULO_CUERPO, pda: 'ninguno', proposito: '¿Cómo cuidamos nuestro cuerpo? Reconocer hábitos.' }), curricular: ctxA, textosDocente: [] })!
  verificar(ocurrencias(propositoPregunta.bloqueServidor, PREGUNTA_CIERRE_BORRADOR) === 1, '6c. Una pregunta dentro de una línea del resumen (Propósito) no cuenta como cierre')
  verificar(completarBorradorCurricular({ textoModelo: 'Hay un conflicto de fechas: ¿qué día prefieres?', curricular: ctxB, textosDocente: [] }) === null, '6d. Sin borrador completo (conflicto) no se añade nada')
  const resumenFinal = extraerResumenBorrador([{ role: 'assistant', content: mensajeFinal }])
  verificar(resumenFinal?.contenidos.length === 2 && resumenFinal.pda.join() === 'ninguno' && resumenFinal.indicadores.length === 5 && resumenFinal.nombre === 'Cuidamos nuestro cuerpo',
    '6e. El mensaje guardado (modelo + sección del servidor) conserva el mismo resumen para la aprobación actual')
  verificar(seleccionarBorradorVigente([{ role: 'user', content: 'Planeación del cuerpo' }, { role: 'assistant', content: mensajeFinal }]).estado === 'listo', '6f. seleccionarBorradorVigente sigue reconociendo el borrador')
  verificar(JSON.stringify(completarBorradorCurricular({ textoModelo: textoB, curricular: ctxB, textosDocente: [] })) === JSON.stringify(completarBorradorCurricular({ textoModelo: textoB, curricular: ctxB, textosDocente: [] })),
    '6g. Determinista: mismo turno, mismo resultado')

  // 7. Corrección que copia la sección del turno anterior: nunca duplicada.
  const correccion = textoB.replace('Día 1: Inicio, desarrollo y cierre...', `Día 1: Inicio, desarrollo y cierre...\n\n${b.bloqueServidor.trim().split('\n\n')[0]}`)
  const c = completarBorradorCurricular({ textoModelo: correccion, curricular: ctxB, textosDocente: [] })!
  const previaCorreccion = extraerTextoCompletoBorrador(c.textoParaVistaPrevia)
  verificar(ocurrencias(previaCorreccion, ENCABEZADO_IDENTIDAD_VISIBLE) === 1 && ocurrencias(previaCorreccion, PDA_CUERPO) === 1 && previaCorreccion.includes('Día 1'),
    '7a. Si el modelo copia la sección anterior, el documento la contiene una sola vez (la del servidor)')

  // 8. Contrato de la aprobación (Parte 3): misma regla sobre el texto del
  //    borrador vigente, con el catálogo recargado de la base de datos.
  const recargado = await prepararContextoCurricularPlaneacion(sb(base), 'grupo-3a', { tema: null })
  const entradas = entradasCurricularesDelResumen(resumenFinal!.contenidos, resumenFinal!.pda)
  const enAprobacion = reconocerCandidatosPorTexto(recargado.candidatosGrupo, entradas)
  const identidadAprobacion = construirIdentidadCurricularVisible(enAprobacion.aceptados, [], [])
  verificar(JSON.stringify(identidadAprobacion?.pda) === JSON.stringify(b.identidad?.pda) && JSON.stringify(identidadAprobacion?.contenidos) === JSON.stringify(b.identidad?.contenidos),
    '8a. Aplicar la misma regla al aprobar reproduce exactamente la sección que vio el docente')
  const manipulado = mensajeFinal.replace(`Contenidos: ${TITULO_CUERPO}; ${TITULO_ALIMENTACION}`, `Contenidos: ${TITULO_CUERPO}; Educación sexual integral avanzada`)
  const rm = reconocerCandidatosPorTexto(recargado.candidatosGrupo, entradasCurricularesDelResumen(extraerResumenBorrador([{ role: 'assistant', content: manipulado }])!.contenidos, []))
  verificar(rm.aceptados.map((x) => x.tituloContenido).join() === TITULO_CUERPO && rm.noReconocidas.map((x) => x.texto).join() === 'Educación sexual integral avanzada',
    '8b. Un texto alterado en el historial nunca se vuelve "del catálogo" si no existe en el catálogo del grupo')

  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} verificación(es) fallaron`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
