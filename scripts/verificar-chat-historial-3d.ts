// Hito 3, etapa 3d — historial académico en el Chat IA.
// Sin red, sin IA: lectura determinista de periodo/campo/proyecto,
// herramientas de resultados (alumno y grupo), «este alumno» desde la
// pantalla, separación por docente/grupo/inscripción/ciclo, apoyo,
// contexto de ficha descriptiva y reglas del clasificador.
//   npx tsx scripts/verificar-chat-historial-3d.ts

import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ejecutarHerramientaDeModulo, type ContextoEjecucionHerramienta } from '../lib/asistente/herramientasModulo'
import { clasificacionPreguntaPlaneacion, type ClasificacionNivel0 } from '../lib/clasificadorNivel0'
import { alumnoEnPantallaDelGrupo, campoEnTexto, contextoFichaDescriptiva, periodoEnTexto, proyectoEnTexto } from '../lib/seguimiento/consultaHistorial'
import { construirHistorialGrupo, metadataDeProyecto, organizarHistorialAlumno } from '../lib/seguimiento/historialGrupo'
import { detectarConsultaPlaneacion } from '../lib/planeacion/detectarConsultaPlaneacion'
import type { SesionContexto } from '../lib/sesionContexto'

let fallos = 0
let total = 0
function verificar(ok: boolean, nombre: string) {
  total++
  if (!ok) fallos++
  console.log(`${ok ? '✓' : '✗'} ${nombre}`)
}
const leer = (r: string) => readFileSync(r, 'utf-8')

// ---------- Datos ----------
const D = 'doc-1', G = 'g-3a', C = 'ciclo-1', G_OTRO = 'g-2b', C_ANT = 'ciclo-0'
const PER = [
  { id: 'p1', nombre: 'Primer trimestre', numero_periodo: 1, fecha_inicio: '2026-09-01', fecha_fin: '2026-11-30', ciclo_escolar_id: C },
  { id: 'p2', nombre: 'Segundo trimestre', numero_periodo: 2, fecha_inicio: '2026-12-01', fecha_fin: '2027-03-15', ciclo_escolar_id: C },
]
type Proy = { id: string; nombre: string; grupo?: string; ciclo?: string; ini: string; fin: string; conf: string; campos: string[] }
const PA: Proy = { id: 'A', nombre: '¡A contar historias! Elaboración de cuentos propios', ini: '2026-10-05', fin: '2026-10-09', conf: '2026-10-10T10:00:00Z', campos: ['Lenguajes'] }
const PB: Proy = { id: 'B', nombre: 'Las leyendas de nuestra comunidad', ini: '2026-12-03', fin: '2026-12-08', conf: '2026-12-09T10:00:00Z', campos: ['Lenguajes', 'De lo Humano y lo Comunitario'] }
const PV: Proy = { id: 'V', nombre: 'Proyecto del ciclo anterior', grupo: G_OTRO, ciclo: C_ANT, ini: '2025-10-01', fin: '2025-10-05', conf: '2025-10-06T10:00:00Z', campos: ['Lenguajes'] }
const ps = (p: Proy) => ({ nombre: p.nombre, docente_id: D, grupo_id: p.grupo ?? G, ciclo_escolar_id: p.ciclo ?? C, periodo_evaluacion_id: null, campos_formativos: p.campos, fecha_inicio: p.ini, fecha_fin: p.fin, origen_resultados: 'fotografia', confirmado_en: p.conf })
const fila = (p: Proy, ins: string, alu: string, n: number, nivel: string) => ({ proyecto_id: p.id, alumno_id: alu, inscripcion_id: ins, indicador_numero: n, indicador_especifico: `Indicador ${n} de ${p.id}`, aspecto_general: 'logro_aprendizaje', nivel, confianza: 1, corregido_manualmente: false, observacion: null, proyectos_seguimiento: ps(p) })
const RESULTADOS = [
  fila(PA, 'i-ana', 'ana', 1, 'destacado'), fila(PA, 'i-ana', 'ana', 2, 'requiere_apoyo'), fila(PA, 'i-ana', 'ana', 3, 'en_proceso'),
  fila(PA, 'i-beto', 'beto', 1, 'logrado'), fila(PA, 'i-beto', 'beto', 2, 'no_evaluado'),
  fila(PB, 'i-beto', 'beto', 1, 'requiere_apoyo'),
  fila(PV, 'i-ana-ant', 'ana', 1, 'requiere_apoyo'), // otra inscripción (otro grupo y ciclo)
]
const INSCRIPCIONES = [
  { id: 'i-ana', alumno_id: 'ana', grupo_id: G, ciclo_escolar_id: C, estatus: 'activo', fecha_inscripcion: '2026-08-20', alumnos: { nombre: 'Ana López' }, grupos: { grado: '3', grupo: 'A', nombre_grupo: null, docente_id: D }, ciclos_escolares: { nombre: '2026-2027' } },
  { id: 'i-beto', alumno_id: 'beto', grupo_id: G, ciclo_escolar_id: C, estatus: 'activo', fecha_inscripcion: '2026-08-20', alumnos: { nombre: 'Beto Ruiz' }, grupos: { grado: '3', grupo: 'A', nombre_grupo: null, docente_id: D }, ciclos_escolares: { nombre: '2026-2027' } },
  { id: 'i-ceci', alumno_id: 'ceci', grupo_id: G, ciclo_escolar_id: C, estatus: 'activo', fecha_inscripcion: '2026-08-20', alumnos: { nombre: 'Ceci Mora' }, grupos: { grado: '3', grupo: 'A', nombre_grupo: null, docente_id: D }, ciclos_escolares: { nombre: '2026-2027' } },
  { id: 'i-ana-ant', alumno_id: 'ana', grupo_id: G_OTRO, ciclo_escolar_id: C_ANT, estatus: 'baja', fecha_inscripcion: '2025-08-20', alumnos: { nombre: 'Ana López' }, grupos: { grado: '2', grupo: 'B', nombre_grupo: null, docente_id: D }, ciclos_escolares: { nombre: '2025-2026' } },
]
const PROYECTOS = [PA, PB, PV].map((p) => ({ id: p.id, ...ps(p) }))
const NECESIDADES = [{ alumno_id: 'ceci', tipo: 'Lectura', descripcion: 'Apoyo en lectura', activa: true }]

// Cliente simulado con filtros reales (eq / in / not is null), y registro de consultas.
const valorEn = (f: Record<string, unknown>, ruta: string) => ruta.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], f)
function cliente(opciones: { periodos?: unknown[]; fallar?: string } = {}) {
  const tablas: Record<string, Record<string, unknown>[]> = { seguimiento_resultados: RESULTADOS, periodos_evaluacion: (opciones.periodos ?? PER) as Record<string, unknown>[], inscripciones: INSCRIPCIONES, proyectos_seguimiento: PROYECTOS, necesidades_apoyo: NECESIDADES }
  const consultas: string[] = []
  const sb = {
    from: (tabla: string) => {
      consultas.push(tabla)
      const filtros: ((f: Record<string, unknown>) => boolean)[] = []
      const b: Record<string, unknown> = {
        select: () => b, order: () => b,
        eq: (c: string, v: unknown) => { filtros.push((f) => valorEn(f, c) === v); return b },
        in: (c: string, vs: unknown[]) => { filtros.push((f) => vs.includes(valorEn(f, c))); return b },
        not: (c: string, op: string, v: unknown) => { if (op === 'is' && v === null) filtros.push((f) => valorEn(f, c) != null); return b },
        then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(opciones.fallar === tabla ? { data: null, error: { message: 'falla' } } : { data: (tablas[tabla] ?? []).filter((f) => filtros.every((p) => p(f))), error: null }).then(ok, ko),
      }
      return b
    },
  } as unknown as SupabaseClient
  return { sb, consultas }
}
const SESION = { docente_id: D, institucion_id: null, ciclo_escolar_id: C, grupo_activo_id: G, fecha_actual: '2026-10-20', alumnos_del_grupo_activo: [{ alumno_id: 'ana', nombre_completo: 'Ana López', sexo: 'M', numero_lista: 1 }, { alumno_id: 'beto', nombre_completo: 'Beto Ruiz', sexo: 'H', numero_lista: 2 }, { alumno_id: 'ceci', nombre_completo: 'Ceci Mora', sexo: 'M', numero_lista: 3 }], grupo_activo_datos: { grado: '3°', grupo: 'A' } } as unknown as SesionContexto
const clasif = (intencion: string, alumno?: { id: string; nombre: string } | { ambiguo: string[] }): ClasificacionNivel0 => ({
  ...clasificacionPreguntaPlaneacion(),
  intencion_principal: intencion as ClasificacionNivel0['intencion_principal'],
  nivel_ejecucion: 1, requiere_ia: false,
  entidades_resueltas: alumno && 'id' in alumno
    ? { alumno_id: alumno.id, alumno_nombre_detectado: alumno.nombre, alumno_ambiguo: false, opciones_alumno_ambiguo: [] }
    : { alumno_id: null, alumno_nombre_detectado: null, alumno_ambiguo: !!(alumno && 'ambiguo' in alumno), opciones_alumno_ambiguo: alumno && 'ambiguo' in alumno ? alumno.ambiguo : [] },
})
const preguntar = async (intencion: string, mensaje: string, extra: Partial<ContextoEjecucionHerramienta> & { alumno?: { id: string; nombre: string } | { ambiguo: string[] }; periodos?: unknown[]; fallar?: string } = {}) => {
  const { sb, consultas } = cliente({ periodos: extra.periodos, fallar: extra.fallar })
  const r = await ejecutarHerramientaDeModulo(clasif(intencion, extra.alumno), { sb, sesion: SESION, userId: D, zonaHoraria: 'America/Hermosillo', canal: extra.canal ?? 'text', mensaje, alumnoEnPantalla: extra.alumnoEnPantalla ?? null })
  return { texto: r ?? '', consultas }
}
const navegacion = (t: string) => { const m = t.match(/\[\[NAVEGACION:([^\]]+)\]\]/); return m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf-8')) : null }
const SIN_CONCLUSIONES = /promedio|calificaci[oó]n|reprob|aprob[oó]|en riesgo|rezag|bajo rendimiento|deber[ií]a/i

;(async () => {
  // 1. Lectura determinista del pedido.
  verificar(periodoEnTexto('Muéstrame los resultados del primer trimestre', PER).tipo === 'encontrado' && (periodoEnTexto('resultados del 2do trimestre', PER) as { periodo: { id: string } }).periodo.id === 'p2' && (periodoEnTexto('trimestre 1', PER) as { periodo: { id: string } }).periodo.id === 'p1', '1a. Periodo: «primer trimestre», «2do trimestre», «trimestre 1»')
  verificar((periodoEnTexto('¿cómo vamos este trimestre?', PER, '2026-10-20') as { periodo: { id: string } }).periodo.id === 'p1' && periodoEnTexto('¿cómo vamos este trimestre?', PER).tipo === 'no_existe', '1b. «Este trimestre» por la fecha de hoy (sin fecha: no se supone)')
  verificar(periodoEnTexto('resultados del tercer trimestre', PER).tipo === 'no_existe' && periodoEnTexto('¿cómo va mi grupo?', PER).tipo === 'ninguno' && periodoEnTexto('resultados por periodo', PER).tipo === 'ninguno', '1c. Periodo inexistente detectado; sin mención o «por periodo»: sin filtro')
  verificar(campoEnTexto('¿Qué resultados tenemos en Lenguajes?') === 'Lenguajes' && campoEnTexto('¿cómo vamos en matemáticas?') === null && campoEnTexto('lenguajes y ética') === null && campoEnTexto('en saberes') === 'Saberes y Pensamiento Científico', '1d. Campo formativo solo con palabras inequívocas; nunca «matemáticas»')
  const proyectos = construirHistorialGrupo(RESULTADOS as never, PER).proyectos
  verificar(proyectoEnTexto('¿cómo salió el grupo en contar historias?', proyectos).tipo === 'encontrado' && proyectoEnTexto('¿cómo va mi grupo?', proyectos).tipo === 'ninguno', '1e. Proyecto nombrado en el mensaje')
  const frases = ['¿Cómo va este alumno?', '¿Qué alumnos requieren apoyo?', '¿En qué indicadores necesita mejorar?', '¿Cómo va mi grupo?', 'Muéstrame los resultados del primer trimestre.', '¿Qué resultados tenemos en Lenguajes?']
  verificar(frases.every((f) => detectarConsultaPlaneacion(f, '2026-10-20') === null), '1f. Ninguna de las 6 frases es interceptada por la consulta de planeaciones')

  // 2. Grupo.
  const g = await preguntar('consultar_resultados_grupo', '¿Cómo va mi grupo?')
  verificar(g.texto.startsWith('Resultados confirmados de 3° A — 2 proyectos, 3 alumnos') && g.texto.includes('1 Dominio destacado') && g.texto.includes('2 indicadores confirmados en Requiere apoyo (2 alumnos)'), '2a. «¿Cómo va mi grupo?»: proyectos, alumnos y niveles reales')
  verificar(g.texto.includes('Ana López') && g.texto.includes('Indicador 2 de A') && g.texto.includes('1 indicador quedó Sin evaluar') && g.texto.includes('2 alumnos activos no tienen registro en al menos un proyecto') && g.texto.includes('Evaluación › Concentrado'), '2b. Requiere apoyo con indicador; Sin evaluar y Sin registro separados; remite al concentrado')
  verificar(!g.texto.includes('ciclo anterior') && !SIN_CONCLUSIONES.test(g.texto), '2c. Solo el grupo y ciclo activos; sin promedios ni conclusiones')
  verificar([...new Set(g.consultas)].sort().join() === 'inscripciones,periodos_evaluacion,seguimiento_resultados' && g.consultas.length === 3, '2d. Grupo: 3 consultas (sin N+1), cero llamadas de IA')
  const t1 = await preguntar('consultar_resultados_grupo', 'Muéstrame los resultados del primer trimestre')
  verificar(t1.texto.includes('del Primer trimestre') && t1.texto.includes('1 proyecto') && !t1.texto.includes('Indicador 1 de B'), '2e. Filtro por periodo (primer trimestre)')
  const lg = await preguntar('consultar_resultados_grupo', '¿Qué resultados tenemos en Lenguajes?')
  verificar(lg.texto.includes('en Lenguajes') && lg.texto.includes('los indicadores no se atribuyen a un campo en particular'), '2f. Filtro por campo, aclarando que no hay atribución por indicador')
  verificar((await preguntar('consultar_resultados_grupo', 'resultados del tercer trimestre')).texto.startsWith('No encontré «tercer trimestre»') && (await preguntar('consultar_resultados_grupo', 'resultados del primer trimestre', { periodos: [] })).texto.includes('Todavía no hay periodos de evaluación registrados'), '2g. Periodo inexistente o sin periodos: se dice con naturalidad')
  verificar((await preguntar('consultar_resultados_grupo', '¿cómo va mi grupo?', { fallar: 'seguimiento_resultados' })).texto.includes('No fue posible consultar los resultados confirmados del grupo'), '2h. Error de consulta visible (nunca «sin resultados»)')
  const voz = await preguntar('consultar_resultados_grupo', '¿Cómo va mi grupo?', { canal: 'voice' })
  verificar(voz.texto.length < g.texto.length && voz.texto.includes('Ana López: 1 indicador'), '2i. Canal de voz: respuesta más breve')

  // 3. Alumno.
  const a = await preguntar('consultar_resultados_alumno', '¿Cómo va Ana?', { alumno: { id: 'ana', nombre: 'Ana López' } })
  verificar(a.texto.startsWith('Ana López — 1 proyecto con resultados confirmados') && a.texto.includes('Indicadores confirmados en Requiere apoyo:\n  – 2. Indicador 2 de A') && a.texto.includes('Indicadores confirmados En proceso') && a.texto.includes('Sin registro en: Las leyendas'), '3a. «¿Cómo va [alumno]?»: niveles, Requiere apoyo, En proceso y Sin registro')
  verificar(!a.texto.includes('ciclo anterior') && !a.texto.includes('Indicador 1 de V') && !SIN_CONCLUSIONES.test(a.texto), '3b. Separación: solo su inscripción del grupo y ciclo activos; sin conclusiones')
  const nav = navegacion(a.texto)
  verificar(nav?.modulo === 'lista' && nav.accion === 'abrir_registro' && nav.alumnoId === 'ana' && nav.pestana === 'evaluaciones' && nav.automatica === false, '3c. Botón «Abrir en Lista» → ficha, pestaña Evaluaciones (sin navegar solo)')
  const este = await preguntar('consultar_resultados_alumno', '¿En qué indicadores necesita mejorar?', { alumnoEnPantalla: { alumno_id: 'beto', nombre: 'Beto Ruiz' } })
  verificar(este.texto.startsWith('Beto Ruiz — 2 proyectos') && este.texto.includes('1 indicador quedó Sin evaluar'), '3d. «Este alumno»: el abierto en pantalla')
  verificar((await preguntar('consultar_resultados_alumno', '¿cómo va Ceci?', { alumno: { id: 'ceci', nombre: 'Ceci Mora' } })).texto.includes('Ceci Mora no tiene resultados confirmados: hay 2 proyectos confirmados del grupo sin registro suyo'), '3e. Sin resultados: se dice con naturalidad (Sin registro)')
  verificar((await preguntar('consultar_resultados_alumno', '¿cómo va este alumno?')).texto === '¿De qué alumno quieres consultar los resultados?' && (await preguntar('consultar_resultados_alumno', '¿cómo va Ana?', { alumno: { ambiguo: ['Ana López', 'Ana Ruiz'] } })).texto === '¿Te refieres a Ana López o a Ana Ruiz?', '3f. Sin alumno o ambiguo: aclaración determinista')
  const at = await preguntar('consultar_resultados_alumno', '¿cómo le fue a Beto en el segundo trimestre?', { alumno: { id: 'beto', nombre: 'Beto Ruiz' } })
  verificar(at.texto.includes('del Segundo trimestre') && at.texto.includes('Las leyendas') && !at.texto.includes('¡A contar'), '3g. Alumno filtrado por periodo')
  verificar(a.consultas.filter((t) => t === 'inscripciones').length === 1 && a.consultas.length === 5, '3h. Alumno: 5 consultas (historial + periodos del ciclo), cero IA')

  // 4. Apoyo (consulta existente ampliada).
  const ap = await preguntar('consultar_apoyo', '¿Qué alumnos requieren apoyo?')
  verificar(ap.texto.includes('Alumnos con necesidad de apoyo registrada (1):\n• Ceci Mora — Lectura') && ap.texto.includes('Indicadores confirmados en Requiere apoyo en las hojas de evaluación (2):') && ap.texto.includes('• Beto Ruiz: 1. Indicador 1 de B'), '4a. «¿Qué alumnos requieren apoyo?»: necesidades registradas e indicadores confirmados, por separado')
  verificar((await preguntar('consultar_apoyo', '¿Qué alumnos requieren apoyo?', { fallar: 'periodos_evaluacion' })).texto.includes('No pude consultar los resultados confirmados'), '4b. Si fallan los resultados, se responde lo registrado y se avisa')

  // 5. «Este alumno» validado y ficha descriptiva.
  const alumnos = SESION.alumnos_del_grupo_activo
  verificar(alumnoEnPantallaDelGrupo('Pantalla actual: ficha_alumno\nAlumno seleccionado: ana lópez', alumnos)?.alumno_id === 'ana' && alumnoEnPantallaDelGrupo('Alumno seleccionado: Ana', alumnos) === null && alumnoEnPantallaDelGrupo('Alumno seleccionado: Zoe Paz', alumnos) === null && alumnoEnPantallaDelGrupo(undefined, alumnos) === null, '5a. Alumno en pantalla: solo coincidencia exacta con el grupo activo')
  const ins = INSCRIPCIONES.filter((i) => i.alumno_id === 'ana').map((i) => ({ inscripcionId: i.id, grupoId: i.grupo_id, cicloEscolarId: i.ciclo_escolar_id, estatus: i.estatus, fechaInscripcion: i.fecha_inscripcion, grupoNombre: '3° A', cicloNombre: i.ciclos_escolares.nombre }))
  const hAna = organizarHistorialAlumno(construirHistorialGrupo(RESULTADOS.filter((f) => f.alumno_id === 'ana') as never, PER), ins, PROYECTOS.map((p) => metadataDeProyecto(p.id, p as never, PER)))
  const ficha = contextoFichaDescriptiva(hAna, G, C)
  verificar(ficha.includes('RESULTADOS ACADÉMICOS CONFIRMADOS') && ficha.includes('2. Indicador 2 de A — Requiere apoyo') && ficha.includes('Sin registro') && !ficha.includes('Indicador 1 de V') && ficha.includes('no los conviertas en calificaciones'), '5b. Ficha descriptiva: resultados confirmados reales del grupo y ciclo activos, sin convertirlos en calificaciones')
  verificar(contextoFichaDescriptiva(organizarHistorialAlumno(construirHistorialGrupo([], PER), [], []), G, C).includes('No hay resultados confirmados'), '5c. Ficha sin resultados: se indica, sin suponer desempeño')
  const ruta = leer('app/api/chat/route.ts')
  verificar(/contextoFichaDescriptiva\(historialAlumno, sesion\.grupo_activo_id, sesion\.ciclo_escolar_id\)/.test(ruta) && /alumnoEnPantalla: alumnoEnPantallaDelGrupo\(contexto, sesion\.alumnos_del_grupo_activo\)/.test(ruta), '5d. Ruta: ficha con resultados en su contexto; «este alumno» validado contra el grupo activo')

  // 6. Clasificador y ausencia de IA nueva.
  const clasificador = leer('lib/clasificadorNivel0.ts')
  verificar(/"consultar_resultados_alumno" \| "consultar_resultados_grupo"/.test(clasificador) && /21\. RESULTADOS DE EVALUACIÓN/.test(clasificador) && /"¿cómo va este alumno\?"/.test(clasificador) && /"¿cómo va mi grupo\?"/.test(clasificador) && /\("cómo va \[nombre\]" es la regla 21, no esta\.\)/.test(clasificador), '6a. Clasificador: dos intenciones nuevas con sus ejemplos; «cómo va [nombre]» pasa de la regla 14 a la 21')
  const nuevos = ['lib/seguimiento/consultaHistorial.ts', 'lib/asistente/herramientasModulo.ts'].map(leer).join('\n')
  verificar(!/anthropic|openai|messages\.create|generateText|streamText/i.test(nuevos) && !/\.(insert|update|upsert)\(|\.rpc\(/.test(leer('lib/seguimiento/consultaHistorial.ts')), '6b. Herramientas sin llamadas de IA ni escrituras')

  console.log(`\n${total - fallos}/${total} verificaciones correctas`)
  process.exit(fallos ? 1 : 0)
})()
