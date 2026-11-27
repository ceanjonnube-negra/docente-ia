// Hito 4, etapa 4a — expediente académico tipado y separación contextual.
// Sin red, sin IA: asistencia canónica (asistencia_registro), «sin
// registros» ≠ 0, «Requiere atención» con datos del contexto activo,
// periodos con y sin fechas, observaciones reales, discrepancia CURP /
// fecha de nacimiento (solo aviso al docente), separación entre ciclos y
// grupos, expediente grupal y número de consultas.
//   npx tsx scripts/verificar-expediente-4a.ts

import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResultadoProyectoGrupo } from '../lib/motorContexto'
import { construirHistorialGrupo, metadataDeProyecto, organizarHistorialAlumno } from '../lib/seguimiento/historialGrupo'
import { contratoAlumno } from '../lib/seguimiento/contratoHistorial'
import { avisoIdentidad, construirExpedienteAlumno, contarAsistencia, estadoAtencion, fechaNacimientoDeCurp, obtenerExpedienteAlumno, obtenerExpedienteGrupo, periodoDeFecha, type EntradaExpedienteAlumno } from '../lib/seguimiento/expedienteAlumno'

let fallos = 0
let total = 0
function verificar(ok: boolean, nombre: string) {
  total++
  if (!ok) fallos++
  console.log(`${ok ? '✓' : '✗'} ${nombre}`)
}
const leer = (r: string) => readFileSync(r, 'utf-8')
const r = (fecha: string, estatus: string) => ({ fecha, estatus })

// 1. Asistencia: «sin registros» ≠ 0.
const vacia = contarAsistencia([])
verificar(vacia.registros === 0 && vacia.porcentajeAsistencia === null, '1a. Sin registros: porcentaje null (nunca 0 %)')
const c = contarAsistencia([r('2026-10-01', 'presente'), r('2026-10-02', 'retardo'), r('2026-10-03', 'falta'), r('2026-10-04', 'justificada'), r('2026-10-05', 'raro')])
verificar(c.presentes === 1 && c.retardos === 1 && c.faltas === 1 && c.justificadas === 1 && c.otros === 1 && c.porcentajeAsistencia === 40, '1b. Estados reales separados; asistió = presente o retardo')

// 2. Requiere atención (misma regla, datos del contexto).
const HOY = '2026-11-27'
verificar(estadoAtencion([], [], HOY).estado === 'sin_datos' && estadoAtencion([], [{ fecha: '2026-09-01' }], HOY).estado === 'sin_datos' && estadoAtencion([], [], HOY).estado !== 'al_corriente', '2a. Sin registros de asistencia: «sin datos», nunca «al corriente» (no es asistencia perfecta)')
verificar(JSON.stringify(estadoAtencion([], [{ fecha: '2026-11-20' }], HOY)) === JSON.stringify({ estado: 'requiere_atencion', motivos: ['incidencia_reciente'], tasaFaltas: null }), '2a2. Sin asistencia pero con incidencia reciente real: se señala (no se oculta)')
verificar(estadoAtencion([r('2026-11-01', 'falta'), r('2026-11-02', 'presente'), r('2026-11-03', 'presente')], [], HOY).motivos.join() === 'faltas', '2b. Faltas > 20 %: requiere atención por faltas')
verificar(estadoAtencion([r('2026-11-01', 'presente')], [{ fecha: '2026-11-10' }], HOY).motivos.join() === 'incidencia_reciente' && estadoAtencion([r('2026-11-01', 'presente')], [{ fecha: '2026-09-01' }], HOY).estado === 'al_corriente', '2c. Incidencia en los últimos 30 días sí; una antigua no')
verificar(estadoAtencion([r('2026-08-31', 'presente'), r('2026-09-01', 'presente')], [], HOY).estado === 'al_corriente', '2d. Caso Dylan (4° B: 2 registros, 0 faltas): al corriente')

// 3. Identidad: CURP vs fecha de nacimiento (solo aviso).
verificar(fechaNacimientoDeCurp('HESD170823HSRRNYA1') === '2017-08-23' && fechaNacimientoDeCurp('GOMA850301MDFRRR09') === '1985-03-01' && fechaNacimientoDeCurp('XXXX170230HSRRNYA1') === null && fechaNacimientoDeCurp('corta') === null && fechaNacimientoDeCurp(null) === null, '3a. Fecha según CURP (siglo por el carácter 17); inválida o incompleta: null')
const aviso = avisoIdentidad('HESD170823HSRRNYA1', '2021-08-04')
verificar(aviso?.codigo === 'curp_fecha_nacimiento_distinta' && aviso.fechaSegunCurp === '2017-08-23' && avisoIdentidad('HESD170823HSRRNYA1', '2017-08-23') === null && avisoIdentidad('invalida', '2021-08-04') === null && avisoIdentidad('HESD170823HSRRNYA1', null) === null, '3b. Discrepancia detectada; coincidencia, CURP inválida o sin fecha: sin aviso')

// 4. Expediente individual.
const C = 'ciclo-1', C0 = 'ciclo-0', G = 'g-4b', G0 = 'g-3b', D = 'doc-1'
const PER_SIN = [{ id: 'p1', nombre: 'Primer Trimestre', numero_periodo: 1, fecha_inicio: null, fecha_fin: null }, { id: 'p2', nombre: 'Segundo Trimestre', numero_periodo: 2, fecha_inicio: null, fecha_fin: null }]
const PER = [{ id: 'p1', nombre: 'Primer Trimestre', numero_periodo: 1, fecha_inicio: '2026-08-31', fecha_fin: '2026-11-30' }, { id: 'p2', nombre: 'Segundo Trimestre', numero_periodo: 2, fecha_inicio: '2026-12-01', fecha_fin: '2027-03-15' }]
type Proy = { id: string; grupo: string; ciclo: string; conf: string }
const ps = (p: Proy) => ({ nombre: `Proyecto ${p.id}`, docente_id: D, grupo_id: p.grupo, ciclo_escolar_id: p.ciclo, periodo_evaluacion_id: null, campos_formativos: ['Lenguajes'], fecha_inicio: '2026-10-05', fecha_fin: '2026-10-09', origen_resultados: 'fotografia', confirmado_en: p.conf })
const A: Proy = { id: 'A', grupo: G, ciclo: C, conf: '2026-10-10T10:00:00Z' }
const V: Proy = { id: 'V', grupo: G0, ciclo: C0, conf: '2025-10-10T10:00:00Z' }
const fila = (p: Proy, ins: string, n: number, nivel: string, observacion: string | null = null): ResultadoProyectoGrupo => ({ proyecto_id: p.id, alumno_id: 'dylan', inscripcion_id: ins, indicador_numero: n, indicador_especifico: `Indicador ${n}`, aspecto_general: 'logro_aprendizaje', nivel: nivel as ResultadoProyectoGrupo['nivel'], confianza: 1, corregido_manualmente: false, observacion, proyectos_seguimiento: ps(p) })
const FILAS = [fila(A, 'i-4b', 1, 'logrado', 'Explica con sus palabras el ciclo del agua.'), fila(A, 'i-4b', 2, 'logrado'), fila(V, 'i-3b', 1, 'requiere_apoyo')]
const INS = [
  { inscripcionId: 'i-4b', grupoId: G, cicloEscolarId: C, estatus: 'activo', fechaInscripcion: '2026-07-25', grupoNombre: '4° B', cicloNombre: '2026-2027' },
  { inscripcionId: 'i-3b', grupoId: G0, cicloEscolarId: C0, estatus: 'baja', fechaInscripcion: '2026-07-14', grupoNombre: '3° B', cicloNombre: '2025-2026' },
]
const hDylan = organizarHistorialAlumno(construirHistorialGrupo(FILAS, PER), INS, [A, V].map((p) => metadataDeProyecto(p.id, ps(p), PER)))
const base = (sobre: Partial<EntradaExpedienteAlumno> = {}): EntradaExpedienteAlumno => ({
  historial: contratoAlumno(hDylan, 'dylan', G, C)!,
  alumno: { nombre: 'Dylan', sexo: 'H', fechaNacimiento: '2021-08-04', curp: 'HESD170823HSRRNYA1' },
  grupo: { nivelEducativo: 'primaria', grado: '4', grupo: 'B' },
  inscripcion: { observaciones: null, fechaInscripcion: '2026-07-25T00:00:00Z', fechaBaja: null },
  periodos: PER, asistencia: [r('2026-08-31', 'presente'), r('2026-09-01', 'presente')], incidencias: [], notas: [], hoy: HOY, ...sobre,
})
const e = construirExpedienteAlumno(base())
verificar(e.version === 1 && JSON.stringify(JSON.parse(JSON.stringify(e))) === JSON.stringify(e) && JSON.stringify(construirExpedienteAlumno(base())) === JSON.stringify(e), '4a. Expediente v1 serializable y determinista')
verificar(e.alcance.inscripcionId === 'i-4b' && e.historial.resumen.proyectosConResultados === 1 && !JSON.stringify(e).includes('Proyecto V'), '4b. Solo la inscripción del grupo y ciclo activos (el ciclo anterior queda fuera)')
verificar(e.asistencia.total.registros === 2 && e.asistencia.porPeriodo.find((p) => p.periodo?.id === 'p1')?.conteo.registros === 2 && e.atencion.estado === 'al_corriente', '4c. Asistencia por periodo delimitado; atención con datos del contexto')
verificar(e.avisosDocente.length === 1 && e.avisosDocente[0].codigo === 'curp_fecha_nacimiento_distinta' && !JSON.stringify({ ...e, avisosDocente: [] }).includes('2017-08-23'), '4d. Aviso CURP solo en avisosDocente (fuera del contenido pedagógico)')
verificar(e.observaciones.length === 1 && e.observaciones[0].origen === 'resultado' && e.observaciones[0].texto.startsWith('Explica'), '4e. Observación real del resultado confirmado, sin inventar')
const sinNada = construirExpedienteAlumno(base({ asistencia: [], periodos: PER_SIN, historial: contratoAlumno(organizarHistorialAlumno(construirHistorialGrupo([], PER), [INS[0]], []), 'dylan', G, C)! }))
const codigos = sinNada.faltantes.map((f) => f.codigo)
verificar(['sin_resultados_confirmados', 'sin_registros_asistencia', 'sin_observaciones', 'periodos_sin_fechas'].every((k) => codigos.includes(k as never)) && sinNada.asistencia.total.porcentajeAsistencia === null && sinNada.atencion.estado === 'sin_datos', '4f. Sin registros: faltantes declarados, sin ceros ni datos supuestos')
const fuera = construirExpedienteAlumno(base({ asistencia: [r('2026-08-20', 'falta'), r('2026-09-02', 'presente')], incidencias: [{ id: 'x', fecha: '2026-08-21', tipo: 'Conducta', descripcion: 'd' }] }))
verificar(JSON.stringify(fuera.faltantes.find((f) => f.codigo === 'registros_fuera_de_periodo')) === JSON.stringify({ codigo: 'registros_fuera_de_periodo', asistencia: 1, incidencias: 1 }) && fuera.asistencia.porPeriodo.some((p) => p.periodo === null), '4g. Registros fuera de los periodos delimitados: se separan y se avisan')
const traslape = [...PER, { id: 'px', nombre: 'Traslapado', numero_periodo: 9, fecha_inicio: '2026-09-01', fecha_fin: '2026-09-30' }]
verificar(periodoDeFecha('2026-09-10', traslape.map((p) => ({ id: p.id, nombre: p.nombre, numero: p.numero_periodo, fechaInicio: p.fecha_inicio, fechaFin: p.fecha_fin, delimitado: true }))) === null, '4h. Periodos traslapados: el registro no se asigna a ninguno')
const notas = construirExpedienteAlumno(base({ notas: [{ fecha: '2026-07-20T10:00:00Z', tipo: 'Nota', contenido: 'De su grupo anterior' }, { fecha: '2026-10-01T10:00:00Z', tipo: 'Nota', contenido: 'Participa en lectura' }], inscripcion: { observaciones: 'Requiere lentes', fechaInscripcion: '2026-07-25T00:00:00Z', fechaBaja: null } }))
verificar(notas.observaciones.map((o) => o.origen).join() === 'nota,inscripcion,resultado' && !JSON.stringify(notas.observaciones).includes('grupo anterior'), '4i. Notas solo dentro de la inscripción; observaciones de la inscripción y de resultados')
const vig = construirExpedienteAlumno(base({ incidencias: [
  { id: 'antes', fecha: '2026-07-20', tipo: 'Conducta', descripcion: 'antes de su alta en 4° B', inscripcionId: null },
  { id: 'otra', fecha: '2026-09-10', tipo: 'Conducta', descripcion: 'de otra inscripción', inscripcionId: 'i-3b' },
  { id: 'fuera_ciclo', fecha: '2027-08-01', tipo: 'Conducta', descripcion: 'fuera del ciclo', inscripcionId: null },
  { id: 'ok', fecha: '2026-09-15', tipo: 'Conducta', descripcion: 'válida', inscripcionId: 'i-4b' },
  { id: 'ok2', fecha: '2026-10-02', tipo: 'Material', descripcion: 'válida sin inscripción', inscripcionId: null },
], inscripcion: { observaciones: null, fechaInscripcion: '2026-07-25T00:00:00Z', fechaBaja: null, cicloInicio: '2026-08-24', cicloFin: '2027-07-15' } }))
verificar(vig.incidencias.items.map((i) => i.id).join() === 'ok,ok2', '4k. Incidencias delimitadas por la vigencia de la inscripción y del ciclo (antes del alta, de otra inscripción o fuera del ciclo quedan fuera)')
const baja = construirExpedienteAlumno(base({ incidencias: [{ id: 'tras_baja', fecha: '2026-10-20', tipo: 'Conducta', descripcion: 'd', inscripcionId: null }], inscripcion: { observaciones: null, fechaInscripcion: '2026-07-25T00:00:00Z', fechaBaja: '2026-10-01T00:00:00Z' } }))
verificar(baja.incidencias.total === 0, '4l. Incidencia posterior a la baja: fuera')
verificar(['preescolar', 'secundaria'].every((n) => construirExpedienteAlumno(base({ grupo: { nivelEducativo: n, grado: '2', grupo: 'A' } })).alcance.nivelEducativo === n), '4j. Preescolar, primaria y secundaria: mismo expediente')

;(async () => {
  // 5. Obtención con separación real y sin N+1.
  const valorEn = (f: Record<string, unknown>, ruta: string) => ruta.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], f)
  const insFila = (i: (typeof INS)[number]) => ({ alumno_id: 'dylan', grupo_id: i.grupoId, ciclo_escolar_id: i.cicloEscolarId })
  const TABLAS: Record<string, Record<string, unknown>[]> = {
    inscripciones: INS.map((i) => ({ id: i.inscripcionId, alumno_id: 'dylan', grupo_id: i.grupoId, ciclo_escolar_id: i.cicloEscolarId, estatus: i.estatus, fecha_inscripcion: i.fechaInscripcion, fecha_baja: i.estatus === 'baja' ? '2026-07-25' : null, observaciones: null, alumnos: { nombre: 'Dylan', sexo: 'H', fecha_nacimiento: '2021-08-04', curp: 'HESD170823HSRRNYA1' }, grupos: { grado: i.grupoNombre[0], grupo: 'B', nombre_grupo: null, nivel_educativo: 'primaria', docente_id: D }, ciclos_escolares: { nombre: i.cicloNombre } })),
    seguimiento_resultados: FILAS as unknown as Record<string, unknown>[],
    periodos_evaluacion: PER.map((p) => ({ ...p, ciclo_escolar_id: C })),
    proyectos_seguimiento: [A, V].map((p) => ({ id: p.id, ...ps(p) })),
    asistencia_registro: [
      { inscripcion_id: 'i-3b', fecha: '2026-07-20', estatus: 'falta', inscripciones: insFila(INS[1]) },
      { inscripcion_id: 'i-3b', fecha: '2026-07-21', estatus: 'falta', inscripciones: insFila(INS[1]) },
      { inscripcion_id: 'i-4b', fecha: '2026-08-31', estatus: 'presente', inscripciones: insFila(INS[0]) },
      { inscripcion_id: 'i-4b', fecha: '2026-09-01', estatus: 'presente', inscripciones: insFila(INS[0]) },
    ],
    incidencias: [
      { id: 'i1', alumno_id: 'dylan', grupo_id: G0, fecha: '2026-07-21', tipo: 'Conducta', descripcion: 'otro grupo', inscripcion_id: null },
      { id: 'i2', alumno_id: 'dylan', grupo_id: G, fecha: '2026-07-24', tipo: 'Conducta', descripcion: 'antes del alta en 4° B', inscripcion_id: null },
    ],
    perfil_alumno_notas: [],
  }
  const consultas: string[] = []
  const sb = {
    from: (t: string) => {
      consultas.push(t)
      const filtros: ((f: Record<string, unknown>) => boolean)[] = []
      const b: Record<string, unknown> = {
        select: () => b, order: () => b,
        eq: (k: string, v: unknown) => { filtros.push((f) => valorEn(f, k) === v); return b },
        in: (k: string, vs: unknown[]) => { filtros.push((f) => vs.includes(valorEn(f, k))); return b },
        not: (k: string, op: string, v: unknown) => { if (op === 'is' && v === null) filtros.push((f) => valorEn(f, k) != null); return b },
        maybeSingle: async () => ({ data: (TABLAS[t] ?? []).filter((f) => filtros.every((p) => p(f)))[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: (TABLAS[t] ?? []).filter((f) => filtros.every((p) => p(f))), error: null }).then(ok),
      }
      return b
    },
  } as unknown as SupabaseClient
  const ex = await obtenerExpedienteAlumno(sb, 'dylan', D, G, C, HOY)
  verificar(!!ex && ex.asistencia.total.registros === 2 && ex.asistencia.total.faltas === 0 && ex.incidencias.total === 0 && ex.atencion.estado === 'al_corriente', '5a. Dylan: solo asistencia e incidencias de su inscripción en 4° B (las faltas e incidencia de 3° B quedan fuera)')
  verificar(!consultas.includes('asistencias') && consultas.includes('asistencia_registro'), '5b. Lee la asistencia canónica; nunca la tabla legada')
  verificar(consultas.length === 8, `5c. 8 consultas en 2 rondas, sin N+1 ni periodos repetidos (${consultas.join(', ')})`)
  verificar(ex?.alcance.nivelEducativo === 'primaria' && ex.avisosDocente[0]?.fechaSegunCurp === '2017-08-23', '5d. Nivel educativo real y aviso de identidad para el docente')
  verificar((await obtenerExpedienteAlumno(sb, 'dylan', 'otro-docente', G, C, HOY)) === null, '5e. Otro docente: sin expediente')
  consultas.length = 0
  TABLAS.inscripciones.push({ ...TABLAS.inscripciones[0], id: 'i-otro', alumno_id: 'ana', alumnos: { nombre: 'Ana' } })
  const eg = await obtenerExpedienteGrupo(sb, { grupoId: G, grupoNombre: '4° B', cicloEscolarId: C }, HOY)
  const dyl = eg.alumnos.find((a) => a.alumnoId === 'dylan')
  verificar(eg.version === 1 && dyl?.asistencia.total.registros === 2 && dyl.incidencias === 0 && eg.asistencia.registros === 2, '5f. Expediente grupal: asistencia por inscripción del grupo y ciclo; incidencias del grupo')
  verificar(consultas.length === 5, `5g. Grupo: 5 consultas (concentrado + asistencia + incidencias) (${consultas.join(', ')})`)

  // 6. Ficha del alumno y fuentes.
  const ficha = leer('app/dashboard/lista/[alumnoId]/page.tsx')
  verificar(!/from\('asistencias'\)/.test(ficha) && /from\('asistencia_registro'\)\.select\('fecha, estatus'\)\.eq\('inscripcion_id', inscripcionActiva\.id\)/.test(ficha), '6a. Ficha: asistencia canónica de la inscripción activa (no la tabla legada)')
  verificar(/\.eq\('alumno_id', alumnoId\)\.eq\('grupo_id', grupoIdActivo\)/.test(ficha) && /\.or\(`inscripcion_id\.is\.null,inscripcion_id\.eq\.\$\{inscripcionActiva!\.id\}`\)/.test(ficha) && /\.gte\('fecha', \(inscripcionActiva\?\.fecha_inscripcion/.test(ficha) && /estadoAtencion\(asistenciasData, incidenciasData, fechaISOHoy/.test(ficha), '6b. Ficha: incidencias del grupo activo dentro de la vigencia de la inscripción, y «Requiere atención» con la regla compartida')
  verificar(/avisoIdentidad\(curp, fechaNacimiento\)/.test(ficha) && /La CURP indica/.test(ficha) && !/setFechaNacimiento\(.*Curp/.test(ficha), '6c. Ficha: aviso discreto de CURP en Datos; nunca corrige datos')
  const mod = leer('lib/seguimiento/expedienteAlumno.ts')
  verificar(!/anthropic|openai|generateText|streamText|\.(insert|update|upsert|delete)\(|\.rpc\(|from\('asistencias'\)/.test(mod), '6d. Expediente sin IA, sin escrituras y sin la tabla legada')

  console.log(`\n${total - fallos}/${total} verificaciones correctas`)
  process.exit(fallos ? 1 : 0)
})()
