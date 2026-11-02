// scripts/verificar-lectura-historial-academico.ts
//
// Etapa 1 del historial académico: lectura canónica de resultados YA
// confirmados (seguimiento_resultados) por alumno y por grupo
// (lib/motorContexto.ts) y los modelos puros que la reorganizan
// (lib/seguimiento/historialGrupo.ts, lib/seguimiento/resultadosConfirmados.ts).
//
// Sin red, sin credenciales, sin IA: el cliente de Supabase se sustituye
// por un doble que registra cada llamada, para comprobar la forma exacta
// de la consulta y que nunca se escribe nada.
//
// Se ejecuta con `npx tsx scripts/verificar-lectura-historial-academico.ts`.

import { readFileSync } from 'node:fs'
import { resultadosProyectoAlumno, resultadosProyectoGrupo, type ResultadoProyectoGrupo } from '../lib/motorContexto'
import { construirHistorialGrupo } from '../lib/seguimiento/historialGrupo'
import { construirMatrizResultadosConfirmados } from '../lib/seguimiento/resultadosConfirmados'
import type { AlumnoRosterCongelado, IndicadorCongelado } from '../lib/seguimiento/tipos'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// Doble de Supabase: registra tabla, select, filtros y cualquier método
// de escritura; devuelve { data, error } fijo al resolverse.
type Llamada = { metodo: string; args: unknown[] }
function clienteFalso(respuesta: { data: unknown; error: unknown }) {
  const llamadas: Llamada[] = []
  const builder: Record<string, unknown> = {}
  for (const metodo of ['select', 'eq', 'not', 'order', 'in', 'insert', 'update', 'upsert', 'delete']) {
    builder[metodo] = (...args: unknown[]) => { llamadas.push({ metodo, args }); return builder }
  }
  builder.then = (resolver: (v: unknown) => unknown, rechazar: (e: unknown) => unknown) => Promise.resolve(respuesta).then(resolver, rechazar)
  const sb = {
    from: (tabla: string) => { llamadas.push({ metodo: 'from', args: [tabla] }); return builder },
    rpc: (...args: unknown[]) => { llamadas.push({ metodo: 'rpc', args }); return builder },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { sb: sb as any, llamadas }
}
const ESCRITURA = new Set(['insert', 'update', 'upsert', 'delete', 'rpc'])

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'
const INS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ALU_A = 'a0000000-0000-4000-8000-00000000000a'
const INS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ALU_B = 'b0000000-0000-4000-8000-00000000000b'
const PER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function fila(p: Partial<ResultadoProyectoGrupo> & { proyecto_id: string; inscripcion_id: string; alumno_id: string; indicador_numero: number }, confirmadoEn: string, periodo: string | null = null): ResultadoProyectoGrupo {
  return {
    indicador_especifico: `Indicador ${p.indicador_numero}`,
    aspecto_general: 'logro_aprendizaje',
    nivel: 'logrado',
    confianza: 1,
    corregido_manualmente: false,
    observacion: null,
    proyectos_seguimiento: { nombre: 'Proyecto', grupo_id: 'g', ciclo_escolar_id: 'c', periodo_evaluacion_id: periodo, origen_resultados: 'fotografia', confirmado_en: confirmadoEn },
    ...p,
  }
}

async function main() {
  // 1. resultadosProyectoAlumno: forma exacta de la consulta, solo lectura.
  {
    const filas = [{ proyecto_id: P1 }]
    const { sb, llamadas } = clienteFalso({ data: filas, error: null })
    const r = await resultadosProyectoAlumno(sb, ALU_A)
    const select = String(llamadas.find((l) => l.metodo === 'select')?.args[0] ?? '')
    verificar(llamadas[0]?.metodo === 'from' && llamadas[0].args[0] === 'seguimiento_resultados', '1a. Alumno: lee únicamente seguimiento_resultados')
    verificar(/proyectos_seguimiento!inner/.test(select), '1b. Alumno: embed !inner con proyectos_seguimiento')
    verificar(!/captura_pendiente/.test(select), '1c. Alumno: nunca lee captura_pendiente')
    verificar(llamadas.some((l) => l.metodo === 'eq' && l.args[0] === 'alumno_id' && l.args[1] === ALU_A), '1d. Alumno: filtra por alumno_id')
    verificar(llamadas.some((l) => l.metodo === 'not' && l.args[0] === 'proyectos_seguimiento.confirmado_en' && l.args[1] === 'is' && l.args[2] === null), '1e. Alumno: solo proyectos confirmados (confirmado_en no nulo)')
    verificar(!llamadas.some((l) => ESCRITURA.has(l.metodo)), '1f. Alumno: ninguna escritura ni RPC')
    verificar(r.length === 1, '1g. Alumno: devuelve las filas recibidas')
    const { sb: sbError } = clienteFalso({ data: null, error: { code: 'XX' } })
    let lanzo = false
    try { await resultadosProyectoAlumno(sbError, ALU_A) } catch { lanzo = true }
    verificar(lanzo, '1h. Alumno: un error de Supabase se relanza (nunca se convierte en [])')
  }

  // 2. resultadosProyectoGrupo: filtros de grupo+ciclo, confirmación y orden.
  {
    const desordenadas = [
      fila({ proyecto_id: P2, inscripcion_id: INS_B, alumno_id: ALU_B, indicador_numero: 2 }, '2026-11-01T10:00:00Z'),
      fila({ proyecto_id: P1, inscripcion_id: INS_A, alumno_id: ALU_A, indicador_numero: 1 }, '2026-11-02T10:00:00Z'),
      fila({ proyecto_id: P2, inscripcion_id: INS_A, alumno_id: ALU_A, indicador_numero: 3 }, '2026-11-01T10:00:00Z'),
      fila({ proyecto_id: P2, inscripcion_id: INS_A, alumno_id: ALU_A, indicador_numero: 1 }, '2026-11-01T10:00:00Z'),
    ]
    const { sb, llamadas } = clienteFalso({ data: desordenadas, error: null })
    const r = await resultadosProyectoGrupo(sb, 'grupo-1', 'ciclo-1')
    const select = String(llamadas.find((l) => l.metodo === 'select')?.args[0] ?? '')
    verificar(llamadas[0]?.args[0] === 'seguimiento_resultados' && /proyectos_seguimiento!inner/.test(select), '2a. Grupo: seguimiento_resultados con embed !inner')
    verificar(/alumno_id/.test(select) && /inscripcion_id/.test(select), '2b. Grupo: selecciona alumno_id e inscripcion_id explícitos')
    verificar(llamadas.some((l) => l.metodo === 'eq' && l.args[0] === 'proyectos_seguimiento.grupo_id' && l.args[1] === 'grupo-1'), '2c. Grupo: filtra por el grupo del proyecto')
    verificar(llamadas.some((l) => l.metodo === 'eq' && l.args[0] === 'proyectos_seguimiento.ciclo_escolar_id' && l.args[1] === 'ciclo-1'), '2d. Grupo: filtra por el ciclo del proyecto')
    verificar(llamadas.some((l) => l.metodo === 'not' && l.args[0] === 'proyectos_seguimiento.confirmado_en' && l.args[1] === 'is'), '2e. Grupo: solo proyectos confirmados')
    verificar(!llamadas.some((l) => l.metodo === 'eq' && String(l.args[0]).includes('periodo')), '2f. Grupo: sin filtro de periodo (historial completo del ciclo)')
    verificar(!llamadas.some((l) => ESCRITURA.has(l.metodo)), '2g. Grupo: ninguna escritura ni RPC')
    verificar(r.map((x) => `${x.proyecto_id === P1 ? 'P1' : 'P2'}:${x.alumno_id === ALU_A ? 'A' : 'B'}:${x.indicador_numero}`).join(',') === 'P1:A:1,P2:A:1,P2:A:3,P2:B:2', '2h. Grupo: orden determinista (confirmado_en desc → proyecto → alumno → indicador)')
    verificar(desordenadas[0].proyecto_id === P2, '2i. Grupo: no muta el arreglo recibido')
    const { sb: sbError } = clienteFalso({ data: null, error: { code: 'XX' } })
    let lanzo = false
    try { await resultadosProyectoGrupo(sbError, 'g', 'c') } catch { lanzo = true }
    verificar(lanzo, '2j. Grupo: un error de Supabase se relanza')
  }

  // 3. construirHistorialGrupo: asociación, exclusiones y resumen.
  {
    const base = [
      fila({ proyecto_id: P1, inscripcion_id: INS_A, alumno_id: ALU_A, indicador_numero: 2, nivel: 'destacado' }, '2026-11-02T10:00:00Z', PER),
      fila({ proyecto_id: P1, inscripcion_id: INS_A, alumno_id: ALU_A, indicador_numero: 1, nivel: 'logrado' }, '2026-11-02T10:00:00Z', PER),
      fila({ proyecto_id: P1, inscripcion_id: INS_B, alumno_id: ALU_B, indicador_numero: 1, nivel: 'en_proceso', aspecto_general: 'autonomia' }, '2026-11-02T10:00:00Z', PER),
      fila({ proyecto_id: P2, inscripcion_id: INS_A, alumno_id: ALU_A, indicador_numero: 1, nivel: 'requiere_apoyo' }, '2026-10-01T10:00:00Z', null),
    ]
    const h = construirHistorialGrupo(base)
    verificar(h.entradasAmbiguasExcluidas === 0 && h.entradasInvalidasExcluidas === 0, '3a. Datos válidos: 0 exclusiones')
    verificar(h.proyectos.map((p) => p.proyectoId).join() === `${P1},${P2}`, '3b. Proyectos ordenados por confirmado_en desc')
    verificar(h.proyectos[0].periodoEvaluacionId === PER && h.proyectos[1].periodoEvaluacionId === null, '3c. Conserva periodo_evaluacion_id por proyecto (incluido null), sin inventarlo')
    const a = h.alumnos.find((x) => x.inscripcionId === INS_A)
    verificar(!!a && a.alumnoId === ALU_A && a.proyectos.length === 2, '3d. Alumno A agrupado por inscripción, con alumno_id correcto y 2 proyectos')
    verificar(a?.proyectos[0].indicadores.map((i) => i.indicadorNumero).join() === '1,2', '3e. Indicadores ordenados por número')
    verificar(h.alumnos.find((x) => x.inscripcionId === INS_B)?.alumnoId === ALU_B, '3f. Alumno B no se mezcla con A')
    verificar(h.resumen.proyectosConfirmados === 2 && h.resumen.alumnosConResultados === 2 && h.resumen.totalIndicadoresConfirmados === 4, '3g. Resumen: 2 proyectos, 2 alumnos, 4 indicadores')
    verificar(h.resumen.distribucionNiveles.no_evaluado === 0 && h.resumen.distribucionNiveles.destacado === 1, '3h. Distribución inicializa en 0 los niveles sin ocurrencias')
    verificar(h.resumen.distribucionNivelesPorAspecto.autonomia.en_proceso === 1, '3i. Distribución por aspecto')
    verificar(!('promedio' in h.resumen) && !('nivelFinal' in h.resumen), '3j. Sin promedios ni nivel final')

    const conDuplicado = [...base, fila({ proyecto_id: P1, inscripcion_id: INS_A, alumno_id: ALU_A, indicador_numero: 1, nivel: 'destacado' }, '2026-11-02T10:00:00Z', PER)]
    const hd = construirHistorialGrupo(conDuplicado)
    verificar(hd.entradasAmbiguasExcluidas === 2, '3k. Duplicado de identidad: se excluyen TODAS las filas en conflicto (2)')
    verificar(hd.alumnos.find((x) => x.inscripcionId === INS_A)?.proyectos.find((p) => p.proyectoId === P1)?.indicadores.every((i) => i.indicadorNumero !== 1) === true, '3l. Ninguno de los valores en conflicto se usa')

    const conInvalidas = [...base,
      fila({ proyecto_id: P2, inscripcion_id: INS_B, alumno_id: ALU_B, indicador_numero: 2, nivel: 'excelente' as never }, '2026-10-01T10:00:00Z'),
      fila({ proyecto_id: P2, inscripcion_id: INS_B, alumno_id: ALU_B, indicador_numero: 3, aspecto_general: 'otro' as never }, '2026-10-01T10:00:00Z'),
      fila({ proyecto_id: P2, inscripcion_id: INS_B, alumno_id: ALU_B, indicador_numero: 4, nivel: null as never }, '2026-10-01T10:00:00Z'),
    ]
    const hi = construirHistorialGrupo(conInvalidas)
    verificar(hi.entradasInvalidasExcluidas === 3 && hi.resumen.totalIndicadoresConfirmados === 4, '3m. Nivel/aspecto fuera del dominio canónico: excluidos y contados (3)')
    verificar(construirHistorialGrupo([]).resumen.totalIndicadoresConfirmados === 0, '3n. Sin filas: historial vacío sin errores')
  }

  // 4. construirMatrizResultadosConfirmados: roster congelado como identidad.
  {
    const roster: AlumnoRosterCongelado[] = [
      { alumno_id: ALU_B, inscripcion_id: INS_B, nombre: 'Alumno B', posicion: 2 },
      { alumno_id: ALU_A, inscripcion_id: INS_A, nombre: 'Alumno A', posicion: 1 },
    ]
    const indicadores = [2, 1].map((n) => ({ numero_indicador: n, indicador_especifico: `Ind ${n}`, aspecto_general: 'logro_aprendizaje' })) as IndicadorCongelado[]
    const m = construirMatrizResultadosConfirmados([
      { inscripcion_id: INS_A, indicador_numero: 1, nivel: 'destacado' },
      { inscripcion_id: INS_A, indicador_numero: 2, nivel: 'desconocido' },
      { inscripcion_id: INS_B, indicador_numero: 1, nivel: 'logrado' },
      { inscripcion_id: INS_B, indicador_numero: 1, nivel: 'en_proceso' },
      { inscripcion_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', indicador_numero: 1, nivel: 'logrado' },
    ], roster, indicadores)
    verificar(m.alumnos.map((x) => x.inscripcionId).join() === `${INS_A},${INS_B}`, '4a. Alumnos por posición del roster congelado')
    verificar(m.alumnos.length === 2, '4b. Una inscripción fuera del roster no aparece')
    verificar(m.alumnos[0].celdas.map((c) => c.numeroIndicador).join() === '1,2', '4c. Indicadores ordenados por número')
    verificar(m.alumnos[0].celdas[0].nivel === 'destacado', '4d. Nivel válido se conserva')
    verificar(m.alumnos[0].celdas[1].nivel === null, '4e. Nivel fuera del dominio → null (nunca aproximado)')
    verificar(m.alumnos[1].celdas[0].nivel === null, '4f. Duplicado → null (ni primero ni último gana)')
    verificar(m.alumnos[1].celdas[1].nivel === null, '4g. Celda sin fila → null')
  }

  // 5. Integración selectiva: idéntico a la referencia y sin IA/escrituras.
  {
    const motor = readFileSync('lib/motorContexto.ts', 'utf8')
    verificar(/export async function resultadosProyectoAlumno\(/.test(motor) && /export async function resultadosProyectoGrupo\(/.test(motor), '5a. motorContexto exporta ambas lecturas')
    for (const archivo of ['lib/seguimiento/historialGrupo.ts', 'lib/seguimiento/resultadosConfirmados.ts']) {
      const t = readFileSync(archivo, 'utf8')
      verificar(!/from ['"](@anthropic|openai|ai|@ai-sdk)|fetch\(|supabase/i.test(t.replace(/\/\/.*$/gm, '')), `5b. ${archivo}: puro (sin IA, red ni Supabase)`)
    }
  }

  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
    process.exit(0)
  }
}

main()
