// scripts/verificar-planeacion-consultar.ts
//
// Prueba aislada (sin credenciales, sin red, sin escrituras reales) de
// la intención planeacion_consultar — C-005, Paso 3A. Ejercita el
// dispatcher real (ejecutarHerramientaDeModulo) con clasificaciones
// simuladas (nunca se llama a Claude aquí — nada en el proyecto prueba
// la clasificación real de forma determinista) y un doble en memoria
// de SupabaseClient (extensión del mismo doble usado en
// scripts/verificar-persistencia-planeacion.ts, agregando
// periodos_evaluacion). Se ejecuta con
// `npx tsx scripts/verificar-planeacion-consultar.ts`.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ejecutarHerramientaDeModulo, type ContextoEjecucionHerramienta } from '../lib/asistente/herramientasModulo'
import type { ClasificacionNivel0 } from '../lib/clasificadorNivel0'
import type { SesionContexto } from '../lib/sesionContexto'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// --- Doble mínimo de SupabaseClient (mismo patrón del Paso 2) ---------

type Fila = Record<string, unknown>

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
  private rangos: Array<['gt', string, unknown]> = []
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

  gt(columna: string, valor: unknown) {
    this.rangos.push(['gt', columna, valor])
    return this
  }

  order(columna: string, opciones?: { ascending?: boolean }) {
    this.orden = { columna, ascendente: opciones?.ascending ?? true }
    return this
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

    let resultado = filas.filter((f) =>
      this.filtros.every(([c, v]) => f[c] === v) &&
      this.rangos.every(([, c, v]) => Number(f[c]) > Number(v))
    )
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

  async single() {
    const { data, error } = this.ejecutar()
    if (error) return { data: null, error }
    if (!data || data.length === 0) return { data: null, error: { message: 'no rows' } }
    return { data: data[0], error: null }
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

  constructor(private usuario: { id: string } | null, datosIniciales: Record<string, Fila[]> = {}) {
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

  _tabla(tabla: string): Fila[] {
    if (!this.tablas.has(tabla)) this.tablas.set(tabla, [])
    return this.tablas.get(tabla)!
  }

  _registrarEscritura(tabla: string, tipo: 'insert' | 'update') {
    this.escrituras.push({ tabla, tipo })
  }
}

function clienteFalso(usuario: { id: string } | null, datos: Record<string, Fila[]> = {}): { sb: SupabaseClient; interno: ClienteSupabaseFalso } {
  const interno = new ClienteSupabaseFalso(usuario, datos)
  // Cast deliberado: doble mínimo, solo cubre las cadenas que
  // persistencia.ts y esta herramienta usan — ver Paso 2.
  return { sb: interno as unknown as SupabaseClient, interno }
}

// --- Datos fijos de prueba --------------------------------------------

const DOCENTE_1 = { id: 'docente-1' }
const DOCENTE_2 = { id: 'docente-2' }
const HOY = '2026-08-10'

function datosBase(): Record<string, Fila[]> {
  return {
    grupos: [
      { id: 'grupo-1', docente_id: 'docente-1', ciclo_escolar_id: 'ciclo-1' },
      { id: 'grupo-2', docente_id: 'docente-2', ciclo_escolar_id: 'ciclo-2' },
      { id: 'grupo-3', docente_id: 'docente-1', ciclo_escolar_id: 'ciclo-1' },
    ],
    periodos_evaluacion: [
      { id: 'periodo-1', ciclo_escolar_id: 'ciclo-1', nombre: 'Primer trimestre', numero_periodo: 1 },
      { id: 'periodo-2', ciclo_escolar_id: 'ciclo-1', nombre: 'Segundo trimestre', numero_periodo: 2 },
    ],
    planeaciones: [
      { id: 'plan-1', docente_id: 'docente-1', grupo_id: 'grupo-1', ciclo_escolar_id: 'ciclo-1', periodo_evaluacion_id: 'periodo-1', nombre: 'Leyendas de mi comunidad', proposito: null, fecha_inicio: '2026-08-03', fecha_fin: '2026-08-14', estado: 'borrador', version: 1, creado_en: '2026-08-01T00:00:00.000Z', actualizado_en: '2026-08-01T00:00:00.000Z' },
      { id: 'plan-2', docente_id: 'docente-1', grupo_id: 'grupo-1', ciclo_escolar_id: 'ciclo-1', periodo_evaluacion_id: 'periodo-2', nombre: 'Fracciones y decimales', proposito: null, fecha_inicio: '2026-09-01', fecha_fin: '2026-09-12', estado: 'publicada', version: 1, creado_en: '2026-08-01T00:00:00.000Z', actualizado_en: '2026-08-01T00:00:00.000Z' },
      { id: 'plan-3', docente_id: 'docente-1', grupo_id: 'grupo-1', ciclo_escolar_id: 'ciclo-1', periodo_evaluacion_id: 'periodo-1', nombre: 'Historia de México', proposito: null, fecha_inicio: '2026-07-01', fecha_fin: '2026-07-10', estado: 'archivada', version: 1, creado_en: '2026-08-01T00:00:00.000Z', actualizado_en: '2026-08-01T00:00:00.000Z' },
      { id: 'plan-4', docente_id: 'docente-1', grupo_id: 'grupo-1', ciclo_escolar_id: 'ciclo-1', periodo_evaluacion_id: 'periodo-2', nombre: 'Leyendas del desierto', proposito: null, fecha_inicio: '2026-10-01', fecha_fin: '2026-10-10', estado: 'borrador', version: 1, creado_en: '2026-08-01T00:00:00.000Z', actualizado_en: '2026-08-01T00:00:00.000Z' },
      { id: 'plan-5', docente_id: 'docente-1', grupo_id: 'grupo-3', ciclo_escolar_id: 'ciclo-1', periodo_evaluacion_id: 'periodo-1', nombre: 'Cuerpos geométricos', proposito: null, fecha_inicio: '2026-08-01', fecha_fin: '2026-08-05', estado: 'borrador', version: 1, creado_en: '2026-08-01T00:00:00.000Z', actualizado_en: '2026-08-01T00:00:00.000Z' },
      { id: 'plan-6', docente_id: 'docente-2', grupo_id: 'grupo-2', ciclo_escolar_id: 'ciclo-2', periodo_evaluacion_id: null, nombre: 'Planeación de otro docente', proposito: null, fecha_inicio: '2026-08-01', fecha_fin: '2026-08-05', estado: 'borrador', version: 1, creado_en: '2026-08-01T00:00:00.000Z', actualizado_en: '2026-08-01T00:00:00.000Z' },
    ],
    planeacion_proyectos: [],
  }
}

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

function clasificacion(overrides: Partial<ClasificacionNivel0> = {}): ClasificacionNivel0 {
  return {
    intencion_principal: 'planeacion_consultar',
    nivel_ejecucion: 4,
    requiere_ia: true,
    requiere_contexto_memoria: true,
    entidades_resueltas: { alumno_id: null, alumno_nombre_detectado: null, alumno_ambiguo: false, opciones_alumno_ambiguo: [] },
    estado_asistencia_solicitado: null,
    pestana_lista: null,
    filtro_lista: null,
    nivel_detalle_asistencia_grupo: null,
    categoria_asistencia_grupo: null,
    grado_solicitado: null,
    grupo_solicitado: null,
    tipo_incidencia: null,
    descripcion_incidencia: null,
    tipo_consulta_planeacion: null,
    periodo_planeacion_consulta: null,
    estado_planeacion_consulta: null,
    nombre_planeacion_consulta: null,
    tema_planeacion: null,
    fecha_inicio_planeacion: null,
    fecha_fin_planeacion: null,
    duracion_dias_planeacion: null,
    duracion_semanas_planeacion: null,
    momento_relativo_planeacion: null,
    accion_planeacion_generar: null,
    datos_faltantes: [],
    nivel_confianza: 0.9,
    requiere_confirmacion: false,
    motivo_confirmacion: null,
    requiere_consulta_oficial: false,
    ...overrides,
  }
}

function contexto(sb: SupabaseClient, overrides: Partial<ContextoEjecucionHerramienta> = {}): ContextoEjecucionHerramienta {
  return { sb, sesion: sesion(), userId: 'docente-1', zonaHoraria: 'America/Mexico_City', canal: 'text', ...overrides }
}

async function main() {
  // 1. "¿Qué planeaciones tengo?" — listado general
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'listado_general' }), contexto(sb))
    verificar(r !== null && r.includes('4 planeación'), '1. "¿Qué planeaciones tengo?" devuelve el listado general (4 planeaciones en grupo-1)')
  }

  // 2. Consulta sin registros
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'listado_general' }), contexto(sb, { sesion: sesion({ grupo_activo_id: 'grupo-vacio' }) }))
    verificar(r === 'Todavía no tienes planeaciones guardadas para este grupo.', '2. Consulta sin registros devuelve el mensaje exacto requerido')
  }

  // 3. Consulta con una sola planeación
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'listado_general' }), contexto(sb, { sesion: sesion({ grupo_activo_id: 'grupo-3' }) }))
    verificar(r !== null && r.includes('Cuerpos geométricos') && r.includes('Periodo:') && r.includes('Fechas:') && r.includes('Estado:'), '3. Con una sola planeación muestra nombre, periodo, fechas y estado')
  }

  // 4. Consulta con varias planeaciones
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'listado_general' }), contexto(sb))
    verificar(r !== null && r.includes('Leyendas de mi comunidad') && r.includes('Fracciones y decimales') && r.includes('Historia de México') && r.includes('Leyendas del desierto'), '4. Con varias planeaciones se listan todas, resumidas')
  }

  // 5. Filtro por trimestre
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'por_periodo', periodo_planeacion_consulta: 'primer trimestre' }), contexto(sb))
    verificar(r !== null && r.includes('Leyendas de mi comunidad') && r.includes('Historia de México') && !r.includes('Fracciones'), '5. Filtro por trimestre devuelve solo las del periodo correcto')
  }

  // 6. Filtro por estado archivado
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'por_estado', estado_planeacion_consulta: 'archivada' }), contexto(sb))
    verificar(r !== null && r.includes('Historia de México') && r.includes('archivada') && !r.includes('Leyendas de mi comunidad'), '6. Filtro por estado archivado devuelve solo la archivada')
  }

  // 7. Consulta de planeación actual (vigente hoy)
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'actual' }), contexto(sb))
    verificar(r !== null && r.includes('Leyendas de mi comunidad'), '7. Consulta de planeación actual devuelve la vigente para la fecha de hoy')
  }

  // 8. Consulta de última planeación
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'ultima' }), contexto(sb))
    verificar(r !== null && r.includes('Leyendas del desierto'), '8. Consulta de última planeación devuelve la de fecha de inicio más reciente')
  }

  // 9. Búsqueda exacta por nombre
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'por_nombre', nombre_planeacion_consulta: 'Fracciones y decimales' }), contexto(sb))
    verificar(r !== null && r.includes('Fracciones y decimales') && r.includes('Periodo:'), '9. Búsqueda exacta por nombre abre directamente el detalle')
  }

  // 10. Varias coincidencias por nombre — pide aclaración, no elige arbitrariamente
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'por_nombre', nombre_planeacion_consulta: 'Leyendas' }), contexto(sb))
    verificar(r !== null && r.includes('Leyendas de mi comunidad') && r.includes('Leyendas del desierto') && r.includes('¿Cuál te interesa?'), '10. Varias coincidencias por nombre: muestra ambas y pide aclaración')
  }

  // 11. Planeación inexistente (búsqueda por nombre sin coincidencias)
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'por_nombre', nombre_planeacion_consulta: 'Volcanes de Marte' }), contexto(sb))
    verificar(r === 'No encontré planeaciones que coincidan con esa búsqueda.', '11. Planeación inexistente por nombre: mensaje distinto de "no tienes ninguna" (sí existen otras)')
  }

  // 12. Protección entre docentes — docente-2 nunca ve datos de docente-1
  {
    const { sb } = clienteFalso(DOCENTE_2, datosBase())
    const r = await ejecutarHerramientaDeModulo(
      clasificacion({ tipo_consulta_planeacion: 'listado_general' }),
      contexto(sb, { sesion: sesion({ docente_id: 'docente-2', grupo_activo_id: 'grupo-2', ciclo_escolar_id: 'ciclo-2' }), userId: 'docente-2' })
    )
    verificar(r !== null && r.includes('Planeación de otro docente') && !r.includes('Leyendas'), '12. Protección entre docentes: docente-2 solo ve sus propias planeaciones')
  }

  // 13. Protección entre grupos — grupo activo sin planeaciones propias no ve las de otro grupo
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'listado_general' }), contexto(sb, { sesion: sesion({ grupo_activo_id: 'grupo-3' }) }))
    verificar(r !== null && r.includes('Cuerpos geométricos') && !r.includes('Leyendas') && !r.includes('Fracciones'), '13. Protección entre grupos: grupo-3 no ve las planeaciones de grupo-1')
  }

  // 14. Confirmación de que no se ejecutan escrituras
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'listado_general' }), contexto(sb))
    await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'por_nombre', nombre_planeacion_consulta: 'Leyendas' }), contexto(sb))
    await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'actual' }), contexto(sb))
    verificar(interno.escrituras.length === 0, '14. Ningún escenario de planeacion_consultar ejecuta INSERT/UPDATE/DELETE')
  }

  // 15. Respuesta breve en canal de voz
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const rDetalleVoz = await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'ultima' }), contexto(sb, { canal: 'voice' }))
    const rListaVoz = await ejecutarHerramientaDeModulo(clasificacion({ tipo_consulta_planeacion: 'listado_general' }), contexto(sb, { canal: 'voice' }))
    verificar(rDetalleVoz !== null && !rDetalleVoz.includes('\n') && rDetalleVoz.split('.').length <= 3, '15a. Detalle en voz: una frase, sin estructura de bloque (sin saltos de línea)')
    verificar(rListaVoz !== null && !rListaVoz.includes('\n') && !rListaVoz.includes('•'), '15b. Lista en voz: frase breve, sin viñetas ni estructura extensa')
  }

  // 16. Frase educativa que menciona "planeación" pero no consulta datos guardados
  //     (la clasificación correcta, según la regla 20 del clasificador, es
  //     conversacion_general — se simula ese resultado y se confirma que el
  //     dispatcher NO la intercepta, dejándola seguir el flujo normal).
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    const r = await ejecutarHerramientaDeModulo(
      clasificacion({ intencion_principal: 'conversacion_general', tipo_consulta_planeacion: null, nivel_ejecucion: 3, requiere_contexto_memoria: false }),
      contexto(sb)
    )
    verificar(r === null, '16. Pregunta pedagógica ("¿qué es una planeación didáctica?") no activa la Herramienta — el dispatcher regresa null')
    verificar(interno.escrituras.length === 0, '16b. Tampoco se disparó ninguna consulta/escritura de planeaciones para ese caso')
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
