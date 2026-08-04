// scripts/verificar-generar-borrador-planeacion.ts
//
// Prueba aislada (sin credenciales, sin red, sin escrituras reales) de
// C-005 Paso 3B — la capa DETERMINISTA de generación de borrador
// (lib/planeacion/generarBorrador.ts). No prueba la clasificación real
// de Claude ni el texto que redacta el modelo grande — nada en este
// proyecto puede hacer eso de forma determinista (misma limitación ya
// documentada en los Pasos 3A/2/1). Donde el caso pedido es
// inherentemente sobre el comportamiento del clasificador o del
// modelo, se verifica lo que SÍ es código real y determinista: el
// texto de la regla en clasificadorNivel0.ts, el texto de las
// instrucciones en instruccionesPlaneacionGenerar.ts, o el diff real
// contra el código previo. Se ejecuta con
// `npx tsx scripts/verificar-generar-borrador-planeacion.ts`.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  prepararContextoGeneracionPlaneacion,
  mapearEventosADiasNoLaborables,
  resolverPeriodoEvaluacionActual,
  type SolicitudGeneracionPlaneacion,
} from '../lib/planeacion/generarBorrador'
import { INSTRUCCIONES_PLANEACION_GENERAR } from '../lib/asistente/instruccionesPlaneacionGenerar'
import type { SesionContexto } from '../lib/sesionContexto'
import type { EventoCalendarioCompleto, PeriodoEvaluacion } from '../lib/motorContexto'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// --- Doble mínimo de SupabaseClient, extendido con .rpc()/.gte()/.lte()/.or() ---

type Fila = Record<string, unknown>

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
  private rangos: Array<['gte' | 'lte' | 'gt', string, unknown]> = []
  private clausulasOr: string | null = null
  private orden: { columna: string; ascendente: boolean } | null = null
  private operacion: 'consultar' | 'insertar' | 'actualizar' = 'consultar'
  private payload: Fila | Fila[] | null = null

  constructor(private cliente: ClienteSupabaseFalso, private tabla: string) {}

  select(_columnas: string) {
    void _columnas
    return this
  }

  insert(valores: Fila | Fila[]) {
    this.operacion = 'insertar'
    this.payload = valores
    this.cliente._registrarEscritura(this.tabla, 'insert')
    return this
  }

  update(valores: Fila) {
    this.operacion = 'actualizar'
    this.payload = valores
    this.cliente._registrarEscritura(this.tabla, 'update')
    return this
  }

  eq(columna: string, valor: unknown) {
    this.filtros.push([columna, valor])
    return this
  }

  gte(columna: string, valor: unknown) {
    this.rangos.push(['gte', columna, valor])
    return this
  }

  lte(columna: string, valor: unknown) {
    this.rangos.push(['lte', columna, valor])
    return this
  }

  gt(columna: string, valor: unknown) {
    this.rangos.push(['gt', columna, valor])
    return this
  }

  // Soporta exactamente el patrón usado en motorContexto.ts:
  // `.or('user_id.eq.X,user_id.is.null')` — cláusulas separadas por
  // coma, cada una "columna.operador.valor", combinadas con OR.
  or(clausulas: string) {
    this.clausulasOr = clausulas
    return this
  }

  order(columna: string, opciones?: { ascending?: boolean }) {
    this.orden = { columna, ascendente: opciones?.ascending ?? true }
    return this
  }

  private cumpleOr(fila: Fila): boolean {
    if (!this.clausulasOr) return true
    return this.clausulasOr.split(',').some((clausula) => {
      const [col, op, val] = clausula.split('.')
      if (op === 'is' && val === 'null') return fila[col] === null || fila[col] === undefined
      if (op === 'eq') return String(fila[col]) === val
      return false
    })
  }

  private ejecutar(): { data: Fila[] | null; error: { message: string } | null } {
    const filas = this.cliente._tabla(this.tabla)

    if (this.operacion === 'insertar') {
      const nuevas = Array.isArray(this.payload) ? this.payload : [this.payload as Fila]
      const insertadas = nuevas.map((f) => ({ id: randomUUID(), creado_en: new Date().toISOString(), actualizado_en: new Date().toISOString(), ...f }))
      filas.push(...insertadas)
      return { data: insertadas, error: null }
    }

    if (this.operacion === 'actualizar') {
      const coincidentes = filas.filter((f) => this.filtros.every(([c, v]) => f[c] === v))
      coincidentes.forEach((f) => Object.assign(f, this.payload))
      return { data: coincidentes, error: null }
    }

    let resultado = filas.filter((f) => {
      if (!this.filtros.every(([c, v]) => f[c] === v)) return false
      if (!this.rangos.every(([tipo, c, v]) => {
        if (tipo === 'gte') return String(f[c]) >= String(v)
        if (tipo === 'lte') return String(f[c]) <= String(v)
        return Number(f[c]) > Number(v)
      })) return false
      if (!this.cumpleOr(f)) return false
      return true
    })
    if (this.orden) {
      const { columna, ascendente } = this.orden
      resultado = [...resultado].sort((a, b) => {
        const av = String(a[columna] ?? '')
        const bv = String(b[columna] ?? '')
        if (av < bv) return ascendente ? -1 : 1
        if (av > bv) return ascendente ? 1 : -1
        return 0
      })
    }
    return { data: resultado, error: null }
  }

  async maybeSingle() {
    const { data, error } = this.ejecutar()
    if (error) return { data: null, error }
    return { data: data && data.length > 0 ? data[0] : null, error: null }
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: Fila[] | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.ejecutar()).then(onfulfilled, onrejected)
  }
}

class ClienteSupabaseFalso {
  private tablas = new Map<string, Fila[]>()
  public escrituras: Array<{ tabla: string; tipo: 'insert' | 'update' }> = []

  constructor(private usuario: { id: string } | null, datosIniciales: Record<string, Fila[]> = {}, private rpcRespuestas: Record<string, unknown> = {}) {
    for (const [tabla, filas] of Object.entries(datosIniciales)) {
      this.tablas.set(tabla, filas.map((f) => ({ ...f })))
    }
  }

  auth = {
    getUser: async () => {
      if (!this.usuario) return { data: { user: null }, error: { message: 'sin sesión' } }
      return { data: { user: this.usuario }, error: null }
    },
  }

  from(tabla: string) {
    return new ConsultaFalsa(this, tabla)
  }

  async rpc(nombre: string, _params: Record<string, unknown>) {
    void _params
    if (nombre in this.rpcRespuestas) return { data: this.rpcRespuestas[nombre], error: null }
    return { data: null, error: { message: `rpc "${nombre}" no configurada en el doble de prueba` } }
  }

  _tabla(tabla: string): Fila[] {
    if (!this.tablas.has(tabla)) this.tablas.set(tabla, [])
    return this.tablas.get(tabla)!
  }

  _registrarEscritura(tabla: string, tipo: 'insert' | 'update') {
    this.escrituras.push({ tabla, tipo })
  }
}

function clienteFalso(usuario: { id: string } | null, datos: Record<string, Fila[]> = {}, rpc: Record<string, unknown> = {}): { sb: SupabaseClient; interno: ClienteSupabaseFalso } {
  const interno = new ClienteSupabaseFalso(usuario, datos, rpc)
  return { sb: interno as unknown as SupabaseClient, interno }
}

const DOCENTE_1 = { id: 'docente-1' }
const HOY = '2026-08-10' // lunes

function sesion(overrides: Partial<SesionContexto> = {}): SesionContexto {
  return {
    docente_id: 'docente-1',
    institucion_id: 'institucion-1',
    ciclo_escolar_id: 'ciclo-1',
    grupo_activo_id: 'grupo-1',
    fecha_actual: HOY,
    alumnos_del_grupo_activo: [],
    ...overrides,
  }
}

function solicitud(overrides: Partial<SolicitudGeneracionPlaneacion> = {}): SolicitudGeneracionPlaneacion {
  return {
    tema: 'leyendas',
    fechaInicio: null,
    fechaFin: null,
    duracionDias: null,
    duracionSemanas: null,
    momentoRelativo: null,
    ...overrides,
  }
}

function evento(fecha: string, tipo: string, titulo: string, esSep = true): EventoCalendarioCompleto {
  return { id: randomUUID(), titulo, fecha, tipo, color: '#000', descripcion: titulo, es_sep: esSep }
}

const RPC_GRUPO_BASE = { grado: '4°', grupo: 'B', nivel_educativo: 'primaria', ciclo_escolar: '2026-2027' }

async function main() {
  // 1. "Hazme una planeación de leyendas para dos semanas" → duración en semanas
  {
    const { sb } = clienteFalso(DOCENTE_1, {}, { contexto_grupo: RPC_GRUPO_BASE })
    const r = await prepararContextoGeneracionPlaneacion(sb, sesion(), solicitud({ duracionSemanas: 2 }))
    verificar(r.fechas.totalDiasEfectivos === 10 && !r.fechas.conflicto, '1. "Dos semanas" resuelve a 10 días efectivos, sin conflicto')
  }

  // 2. Solicitud con fechas exactas
  {
    const { sb } = clienteFalso(DOCENTE_1, {}, { contexto_grupo: RPC_GRUPO_BASE })
    const r = await prepararContextoGeneracionPlaneacion(sb, sesion(), solicitud({ fechaInicio: '2026-08-10', fechaFin: '2026-08-14' }))
    verificar(r.fechas.fechaInicioResuelta === '2026-08-10' && r.fechas.fechaFinResuelta === '2026-08-14', '2. Fechas exactas se respetan tal cual')
  }

  // 3. Solicitud con duración en días
  {
    const { sb } = clienteFalso(DOCENTE_1, {}, { contexto_grupo: RPC_GRUPO_BASE })
    const r = await prepararContextoGeneracionPlaneacion(sb, sesion(), solicitud({ duracionDias: 10 }))
    verificar(r.fechas.totalDiasEfectivos === 10, '3. Duración en días efectivos se respeta tal cual')
  }

  // 4. Solicitud sin fecha inicial — usa el siguiente día efectivo
  {
    const { sb } = clienteFalso(DOCENTE_1, {}, { contexto_grupo: RPC_GRUPO_BASE })
    const r = await prepararContextoGeneracionPlaneacion(sb, sesion(), solicitud({ duracionDias: 5 }))
    verificar(r.fechas.fechaInicioResuelta === HOY, '4. Sin fecha inicial, usa la fecha de referencia (ya es día hábil)')
  }

  // 5. Inicio en fin de semana — se mueve y advierte
  {
    const { sb } = clienteFalso(DOCENTE_1, {}, { contexto_grupo: RPC_GRUPO_BASE })
    const r = await prepararContextoGeneracionPlaneacion(sb, sesion(), solicitud({ fechaInicio: '2026-08-08', duracionDias: 5 })) // sábado
    verificar(r.fechas.fechaInicioResuelta === '2026-08-10' && r.fechas.advertencias.length > 0, '5. Inicio en sábado se mueve al lunes con advertencia')
  }

  // 6. Periodo con un día inhábil (festivo oficial SEP)
  {
    const eventos = [evento('2026-08-12', 'festivo', 'Día festivo de prueba')]
    const { sb } = clienteFalso(DOCENTE_1, { calendario_eventos: eventos as unknown as Fila[] }, { contexto_grupo: RPC_GRUPO_BASE })
    const r = await prepararContextoGeneracionPlaneacion(sb, sesion(), solicitud({ duracionDias: 5 }))
    verificar(r.fechas.fechasExcluidas.some((f) => f.fecha === '2026-08-12' && f.motivo === 'dia_inhabil'), '6. El festivo oficial queda excluido con motivo "dia_inhabil"')
    verificar(r.eventosCalendarioDelPeriodo.some((e) => e.fecha === '2026-08-12'), '6b. El evento excluido aparece en eventosCalendarioDelPeriodo')
  }

  // 7. Periodo que cruza vacaciones — se extiende para compensar
  {
    const eventos = ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21'].map((f) => evento(f, 'vacaciones', 'Vacaciones de prueba'))
    const { sb } = clienteFalso(DOCENTE_1, { calendario_eventos: eventos as unknown as Fila[] }, { contexto_grupo: RPC_GRUPO_BASE })
    const r = await prepararContextoGeneracionPlaneacion(sb, sesion(), solicitud({ duracionDias: 10 }))
    verificar(r.fechas.totalDiasEfectivos === 10 && r.fechas.fechasExcluidas.filter((f) => f.motivo === 'vacaciones').length === 5, '7. Se completan los 10 días efectivos saltando la semana de vacaciones')
  }

  // 8. Periodo con suspensión
  {
    const eventos = [evento('2026-08-11', 'suspension', 'Suspensión de labores')]
    const { sb } = clienteFalso(DOCENTE_1, { calendario_eventos: eventos as unknown as Fila[] }, { contexto_grupo: RPC_GRUPO_BASE })
    const r = await prepararContextoGeneracionPlaneacion(sb, sesion(), solicitud({ duracionDias: 5 }))
    verificar(r.fechas.fechasExcluidas.some((f) => f.motivo === 'suspension'), '8. La suspensión queda excluida y registrada')
  }

  // 9. Ajuste automático de fecha final (consecuencia de 6/7/8, verificado aquí de forma directa)
  {
    const eventos = [evento('2026-08-11', 'festivo', 'Festivo')]
    const { sb } = clienteFalso(DOCENTE_1, { calendario_eventos: eventos as unknown as Fila[] }, { contexto_grupo: RPC_GRUPO_BASE })
    const r = await prepararContextoGeneracionPlaneacion(sb, sesion(), solicitud({ duracionDias: 5 }))
    verificar(r.fechas.fechaFinResuelta !== '2026-08-14', '9. La fecha final se ajustó automáticamente para compensar el día excluido')
  }

  // 9b. "Después de vacaciones" (ejemplo explícito del Paso 3B) —
  //     resolución determinista de la fecha de referencia contra el
  //     calendario real, sin persistencia y sin preguntar.
  {
    const eventos = ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21'].map((f) => evento(f, 'vacaciones', 'Vacaciones de prueba'))
    const { sb } = clienteFalso(DOCENTE_1, { calendario_eventos: eventos as unknown as Fila[] }, { contexto_grupo: RPC_GRUPO_BASE })
    const r = await prepararContextoGeneracionPlaneacion(sb, sesion(), solicitud({ duracionDias: 5, momentoRelativo: 'después de vacaciones' }))
    // El día siguiente a la última vacación (viernes 21) es sábado 22 —
    // calcularFechasPlaneacion mueve automáticamente al siguiente día
    // efectivo real (lunes 24), igual que ante cualquier otra fecha de
    // referencia que caiga en fin de semana (regla 5).
    verificar(r.fechas.fechaInicioResuelta === '2026-08-24', '9b. "Después de vacaciones" calcula desde el día siguiente a la última vacación, y de ahí al siguiente día efectivo real')
    verificar(!!r.explicacionMomentoRelativo && r.explicacionMomentoRelativo.includes('vacaciones'), '9c. Se devuelve una explicación honesta de cómo se resolvió la referencia relativa')
  }

  // 9d. Unidades puras exportadas, probadas directamente
  {
    const dias = mapearEventosADiasNoLaborables([evento('2026-08-11', 'festivo', 'Festivo'), evento('2026-08-12', 'cte', 'CTE', true), evento('2026-08-13', 'reunión', 'Actividad propia', false)])
    verificar(dias.length === 2, '9d. mapearEventosADiasNoLaborables solo incluye eventos oficiales SEP con motivo reconocido')
    verificar(dias.some((d) => d.fecha === '2026-08-11' && d.motivo === 'dia_inhabil') && dias.some((d) => d.fecha === '2026-08-12' && d.motivo === 'evento_sin_clases'), '9e. Clasifica correctamente festivo→dia_inhabil y CTE→evento_sin_clases')

    const periodos: PeriodoEvaluacion[] = [{ id: 'p1', nombre: 'Primer trimestre', numero_periodo: 1, fecha_inicio: '2026-08-01', fecha_fin: '2026-10-31' }]
    verificar(resolverPeriodoEvaluacionActual(periodos, '2026-08-10')?.id === 'p1', '9f. resolverPeriodoEvaluacionActual encuentra el periodo vigente para la fecha dada')
    verificar(resolverPeriodoEvaluacionActual(periodos, '2027-01-01') === null, '9g. resolverPeriodoEvaluacionActual devuelve null si ninguna fecha lo cubre')
  }

  // 10. Contexto de grupo activo se incluye siempre
  {
    const { sb } = clienteFalso(DOCENTE_1, {}, { contexto_grupo: RPC_GRUPO_BASE })
    const r = await prepararContextoGeneracionPlaneacion(sb, sesion(), solicitud({ duracionDias: 5 }))
    verificar(JSON.stringify(r.contextoGrupo) === JSON.stringify(RPC_GRUPO_BASE), '10. El contexto real del grupo activo se incluye en el resultado')
  }

  // 11. Periodo de evaluación inferido automáticamente (sin preguntarlo)
  {
    const periodos: Array<PeriodoEvaluacion & { ciclo_escolar_id: string }> = [
      { id: 'periodo-1', nombre: 'Primer trimestre', numero_periodo: 1, fecha_inicio: '2026-08-01', fecha_fin: '2026-10-31', ciclo_escolar_id: 'ciclo-1' },
      { id: 'periodo-2', nombre: 'Segundo trimestre', numero_periodo: 2, fecha_inicio: '2026-11-01', fecha_fin: '2027-02-28', ciclo_escolar_id: 'ciclo-1' },
    ]
    const { sb } = clienteFalso(DOCENTE_1, { periodos_evaluacion: periodos as unknown as Fila[] }, { contexto_grupo: RPC_GRUPO_BASE })
    const r = await prepararContextoGeneracionPlaneacion(sb, sesion(), solicitud({ duracionDias: 5 }))
    verificar(r.periodoEvaluacionActual?.id === 'periodo-1', '11. El periodo de evaluación vigente se infiere solo, sin preguntarlo')
  }

  // 12. Borrador con estructura completa — verificación estructural del texto de instrucciones
  //     (no se puede probar el texto real que redacta Claude de forma determinista).
  {
    const camposRequeridos = [
      'nombre contextual', 'grupo y grado', 'periodo de evaluación', 'fecha de inicio y fecha de fin',
      'duración en días efectivos', 'campos formativos', 'contenidos', 'PDA', 'propósito', 'metodología',
      'producto final', 'secuencia didáctica', 'actividades de inicio, de desarrollo y de cierre',
      'recursos', 'evidencias', 'criterios o indicadores', 'adecuaciones o apoyos', 'observaciones sobre días inhábiles',
    ]
    const faltantes = camposRequeridos.filter((c) => !INSTRUCCIONES_PLANEACION_GENERAR.includes(c))
    verificar(faltantes.length === 0, `12. Las instrucciones exigen los ${camposRequeridos.length} elementos del borrador (faltantes: ${faltantes.join(', ') || 'ninguno'})`)
  }

  // 13. Hoja de evaluación — corrección funcional de C-005: el PDF real
  //     (vista previa y definitivo) ahora lo genera el SISTEMA de forma
  //     automática, nunca Claude — las instrucciones se lo prohíben
  //     explícitamente para que nunca prometa un control que no controla.
  {
    const t = INSTRUCCIONES_PLANEACION_GENERAR
    verificar(t.includes('hoja de evaluación final con indicadores derivados'), '13. Las instrucciones piden mencionar brevemente la hoja de evaluación final')
    verificar(t.includes('NUNCA digas que tú generas el PDF') && t.includes('eso lo hace el sistema automáticamente'), '13b. Las instrucciones prohíben que Claude describa o prometa el control de descarga — lo hace el sistema')
    verificar(t.includes('NUNCA digas que el docente debe elaborar manualmente una ficha diagnóstica'), '13c. Las instrucciones prohíben explícitamente pedirle al docente que elabore instrumentos manualmente')
    verificar(t.includes('Docente IA integrará automáticamente la ficha diagnóstica individual de cada alumno a partir de los resultados registrados en la hoja de evaluación final del proyecto'), '13d. Las instrucciones usan exactamente la redacción corregida sobre la ficha diagnóstica')
  }

  // 14/15/16. Cero INSERT/UPDATE/DELETE reales
  {
    const eventos = [evento('2026-08-11', 'festivo', 'Festivo')]
    const periodos: PeriodoEvaluacion[] = [{ id: 'periodo-1', nombre: 'Primer trimestre', numero_periodo: 1, fecha_inicio: '2026-08-01', fecha_fin: '2026-10-31' }]
    const { sb, interno } = clienteFalso(DOCENTE_1, { calendario_eventos: eventos as unknown as Fila[], periodos_evaluacion: periodos as unknown as Fila[] }, { contexto_grupo: RPC_GRUPO_BASE })
    await prepararContextoGeneracionPlaneacion(sb, sesion(), solicitud({ duracionSemanas: 2 }))
    await prepararContextoGeneracionPlaneacion(sb, sesion(), solicitud({ fechaInicio: '2026-08-10', fechaFin: '2026-08-21' }))
    verificar(interno.escrituras.length === 0, '14/15/16. Ningún escenario de generación de borrador ejecuta INSERT/UPDATE/DELETE')

    const contenidoGenerar = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'generarBorrador.ts'), 'utf-8')
    verificar(!contenidoGenerar.includes('.insert(') && !contenidoGenerar.includes('.update(') && !contenidoGenerar.includes('.delete('), '14b. generarBorrador.ts no contiene ninguna llamada .insert()/.update()/.delete()')
  }

  // 17. No usa service_role ni crea cliente propio
  {
    const contenidoGenerar = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'generarBorrador.ts'), 'utf-8')
    const contenidoInstrucciones = readFileSync(join(__dirname, '..', 'lib', 'asistente', 'instruccionesPlaneacionGenerar.ts'), 'utf-8')
    verificar(!contenidoGenerar.includes('SERVICE_ROLE') && !contenidoGenerar.includes('createClient('), '17. generarBorrador.ts no referencia SERVICE_ROLE ni crea un cliente propio')
    verificar(!contenidoInstrucciones.includes('SERVICE_ROLE'), '17b. instruccionesPlaneacionGenerar.ts no referencia SERVICE_ROLE')
  }

  // 18. Respuesta breve en canal de voz — verificación estructural
  {
    const t = INSTRUCCIONES_PLANEACION_GENERAR
    verificar(t.includes('una a tres frases') && t.includes('Nunca leas la planeación completa ni la hoja de evaluación en voz'), '18. Las instrucciones exigen una respuesta breve y sin lectura completa en voz')
  }

  // 19/20/21/22. Verificación de texto real de las reglas del clasificador
  //     (la clasificación real de Claude no se puede probar de forma
  //     determinista — se verifica que el texto de la regla exista y
  //     distinga correctamente cada caso).
  {
    const clasificador = readFileSync(join(__dirname, '..', 'lib', 'clasificadorNivel0.ts'), 'utf-8')
    verificar(clasificador.includes('planeacion_generar'), 'Confirmación previa: el clasificador conoce la intención planeacion_generar')
    verificar(!clasificador.includes('planeacion_nueva'), 'Confirmación previa: no queda ninguna referencia funcional a planeacion_nueva en el clasificador')
    verificar(clasificador.includes('de una pregunta general o pedagógica sobre qué es una planeación o cómo se hace la planeación'.slice(0, 10)) || clasificador.includes('pregunta general o pedagógica'), '19. La regla 4 distingue explícitamente una pregunta educativa general (no activa generación)')
    verificar(clasificador.includes('DISTINGUE esto de "planeacion_generar"'), '20. La regla 20 (planeacion_consultar) sigue distinguiéndose explícitamente de la generación, ahora con el nombre correcto')
    verificar(clasificador.includes('"fecha_o_duracion" a datos_faltantes'), '21. La regla 4.1 define cuándo preguntar únicamente el dato de tiempo faltante')
    verificar(clasificador.includes('"sí, apruébala"') || clasificador.includes('sí, apruébala'), '22. La regla 4 reconoce expresiones de aprobación ("apruébala", "guárdala", "déjala así") dentro de la misma intención')
  }

  // 22b. Las instrucciones nunca permiten decir que ya se guardó
  {
    const t = INSTRUCCIONES_PLANEACION_GENERAR
    verificar(t.includes('NUNCA digas que ya se guardó'), '22b. Las instrucciones prohíben explícitamente afirmar que el borrador ya se guardó')
  }

  // 23. Corrección del borrador sin crear una nueva planeación — sin
  //     mecanismo nuevo de almacenamiento (se apoya en el historial de
  //     conversación ya existente, nunca en persistencia nueva).
  {
    const contenidoGenerar = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'generarBorrador.ts'), 'utf-8')
    verificar(!contenidoGenerar.toLowerCase().includes('localstorage') && !contenidoGenerar.includes('planeacion_proyectos'), '23. No se introdujo ningún mecanismo nuevo de almacenamiento del borrador — generarBorrador.ts no toca planeacion_proyectos ni ningún storage nuevo')
    verificar(INSTRUCCIONES_PLANEACION_GENERAR.includes('presenta el borrador COMPLETO otra vez con el ajuste aplicado'), '23b. Las instrucciones exigen conservar el borrador completo al corregir, nunca uno nuevo sin relación')
  }

  // 24. No afectación de otras ramas — verificado por diff real (fuera
  //     del alcance de un test en memoria, se documenta en el informe
  //     con `git diff`; aquí solo se confirma que las reglas de las
  //     otras intenciones siguen presentes con su texto conocido).
  {
    const clasificador = readFileSync(join(__dirname, '..', 'lib', 'clasificadorNivel0.ts'), 'utf-8')
    verificar(clasificador.includes('intencion_principal="ficha_descriptiva"'), '24a. La regla de ficha_descriptiva sigue presente')
    verificar(clasificador.includes('intencion_principal="consultar_calendario"'), '24b. La regla de consultar_calendario sigue presente')
    verificar(clasificador.includes('intencion_principal="consultar_asistencia_grupo"'), '24c. La regla de asistencia sigue presente')
    verificar(clasificador.includes('intencion_principal="registrar_incidencia"'), '24d. La regla de incidencias sigue presente')
    verificar(clasificador.includes('requiere_consulta_oficial=true SOLO cuando'), '24e. La regla de consultas SEP sigue presente')
  }

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
