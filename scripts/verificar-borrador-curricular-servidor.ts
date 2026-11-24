// scripts/verificar-borrador-curricular-servidor.ts
//
// Hito 1 — sección curricular del borrador construida por el servidor al
// terminar el streaming (completarBorradorCurricular) y normalización
// única (normalizarSeccionCurricular): PDA reales también en modo B,
// reconocimiento por texto exacto contra el catálogo del grupo, datos del
// docente literales, propuestas no verificadas, ningún dato técnico
// visible, cierre único, UNA sola sección curricular (sin las del modelo)
// en listas, después del propósito, idempotente, y el mismo texto en Chat,
// vista previa, documento definitivo e Historial. Caso de regresión: la
// estructura de la planeación «Las Leyendas de Nuestra Comunidad» (E2E).
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-borrador-curricular-servidor.ts`.

import type { SupabaseClient } from '@supabase/supabase-js'
import { prepararContextoCurricularPlaneacion, cargarCandidatosCurricularesGrupo } from '../lib/planeacion/resolverCurricularPlaneacion'
import { completarBorradorCurricular, PREGUNTA_CIERRE_BORRADOR } from '../lib/planeacion/completarBorradorCurricular'
import { decidirCurricularAprobacion, pdaRevisadosEnSeccion } from '../lib/planeacion/curricularAprobacion'
import { ETIQUETA_INICIO_BLOQUE, extraerResumenBorrador, extraerTextoCompletoBorrador, seleccionarBorradorVigente } from '../lib/planeacion/extraerBorrador'
import { construirIdentidadCurricularVisible, normalizarSeccionCurricular, ENCABEZADO_IDENTIDAD_VISIBLE, ROTULO_PENDIENTE_VALIDACION, ROTULO_PROPUESTA_NO_VERIFICADA } from '../lib/planeacion/identidadCurricularVisibleBorrador'
import { extraerTextoFinal } from '../lib/asistente/textoFinalChat'
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

const TITULO_CUERPO = 'Cuerpo humano: estructura externa, acciones para su cuidado'
const TITULO_ALIMENTACION = 'Alimentación saludable y plato del bien comer'
const PDA_CUERPO = 'Reconoce la estructura externa del cuerpo humano y acciones para cuidarlo.'
const PDA_ALIMENTACION = 'Describe una alimentación saludable con base en el plato del bien comer.'
const ocurrencias = (texto: string, buscado: string) => texto.split(buscado).length - 1
const REGEX_TECNICO = /\bC-[0-9A-Z]{7}\b|sello|REFERENCIAS_CURRICULARES|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i

function resumen(contenidos: string, pda: string): string {
  return [
    ETIQUETA_INICIO_BLOQUE,
    'Nombre: Las Leyendas de Nuestra Comunidad',
    'Grupo: 3° A',
    'Periodo de evaluación: sin periodo configurado',
    'Fecha de inicio: 2026-11-23',
    'Fecha de fin: 2026-12-04',
    'Duración: 10 días efectivos',
    'Campos formativos: Lenguajes',
    `Contenidos: ${contenidos}`,
    `PDA: ${pda}`,
    'Indicadores de evaluación: i1; i2; i3; i4; i5',
  ].join('\n')
}

// Estructura observada en la planeación de leyendas (E2E): sección de PDA
// redactada por el modelo entre el propósito y los materiales.
function cuerpoLeyendas(seccionModelo: string): string {
  return [
    '📋 PLANEACIÓN DIDÁCTICA',
    'Fase: Fase 4 (3° y 4° de primaria)',
    'Campo Formativo: Lenguajes',
    '',
    '🎯 PROPÓSITO GENERAL',
    'Que las niñas y los niños conozcan, narren y recreen leyendas de su comunidad.',
    '',
    seccionModelo,
    '',
    '🧰 MATERIALES',
    '- Libros de texto de la SEP (Proyectos Escolares y de Aula)',
    '- Cartulinas o papel bond',
    '',
    '📅 DÍA 1 — ¿Qué es una leyenda? Explorando lo que ya sabemos',
    '🔹 Inicio (15 min)',
    'Los alumnos revisan con el docente los contenidos del proyecto y comentan qué es el PDA del día.',
    'Contenido: leyendas de la región contadas por las familias.',
    '🔻 Cierre (10 min)',
    '📌 Evaluación: Participación oral y organizador en cuaderno.',
    '',
    '🎓 PRODUCTO FINAL',
    'Antología ilustrada de leyendas del grupo.',
  ].join('\n')
}
const SECCION_PDA_MODELO = ['📚 PROCESOS DE DESARROLLO DE APRENDIZAJE (PDA)', `- ${PDA_CUERPO}`, '- Aprecia el uso intencional de formas y colores en leyendas.'].join('\n')
const lineasLegitimas = (t: string) => t.split('\n').filter((l) => /SEP|Cartulinas|DÍA 1|Inicio \(15|revisan con el docente|Contenido: leyendas|Cierre \(10|Evaluación: Participación|PRODUCTO FINAL|Antología|PROPÓSITO|Que las niñas|Campo Formativo|Fase: Fase 4/.test(l))

async function main() {
  const base = baseCurricular()
  const ctxA = await prepararContextoCurricularPlaneacion(sb(base), 'grupo-3a', { tema: 'el cuidado del cuerpo humano' })
  const ctxB = await prepararContextoCurricularPlaneacion(sb(base), 'grupo-3a', { tema: 'robótica espacial' })

  // 1. Regresión «leyendas»: una sola sección curricular, en su lugar.
  const modelo = `${cuerpoLeyendas(SECCION_PDA_MODELO)}\n\n${resumen(TITULO_CUERPO, PDA_CUERPO)}`
  const c = completarBorradorCurricular({ textoModelo: modelo, curricular: ctxA, textosDocente: ['Planeación de leyendas'] })!
  const cuerpo = extraerTextoCompletoBorrador(c.textoFinal)
  verificar(ocurrencias(cuerpo, 'PROCESOS DE DESARROLLO DE APRENDIZAJE') === 0 && ocurrencias(cuerpo, ENCABEZADO_IDENTIDAD_VISIBLE) === 1 && ocurrencias(cuerpo, PDA_CUERPO) === 1 && !cuerpo.includes('Aprecia el uso intencional'),
    'R1. La sección de PDA del modelo desaparece; queda UNA sola sección: la del servidor')
  verificar(cuerpo.indexOf(ENCABEZADO_IDENTIDAD_VISIBLE) > cuerpo.indexOf('Que las niñas') && cuerpo.indexOf(ENCABEZADO_IDENTIDAD_VISIBLE) < cuerpo.indexOf('🧰 MATERIALES'),
    'R2. La sección canónica va después del propósito y antes de los materiales')
  verificar(JSON.stringify(lineasLegitimas(cuerpo)) === JSON.stringify(lineasLegitimas(cuerpoLeyendas(SECCION_PDA_MODELO))),
    'R3. Propósito, materiales (incluida la SEP), actividades, menciones de contenidos o PDA en las actividades, evaluación y producto se conservan intactos')
  verificar(cuerpo.includes(`Fuente: ${ROTULO_PENDIENTE_VALIDACION}`) && cuerpo.includes(`Contenidos de referencia:\n- ${TITULO_CUERPO}`) && cuerpo.includes(`PDA de referencia:\n- ${PDA_CUERPO}`) && !cuerpo.includes(' · '),
    'R4. Contenidos y PDA en listas legibles, con la fuente y su estado visibles')
  verificar(c.textoFinal.endsWith(resumen(TITULO_CUERPO, PDA_CUERPO) + `\n\n${PREGUNTA_CIERRE_BORRADOR}`) && ocurrencias(c.textoFinal, PREGUNTA_CIERRE_BORRADOR) === 1,
    'R5. El bloque de resumen no se toca y la pregunta de cierre aparece una sola vez')
  verificar(!REGEX_TECNICO.test(c.textoFinal.slice(0, c.textoFinal.indexOf(ETIQUETA_INICIO_BLOQUE))), 'R6. Ningún dato técnico en el cuerpo')

  // 2. Idempotencia y coherencia entre Chat, vista previa, aprobación e Historial.
  const otraVez = completarBorradorCurricular({ textoModelo: c.textoFinal, curricular: ctxA, textosDocente: [] })!
  verificar(otraVez.textoFinal === c.textoFinal && normalizarSeccionCurricular(c.textoParaVistaPrevia, c.identidad) === c.textoParaVistaPrevia, 'R7. Idempotente: normalizar dos veces da el mismo texto')
  verificar(extraerTextoCompletoBorrador(c.textoParaVistaPrevia) === cuerpo, 'R8. Vista previa (Word/PDF) = cuerpo del mensaje del Chat')
  const carga = await cargarCandidatosCurricularesGrupo(sb(base), 'grupo-3a')
  const resumenFinal = extraerResumenBorrador([{ role: 'assistant', content: c.textoFinal }])!
  const aprobado = decidirCurricularAprobacion(carga, 'grupo-3a', c.textoFinal, resumenFinal, [])
  verificar(aprobado.textoDefinitivo === cuerpo, 'R9. Documento definitivo (aprobación e Historial) = mismo cuerpo que vio el docente')
  verificar(JSON.stringify(pdaRevisadosEnSeccion(c.textoFinal)) === JSON.stringify([PDA_CUERPO]) && aprobado.trazabilidad.items[0]?.pda.map((p) => p.texto).join() === PDA_CUERPO,
    'R10. La aprobación lee los PDA revisados desde la lista de la sección')
  verificar(seleccionarBorradorVigente([{ role: 'user', content: 'Planeación de leyendas' }, { role: 'assistant', content: c.textoFinal }]).estado === 'listo', 'R11. seleccionarBorradorVigente reconoce el texto final')
  const marcador = `${modelo}\n\n[[TEXTO_FINAL:${Buffer.from(c.textoFinal, 'utf-8').toString('base64')}]]`
  const recibido = extraerTextoFinal(marcador)
  verificar(recibido.textoFinal === c.textoFinal && recibido.texto === modelo && extraerTextoFinal(modelo).textoFinal === undefined && extraerTextoFinal(`${modelo}[[TEXTO_FINAL:abc`).textoFinal === undefined,
    'R12. El cliente adopta el texto final del servidor; sin marcador (o incompleto), nada cambia')

  // 3. Variantes de encabezados del modelo: cada una desaparece con su lista.
  const variantes: string[][] = [
    ['## Contenidos', '- Contenido inventado A'],
    ['**PDA:**', '- PDA inventado B'],
    ['CONTENIDOS CURRICULARES', '1. Contenido inventado C', '2. Contenido inventado D'],
    ['📖 Contenidos y PDA', '• Elemento inventado E', '• Elemento inventado F'],
    ['Procesos de Desarrollo del Aprendizaje:', '- PDA inventado G'],
    ['📚 PDA (Procesos de Desarrollo de Aprendizaje)', '- PDA inventado H'],
    ['📌 CONTENIDOS Y PDA DE ESTA PLANEACIÓN', 'Fuente: Catálogo curricular de la app — pendiente de validación oficial', 'Contenidos de referencia: copia vieja · otra', 'PDA de referencia: copia vieja · otra'],
  ]
  for (const v of variantes) {
    const t = completarBorradorCurricular({ textoModelo: `${cuerpoLeyendas(v.join('\n'))}\n\n${resumen(TITULO_CUERPO, PDA_CUERPO)}`, curricular: ctxA, textosDocente: [] })!
    const cu = extraerTextoCompletoBorrador(t.textoFinal)
    // La línea «Fuente:» de una copia vieja coincide con la canónica: se
    // comprueban solo sus elementos propios.
    const elementos = v.slice(1).filter((l) => !l.startsWith('Fuente:')).map((l) => l.replace(/^([-•]|\d+\.)\s*/, '').trim())
    verificar(ocurrencias(cu, ENCABEZADO_IDENTIDAD_VISIBLE) === 1 && elementos.every((e) => !cu.includes(e)) && (v[0].startsWith('📌') || !cu.includes(v[0]))
      && JSON.stringify(lineasLegitimas(cu)) === JSON.stringify(lineasLegitimas(cuerpoLeyendas(''))),
      `R13. Variante «${v[0]}»: se reemplaza por la sección canónica sin tocar lo demás`)
  }
  const enLinea = completarBorradorCurricular({ textoModelo: `${cuerpoLeyendas('Contenidos: leyendas; mitos\nPDA: Narra leyendas')}\n\n${resumen(TITULO_CUERPO, PDA_CUERPO)}`, curricular: ctxA, textosDocente: [] })!
  const cuEnLinea = extraerTextoCompletoBorrador(enLinea.textoFinal)
  verificar(!cuEnLinea.includes('Contenidos: leyendas; mitos') && !cuEnLinea.includes('PDA: Narra leyendas') && cuEnLinea.includes('Contenido: leyendas de la región contadas por las familias.'),
    'R14. Líneas "Contenidos: …"/"PDA: …" antes de las sesiones se quitan; una línea así dentro de una actividad se conserva')

  // 4. Ubicación sin propósito y compatibilidad.
  const sinProposito = cuerpoLeyendas(SECCION_PDA_MODELO).replace('🎯 PROPÓSITO GENERAL\nQue las niñas y los niños conozcan, narren y recreen leyendas de su comunidad.\n\n', '')
  const sp = extraerTextoCompletoBorrador(completarBorradorCurricular({ textoModelo: `${sinProposito}\n\n${resumen(TITULO_CUERPO, PDA_CUERPO)}`, curricular: ctxA, textosDocente: [] })!.textoFinal)
  verificar(sp.indexOf(ENCABEZADO_IDENTIDAD_VISIBLE) < sp.indexOf('🧰 MATERIALES') && sp.indexOf(ENCABEZADO_IDENTIDAD_VISIBLE) > sp.indexOf('Campo Formativo'), 'R15. Sin propósito: antes de los materiales')
  const soloDias = '📋 PLANEACIÓN\n\n📅 DÍA 1 — Inicio\nActividad.'
  const sd = normalizarSeccionCurricular(soloDias, c.identidad)
  verificar(sd.indexOf(ENCABEZADO_IDENTIDAD_VISIBLE) < sd.indexOf('📅 DÍA 1') && sd.startsWith('📋 PLANEACIÓN'), 'R16. Sin propósito ni materiales: antes de la primera sesión')
  const historico = `${cuerpoLeyendas(SECCION_PDA_MODELO)}\n\n${resumen('tradición oral', 'narra una leyenda')}`
  verificar(normalizarSeccionCurricular(historico, null) === historico, 'R17. Sin identidad (borrador histórico): el texto no cambia; nunca se quita lo que no se reemplaza')
  const formatoAnterior = `${cuerpoLeyendas('')}\n\n${resumen(TITULO_CUERPO, 'ninguno')}\n\n${ENCABEZADO_IDENTIDAD_VISIBLE}\nFuente: ${ROTULO_PENDIENTE_VALIDACION}\nContenidos de referencia: ${TITULO_CUERPO}\nPDA de referencia: ${PDA_CUERPO} · ${PDA_ALIMENTACION}`
  verificar(JSON.stringify(pdaRevisadosEnSeccion(formatoAnterior)) === JSON.stringify([PDA_CUERPO, PDA_ALIMENTACION]), 'R18. Borradores con la sección en el formato anterior (una línea) se siguen leyendo al aprobar')

  // 5. Casos curriculares (sin cambios de regla).
  const b = completarBorradorCurricular({ textoModelo: `${cuerpoLeyendas('')}\n\n${resumen(`${TITULO_CUERPO}; ${TITULO_ALIMENTACION}`, 'ninguno')}`, curricular: ctxB, textosDocente: [] })!
  verificar(b.textoFinal.includes(`PDA de referencia:\n- ${PDA_CUERPO}\n- ${PDA_ALIMENTACION}`) && !/se incorporan/i.test(b.textoFinal), 'C1. Modo B: PDA reales de los contenidos elegidos, en lista')
  const d = completarBorradorCurricular({ textoModelo: `${cuerpoLeyendas('')}\n\n${resumen(`${TITULO_CUERPO}; Educación financiera para niños; Hábitos de higiene`, 'Explica cómo ahorra su familia')}`, curricular: ctxA, textosDocente: ['Incluye Educación financiera para niños y el PDA Explica cómo ahorra su familia'] })!
  verificar(d.textoFinal.includes('Contenidos indicados por el docente:\n- Educación financiera para niños') && d.textoFinal.includes('PDA indicados por el docente:\n- Explica cómo ahorra su familia')
    && d.textoFinal.includes(`${ROTULO_PROPUESTA_NO_VERIFICADA}:\nContenidos propuestos:\n- Hábitos de higiene`), 'C2. Datos del docente literales y propuestas no verificadas, diferenciados')
  const sinCobertura = await prepararContextoCurricularPlaneacion(sb(base), 'grupo-sec', { tema: 'fracciones' })
  const s = completarBorradorCurricular({ textoModelo: `${cuerpoLeyendas('')}\n\n${resumen('Fracciones equivalentes', 'Compara fracciones')}`, curricular: sinCobertura, textosDocente: [] })!
  verificar(s.textoFinal.includes('Contenidos propuestos:\n- Fracciones equivalentes') && !s.textoFinal.includes('Fuente:'), 'C3. Sin cobertura: propuesta no verificada')
  const ctxPa = await prepararContextoCurricularPlaneacion(sb(conProgramaAnalitico(base)), 'grupo-4b', { tema: 'historias del barrio' })
  const p = completarBorradorCurricular({ textoModelo: `${cuerpoLeyendas('')}\n\n${resumen('Historias del barrio contadas por las familias; Huerto escolar de la comunidad', 'ninguno')}`, curricular: ctxPa, textosDocente: [] })!
  verificar(p.textoFinal.includes('Fuente: Programa Analítico del grupo') && p.textoFinal.includes('Contenidos propios del Programa Analítico:\n- Huerto escolar de la comunidad'), 'C4. Programa Analítico: fuente y contenido local diferenciados')
  const conPregunta = completarBorradorCurricular({ textoModelo: `${modelo}\n\n¿Quieres cambiar algo?`, curricular: ctxA, textosDocente: [] })!
  verificar(!conPregunta.textoFinal.includes(PREGUNTA_CIERRE_BORRADOR) && conPregunta.textoFinal.trimEnd().endsWith('¿Quieres cambiar algo?'), 'C5. Si el modelo ya cerró con una pregunta, no se añade otra')
  verificar(completarBorradorCurricular({ textoModelo: 'Hay un conflicto de fechas: ¿qué día prefieres?', curricular: ctxA, textosDocente: [] }) === null, 'C6. Sin borrador completo (conflicto): nada que normalizar')
  verificar(construirIdentidadCurricularVisible([], [], []) === null, 'C7. Sin datos curriculares no hay sección')

  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} verificación(es) fallaron`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
