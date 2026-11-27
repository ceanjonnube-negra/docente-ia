// Hito 3, etapa 3e — contrato estable del historial académico para el
// Hito 4 (fichas y reportes). Sin red, sin IA: forma versionada y
// serializable, alcance estricto, estados sin mezclar, avisos, vista
// grupal, reutilización de las lecturas existentes y la ficha descriptiva
// como primer consumidor.
//   npx tsx scripts/verificar-contrato-historial-3e.ts

import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResultadoProyectoGrupo } from '../lib/motorContexto'
import { construirConcentradoGrupo, construirHistorialGrupo, metadataDeProyecto, organizarHistorialAlumno, type InscripcionDelGrupo, type InscripcionHistorial } from '../lib/seguimiento/historialGrupo'
import { contratoAlumno, contratoGrupo, obtenerHistorialAcademicoAlumno, obtenerHistorialAcademicoGrupo, VERSION_CONTRATO_HISTORIAL } from '../lib/seguimiento/contratoHistorial'
import { contextoFichaDescriptiva } from '../lib/seguimiento/consultaHistorial'

let fallos = 0
let total = 0
function verificar(ok: boolean, nombre: string) {
  total++
  if (!ok) fallos++
  console.log(`${ok ? '✓' : '✗'} ${nombre}`)
}
const leer = (r: string) => readFileSync(r, 'utf-8')

const D = 'doc-1', G = 'g-3a', C = 'ciclo-1', G0 = 'g-2b', C0 = 'ciclo-0'
const PER = [
  { id: 'p1', nombre: 'Primer trimestre', numero_periodo: 1, fecha_inicio: '2026-09-01', fecha_fin: '2026-11-30', ciclo_escolar_id: C },
  { id: 'p2', nombre: 'Segundo trimestre', numero_periodo: 2, fecha_inicio: '2026-12-01', fecha_fin: '2027-03-15', ciclo_escolar_id: C },
]
type Proy = { id: string; grupo?: string; ciclo?: string; ini: string; fin: string; conf: string; campos: string[]; periodo?: string | null }
const ps = (p: Proy) => ({ nombre: `Proyecto ${p.id}`, docente_id: D, grupo_id: p.grupo ?? G, ciclo_escolar_id: p.ciclo ?? C, periodo_evaluacion_id: p.periodo ?? null, campos_formativos: p.campos, fecha_inicio: p.ini, fecha_fin: p.fin, origen_resultados: 'fotografia', confirmado_en: p.conf })
const fila = (p: Proy, ins: string, alu: string, n: number, nivel: string, aspecto = 'logro_aprendizaje'): ResultadoProyectoGrupo => ({
  proyecto_id: p.id, alumno_id: alu, inscripcion_id: ins, indicador_numero: n, indicador_especifico: `Indicador ${n} de ${p.id}`, aspecto_general: aspecto as ResultadoProyectoGrupo['aspecto_general'],
  nivel: nivel as ResultadoProyectoGrupo['nivel'], confianza: 1, corregido_manualmente: false, observacion: null, proyectos_seguimiento: ps(p),
})
const A: Proy = { id: 'A', ini: '2026-10-05', fin: '2026-10-09', conf: '2026-10-10T10:00:00Z', campos: ['Lenguajes'], periodo: 'p1' }
const B: Proy = { id: 'B', ini: '2026-12-03', fin: '2026-12-08', conf: '2026-12-09T10:00:00Z', campos: ['Lenguajes', 'De lo Humano y lo Comunitario'] }
const X: Proy = { id: 'X', ini: '2026-11-28', fin: '2026-12-04', conf: '2026-12-05T10:00:00Z', campos: ['Lenguajes'] } // cruza periodos: sin periodo
const V: Proy = { id: 'V', grupo: G0, ciclo: C0, ini: '2025-10-01', fin: '2025-10-05', conf: '2025-10-06T10:00:00Z', campos: ['Lenguajes'] }
const FILAS = [
  fila(A, 'i-ana', 'ana', 1, 'destacado'), fila(A, 'i-ana', 'ana', 2, 'requiere_apoyo', 'participacion_colaboracion'), fila(A, 'i-ana', 'ana', 3, 'no_evaluado'),
  fila(B, 'i-ana', 'ana', 1, 'en_proceso'),
  fila(V, 'i-ana-0', 'ana', 1, 'requiere_apoyo'),
  fila(A, 'i-beto', 'beto', 1, 'logrado'),
]
const INS_ANA: InscripcionHistorial[] = [
  { inscripcionId: 'i-ana', grupoId: G, cicloEscolarId: C, estatus: 'activo', fechaInscripcion: '2026-08-20', grupoNombre: '3° A', cicloNombre: '2026-2027' },
  { inscripcionId: 'i-ana-0', grupoId: G0, cicloEscolarId: C0, estatus: 'baja', fechaInscripcion: '2025-08-20', grupoNombre: '2° B', cicloNombre: '2025-2026' },
]
const META = [A, B, X, V].map((p) => metadataDeProyecto(p.id, ps(p), PER))
const hAna = organizarHistorialAlumno(construirHistorialGrupo(FILAS.filter((f) => f.alumno_id === 'ana'), PER), INS_ANA, META)
const c = contratoAlumno(hAna, 'ana', G, C)!

;(async () => {
  // 1. Forma estable.
  verificar(c.version === VERSION_CONTRATO_HISTORIAL && VERSION_CONTRATO_HISTORIAL === 1, '1a. Contrato versionado (v1)')
  verificar(JSON.stringify(JSON.parse(JSON.stringify(c))) === JSON.stringify(c), '1b. Serializable (JSON puro, sin funciones ni fechas como objetos)')
  const cOtroOrden = contratoAlumno(organizarHistorialAlumno(construirHistorialGrupo(FILAS.filter((f) => f.alumno_id === 'ana').reverse(), PER), INS_ANA.slice().reverse(), META.slice().reverse()), 'ana', G, C)
  verificar(JSON.stringify(cOtroOrden) === JSON.stringify(c), '1c. Determinista: mismo contrato con entradas en otro orden')
  verificar(!/promedio|calificacion|calificación|nivelFinal|semaforo|recomendaci/i.test(JSON.stringify(c)), '1d. Sin calificaciones, promedios ni conclusiones')

  // 2. Alcance estricto.
  verificar(c.alcance.inscripcionId === 'i-ana' && c.alcance.grupoId === G && c.alcance.cicloEscolarId === C && c.alcance.grupoNombre === '3° A' && c.alcance.cicloNombre === '2026-2027', '2a. Alcance: la inscripción del grupo y ciclo indicados')
  verificar(!JSON.stringify(c).includes('Indicador 1 de V') && contratoAlumno(hAna, 'ana', G0, C0)!.resumen.proyectosConResultados === 1, '2b. Otra inscripción (otro grupo y ciclo) queda fuera; se obtiene solo pidiéndola')
  verificar(contratoAlumno(hAna, 'ana', 'g-ajeno', C) === null, '2c. Sin inscripción en ese grupo y ciclo: null (nunca otro alumno ni otro grupo)')

  // 3. Estados sin mezclar.
  const rA = c.periodos.flatMap((g) => g.proyectos).find((r) => r.proyecto.proyectoId === 'A')!
  const rX = c.periodos.flatMap((g) => g.proyectos).find((r) => r.proyecto.proyectoId === 'X')!
  verificar(rA.estado === 'con_resultados' && rA.conteo.indicadores === 3 && rA.conteo.evaluados === 2 && rA.conteo.sinEvaluar === 1 && rA.conteo.requiereApoyo === 1, '3a. Conteo: evaluados, Sin evaluar y Requiere apoyo separados')
  verificar(rA.estado === 'con_resultados' && rA.indicadores[2].evaluado === false && rA.indicadores[2].etiquetaNivel === 'Sin evaluar' && rA.indicadores[1].etiquetaNivel === 'Requiere apoyo' && rA.indicadores[1].aspecto.etiqueta === 'Participación y colaboración', '3b. Indicadores con nivel y etiqueta reales; «Sin evaluar» marcado como no evaluado; aspecto con su etiqueta')
  verificar(rX.estado === 'sin_registro' && c.resumen.proyectosSinRegistro === 1, '3c. «Sin registro»: proyecto del grupo sin resultados del alumno')
  verificar(JSON.stringify(c.resumen.indicadoresEnApoyo) === JSON.stringify([{ proyectoId: 'A', numero: 2, texto: 'Indicador 2 de A' }]), '3d. Necesidades de apoyo: solo indicadores confirmados en Requiere apoyo, con su proyecto')
  verificar(c.resumen.conteo.indicadores === 4 && c.resumen.distribucion.en_proceso === 1 && c.resumen.proyectosConResultados === 2, '3e. Resumen por conteo directo')

  // 4. Periodos, campos y avisos.
  verificar(c.periodos.map((g) => g.periodo?.id ?? 'sin').join() === 'p1,p2,sin' && rA.proyecto.periodo?.origen === 'registrado', '4a. Periodos por número, «Sin periodo asignado» al final; origen del periodo')
  const rB = c.periodos.flatMap((g) => g.proyectos).find((r) => r.proyecto.proyectoId === 'B')!
  verificar(rB.proyecto.campoFormativoAtribuido === null && rB.proyecto.camposFormativos.length === 2 && rA.proyecto.campoFormativoAtribuido === 'Lenguajes' && rB.proyecto.periodo?.origen === 'fechas', '4b. Campo atribuido solo con un campo; periodo deducido de fechas marcado')
  verificar(JSON.stringify(c.avisos) === JSON.stringify([{ codigo: 'proyectos_sin_periodo', cantidad: 1 }, { codigo: 'proyectos_sin_registro', cantidad: 1 }]), '4c. Avisos explícitos de lo que falta (sin rellenar)')
  const vacio = contratoAlumno(organizarHistorialAlumno(construirHistorialGrupo([], PER), [{ ...INS_ANA[0] }], []), 'ana', G, C)!
  verificar(vacio.avisos[0].codigo === 'sin_resultados_confirmados' && vacio.periodos.length === 0, '4d. Sin resultados: aviso, nunca datos supuestos')

  // 5. Vista grupal.
  const insGrupo: InscripcionDelGrupo[] = [{ inscripcionId: 'i-ana', alumnoId: 'ana', nombre: 'Ana', estatus: 'activo' }, { inscripcionId: 'i-beto', alumnoId: 'beto', nombre: 'Beto', estatus: 'activo' }]
  const hg = construirHistorialGrupo(FILAS.filter((f) => f.proyecto_id !== 'V'), PER)
  const con = construirConcentradoGrupo(hg, insGrupo, { periodoId: 'p1' })
  const g = contratoGrupo(con, { grupoId: G, grupoNombre: '3° A', cicloEscolarId: C, filtro: { periodoId: 'p1' } })
  verificar(g.version === 1 && g.alcance.filtro.periodoId === 'p1' && g.proyectos.map((p) => p.proyecto.proyectoId).join() === 'A' && g.resumen.alumnos === 2, '5a. Contrato grupal versionado, con el filtro aplicado en su alcance')
  verificar(JSON.stringify(g.resumen.distribucion) === JSON.stringify(con.distribucion) && g.resumen.indicadoresRequierenApoyo === con.indicadoresRequierenApoyo, '5b. Mismos conteos que el concentrado (una sola fuente)')
  const beto = g.alumnos.find((a) => a.alumnoId === 'beto')!
  verificar(beto.conteo.indicadores === 1 && beto.conteo.sinRegistro === 0 && g.alumnos.find((a) => a.alumnoId === 'ana')!.indicadoresEnApoyo.length === 1, '5c. Por alumno: conteos, Sin registro y Requiere apoyo')

  // 6. Reutiliza las lecturas existentes (sin consultas propias).
  const tablas: string[] = []
  const datos: Record<string, unknown[]> = {
    inscripciones: INS_ANA.map((i) => ({ id: i.inscripcionId, alumno_id: 'ana', grupo_id: i.grupoId, ciclo_escolar_id: i.cicloEscolarId, estatus: i.estatus, fecha_inscripcion: i.fechaInscripcion, grupos: { grado: i.grupoNombre![0], grupo: i.grupoNombre!.slice(-1), nombre_grupo: null, docente_id: D }, ciclos_escolares: { nombre: i.cicloNombre }, alumnos: { nombre: 'Ana' } })),
    seguimiento_resultados: FILAS.filter((f) => f.alumno_id === 'ana'),
    periodos_evaluacion: PER,
    proyectos_seguimiento: [A, B, X, V].map((p) => ({ id: p.id, ...ps(p) })),
  }
  const sb = { from: (t: string) => { tablas.push(t); const b: Record<string, unknown> = {}; for (const m of ['select', 'eq', 'in', 'not', 'order']) b[m] = () => b; b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: datos[t], error: null }).then(ok); return b } } as unknown as SupabaseClient
  const oa = await obtenerHistorialAcademicoAlumno(sb, 'ana', D, G, C)
  verificar(oa?.alcance.inscripcionId === 'i-ana' && tablas.length === 4, `6a. Alumno: mismas 4 consultas del historial individual (${tablas.join(', ')})`)
  tablas.length = 0
  await obtenerHistorialAcademicoGrupo(sb, { grupoId: G, grupoNombre: '3° A', cicloEscolarId: C })
  verificar([...tablas].sort().join() === 'inscripciones,periodos_evaluacion,seguimiento_resultados', '6b. Grupo: mismas 3 consultas del concentrado')
  const fuente = leer('lib/seguimiento/contratoHistorial.ts')
  verificar(!/\.from\(|\.rpc\(|anthropic|openai|generateText|streamText|insert\(|update\(/.test(fuente), '6c. El contrato no consulta por su cuenta, no escribe y no usa IA')

  // 7. Primer consumidor: la ficha descriptiva.
  const ficha = contextoFichaDescriptiva(c)
  verificar(ficha.includes('Proyecto «Proyecto A» (Primer trimestre; Lenguajes): 1 Dominio destacado · 1 Requiere apoyo · 1 Sin evaluar.') && ficha.includes('  · 2. Indicador 2 de A — Requiere apoyo') && ficha.includes('Sin registro (no tiene resultados) en: Proyecto X') && contextoFichaDescriptiva(null).includes('No hay resultados confirmados'), '7a. La ficha descriptiva se redacta desde el contrato (mismo texto que antes)')
  verificar(/obtenerHistorialAcademicoAlumno\(supabaseUser, clasificacion\.entidades_resueltas\.alumno_id, userId, sesion\.grupo_activo_id, sesion\.ciclo_escolar_id\)/.test(leer('app/api/chat/route.ts')), '7b. El Chat IA obtiene el contrato del grupo y ciclo activos (mismo único llamado de IA)')

  console.log(`\n${total - fallos}/${total} verificaciones correctas`)
  process.exit(fallos ? 1 : 0)
})()
