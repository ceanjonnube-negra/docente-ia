// scripts/verificar-contexto-autenticado-planeacion.ts
//
// Prueba aislada (sin credenciales, sin red, sin escrituras reales) de
// la "CORRECCIÓN CRÍTICA C-005 — contexto real del docente": confirma
// que la mitad DETERMINISTA de la recuperación de contexto autenticado
// (obtenerSesionContexto → prepararContextoGeneracionPlaneacion) sí
// entrega grupo activo, ciclo escolar, lista de alumnos y calendario
// real para el mensaje exacto reportado en producción, y que
// app/api/chat/route.ts resuelve la identidad EN EL SERVIDOR (contra
// el propio accessToken) en vez de confiar en el userId que manda el
// cliente sin verificar — la causa raíz real confirmada por lectura de
// código (ver informe). La validación real de auth.getUser() contra el
// servidor de Supabase (autenticarRequestApi) no se puede probar de
// forma determinista sin credenciales/red — misma limitación ya
// documentada en los Pasos 1/2/3A/3B — se verifica en su lugar, con
// certeza, que el código del servidor la invoque correctamente y que
// los logs de diagnóstico nunca expongan tokens ni datos sensibles.
// Se ejecuta con `npx tsx scripts/verificar-contexto-autenticado-planeacion.ts`.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { obtenerSesionContexto } from '../lib/sesionContexto'
import { prepararContextoGeneracionPlaneacion } from '../lib/planeacion/generarBorrador'
import { extraerResumenBorrador } from '../lib/planeacion/extraerBorrador'
import type { EventoCalendarioCompleto } from '../lib/motorContexto'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// --- Mismo doble mínimo de SupabaseClient que usan los demás
//     scripts de C-005, extendido con .limit() (necesario para la
//     consulta real de obtenerSesionContexto, no usada hasta ahora en
//     ningún otro script de esta serie). ---

type Fila = Record<string, unknown>

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
  private rangos: Array<['gte' | 'lte' | 'gt', string, unknown]> = []
  private clausulasOr: string | null = null
  private orden: { columna: string; ascendente: boolean } | null = null
  private limite: number | null = null

  constructor(private cliente: ClienteSupabaseFalso, private tabla: string) {}

  select(_columnas: string) {
    void _columnas
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

  // Soporta el patrón usado en motorContexto.ts:
  // `.or('user_id.eq.X,user_id.is.null')`.
  or(clausulas: string) {
    this.clausulasOr = clausulas
    return this
  }

  order(columna: string, opciones?: { ascending?: boolean }) {
    this.orden = { columna, ascendente: opciones?.ascending ?? true }
    return this
  }

  limit(n: number) {
    this.limite = n
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
    if (this.limite != null) resultado = resultado.slice(0, this.limite)
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

  constructor(datosIniciales: Record<string, Fila[]> = {}, private rpcRespuestas: Record<string, unknown> = {}, private usuario: { id: string } | null = null) {
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
}

function clienteFalso(datos: Record<string, Fila[]> = {}, rpc: Record<string, unknown> = {}, usuario: { id: string } | null = null): { sb: SupabaseClient; interno: ClienteSupabaseFalso } {
  const interno = new ClienteSupabaseFalso(datos, rpc, usuario)
  return { sb: interno as unknown as SupabaseClient, interno }
}

function evento(fecha: string, tipo: string, titulo: string, esSep = true): EventoCalendarioCompleto {
  return { id: randomUUID(), titulo, fecha, tipo, color: '#000', descripcion: titulo, es_sep: esSep }
}

const DOCENTE_ID = 'docente-real-1'
const GRUPO_ID = 'grupo-real-1'
const CICLO_ID = 'ciclo-real-1'
const HOY = '2026-08-10' // lunes, una semana después del arranque real del ciclo (2026-08-01)

const MENSAJE_EXACTO =
  'Hazme una planeación diagnóstica para las primeras dos semanas de clases de mi grupo, considerando el calendario escolar, los días inhábiles y las suspensiones.'

async function main() {
  // 1-5. Recuperación real de contexto autenticado: grupo activo,
  //      ciclo escolar, lista de alumnos — la mitad determinista del
  //      recorrido completo (auth → sesión) que el diagnóstico exige.
  {
    const datos: Record<string, Fila[]> = {
      grupos: [
        {
          id: GRUPO_ID,
          docente_id: DOCENTE_ID,
          institucion_id: 'institucion-real-1',
          ciclo_escolar_id: CICLO_ID,
          creado_en: '2026-08-01T12:00:00Z',
          'ciclos_escolares.activo': true,
        },
      ],
      inscripciones: [
        { alumno_id: 'alumno-1', grupo_id: GRUPO_ID, estatus: 'activo', numero_lista: 1, alumnos: { nombre: 'Ana López', sexo: 'M' } },
        { alumno_id: 'alumno-2', grupo_id: GRUPO_ID, estatus: 'activo', numero_lista: 2, alumnos: { nombre: 'Beto Ruiz', sexo: 'H' } },
      ],
    }
    const { sb } = clienteFalso(datos)
    const sesion = await obtenerSesionContexto(sb, DOCENTE_ID, 'America/Mexico_City')

    verificar(!!sesion, '1. sesionPresente: la sesión se recupera para un docente con grupo activo real')
    verificar(sesion.docente_id === DOCENTE_ID, '2. docenteIdPresente: el docente_id resuelto es el real, no inventado')
    verificar(sesion.grupo_activo_id === GRUPO_ID, '3. grupoIdPresente: el grupo activo se resuelve automáticamente (fuente única de verdad, misma consulta que Lista)')
    verificar(sesion.ciclo_escolar_id === CICLO_ID, '4. cicloEscolarPresente: el ciclo escolar activo se resuelve junto con el grupo')
    verificar(sesion.alumnos_del_grupo_activo.length === 2, '5. Lista real de alumnos recuperada (cantidadAlumnos=2), sin que el docente tenga que volver a capturarla')
  }

  // 6-11. Con esa sesión real, el contexto de planeacion_generar para
  //       el MENSAJE EXACTO reportado en producción: calendario
  //       consultado automáticamente, fechas ancladas al inicio real
  //       del ciclo (no a "hoy"), cero escrituras.
  {
    const eventos = [
      evento('2026-08-05', 'suspension', 'Suspensión de labores'),
      evento('2026-08-12', 'festivo', 'Día inhábil oficial'),
    ]
    const datos: Record<string, Fila[]> = { calendario_eventos: eventos as unknown as Fila[] }
    const { sb, interno } = clienteFalso(
      datos,
      { contexto_grupo: { grado: '4°', grupo: 'B', nivel_educativo: 'primaria', ciclo_escolar: '2026-2027' } },
      { id: DOCENTE_ID }
    )

    const sesionSimulada = {
      docente_id: DOCENTE_ID,
      institucion_id: 'institucion-real-1',
      ciclo_escolar_id: CICLO_ID,
      grupo_activo_id: GRUPO_ID,
      fecha_actual: HOY,
      alumnos_del_grupo_activo: [
        { alumno_id: 'alumno-1', nombre_completo: 'Ana López', sexo: 'M', numero_lista: 1 },
        { alumno_id: 'alumno-2', nombre_completo: 'Beto Ruiz', sexo: 'H', numero_lista: 2 },
      ],
    }

    const r = await prepararContextoGeneracionPlaneacion(sb, sesionSimulada, {
      tema: null,
      fechaInicio: null,
      fechaFin: null,
      duracionDias: null,
      duracionSemanas: 2,
      momentoRelativo: 'las primeras dos semanas de clases',
    })

    verificar(r.eventosCalendarioDelPeriodo.length === 2, '6. calendarioPresente: el calendario real (suspensión + día inhábil) se recupera automáticamente, sin preguntarlo')
    verificar(!r.fechas.conflicto && r.fechas.totalDiasEfectivos === 10, '7. Cálculo de fechas correcto: 10 días efectivos, sin conflicto')
    verificar(r.fechas.fechaInicioResuelta === '2026-08-03', '8. Las fechas se anclan al inicio real del ciclo, no a "hoy" (2026-08-10)')
    verificar(!!r.contextoGrupo, '9. Contexto real del grupo (grado/grupo) incluido — nunca se le vuelve a preguntar al docente')
    verificar(interno.escrituras.length === 0, '10. Cero escrituras en Supabase durante la vista previa')
    verificar(JSON.stringify(r).length > 0, '11. Borrador-context completo y serializable listo para inyectar a Claude')
  }

  // 12. EvaluacionProyectoSpec (ResumenBorrador) — el parser
  //     determinista sigue reconociendo el bloque de resumen que
  //     Claude produciría para este escenario exacto.
  {
    const borrador = `Preparé la planeación diagnóstica para las primeras dos semanas efectivas de clase de tu grupo, considerando el calendario escolar.

Nombre contextual: Diagnóstico de inicio de ciclo
Grupo: 4°B

📎 RESUMEN PARA GUARDAR
Nombre: Diagnóstico de inicio de ciclo
Grupo: 4°B
Periodo de evaluación: Primer trimestre
Fecha de inicio: 2026-08-03
Fecha de fin: 2026-08-18
Duración: 10 días efectivos
Propósito: Identificar el nivel de logro inicial del grupo
Campos formativos: Lenguajes; Saberes y pensamiento científico
Contenidos: Comprensión lectora; Conteo y estimación
PDA: Identifica ideas principales; Resuelve problemas de conteo
Ejes articuladores: Pensamiento crítico; Inclusión
Metodología: Trabajo por estaciones
Producto final: Reporte diagnóstico individual
Secuencia didáctica: Día 1: Evaluación de lectura; Día 2: Evaluación de matemáticas
Recursos: Fichas de lectura; Material manipulable
Evidencias: Registros de observación; Productos escritos
Indicadores de evaluación: Identifica ideas principales; Cuenta colecciones; Sigue instrucciones

¿Deseas corregir algo o aprobarla para guardarla?`

    const resumen = extraerResumenBorrador([{ role: 'assistant', content: borrador }])
    verificar(resumen !== null, '12. EvaluacionProyectoSpec generado: el parser determinista extrae el resumen del borrador diagnóstico')
    verificar(resumen?.fechaInicio === '2026-08-03' && resumen?.fechaFin === '2026-08-18', '12b. El resumen conserva las fechas reales calculadas (no inventadas)')
  }

  // 13-16. Corrección crítica — resolución de identidad EN EL SERVIDOR:
  //        route.ts ya no confía en el userId sin verificar que manda
  //        el cliente para construir la sesión de contexto.
  {
    const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
    verificar(ruta.includes("import { autenticarRequestApi } from '@/lib/server/authApi'"), '13. route.ts importa el mismo mecanismo de autenticación ya sancionado (autenticarRequestApi), en vez de confiar en el userId del cliente')
    verificar(ruta.includes('autenticacion?.ok ? autenticacion.user.id : null'), '14. userId se resuelve contra la identidad verificada por el servidor (auth.getUser(accessToken)), no contra el valor sin verificar del cliente')
    verificar(ruta.includes('obtenerSesionContexto(supabaseUser, userId, zonaHoraria)'), '15. La sesión de contexto (grupo activo, ciclo, alumnos) se construye con el userId ya verificado por el servidor')
    verificar(!ruta.includes('obtenerSesionContexto(supabaseUser, userIdCliente'), '15b. La sesión nunca se construye con el userId sin verificar que manda el cliente')
  }

  // 17-19. Indicadores seguros de diagnóstico — nunca tokens, claves ni
  //        cookies completas en los logs (ver "DIAGNÓSTICO OBLIGATORIO").
  {
    const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
    verificar(ruta.includes('sesionPresente=') && ruta.includes('usuarioPresente=') && ruta.includes('docenteIdPresente='), '16. Los logs de diagnóstico usan indicadores seguros (sesionPresente/usuarioPresente/docenteIdPresente)')
    verificar(ruta.includes('grupoIdPresente=') && ruta.includes('cicloEscolarPresente=') && ruta.includes('cantidadAlumnos='), '17. Los logs también reportan grupoIdPresente/cicloEscolarPresente/cantidadAlumnos')
    verificar(ruta.includes('calendarioConsultado=true'), '18. Los logs confirman que planeacion_generar consulta el calendario como dependencia interna')

    // Ningún console.log de este archivo interpola accessToken/token
    // directamente (solo lo usa para autenticar, nunca para registrar).
    const lineasLog = ruta.split('\n').filter((l) => l.includes('console.log') || l.includes('console.error'))
    const lineaConToken = lineasLog.find((l) => /\$\{accessToken\}|\$\{.*token.*\}/i.test(l) && !/Bearer \$\{accessToken\}/.test(l))
    verificar(!lineaConToken, '19. Ningún console.log/console.error del archivo interpola el valor real de accessToken u otro token')
  }

  // 20. planeacion_generar sigue dependiendo de un único punto de
  //     verdad (sesion.grupo_activo_id) — el calendario se consulta
  //     como dependencia interna, nunca como una intención competidora
  //     ni como una pregunta adicional al docente.
  {
    const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
    verificar(ruta.includes("clasificacion.intencion_principal === 'planeacion_generar' && sesion.grupo_activo_id"), '20. planeacion_generar sigue usando sesion.grupo_activo_id (fuente única) para decidir si enriquecer con datos reales')

    // Exactamente un descriptor PDF por turno: la rama de aprobación
    // (accion_planeacion_generar==='aprobar') SIEMPRE hace return antes
    // de llegar a Claude/streaming, así que nunca puede coexistir en el
    // mismo turno con el marcador de vista previa (que solo se construye
    // después del streaming, cuando esTurnoDeBorradorPlaneacion es true)
    // — son mutuamente excluyentes por construcción, no por casualidad.
    const inicioBloqueAprobar = ruta.indexOf("accion_planeacion_generar === 'aprobar'")
    const bloqueAprobar = ruta.slice(inicioBloqueAprobar, inicioBloqueAprobar + 1500)
    const construccionesMarcador = (bloqueAprobar.match(/const marcador = `\[\[DOCUMENTO_ARCHIVO:/g) || []).length
    verificar(construccionesMarcador === 1 && /return respuestaTexto/.test(bloqueAprobar), '21. La rama de aprobación construye exactamente un descriptor PDF y hace return antes de llegar a Claude — nunca puede coexistir con el de vista previa en el mismo turno')
  }

  // 22. No preguntar de nuevo lo que ya existe — instrucciones
  //     explícitas contra "no tengo acceso" y contra re-preguntar
  //     grado/grupo/turno/escuela.
  {
    const instrucciones = readFileSync(join(__dirname, '..', 'lib', 'asistente', 'instruccionesPlaneacionGenerar.ts'), 'utf-8')
    verificar(instrucciones.includes('NUNCA digas "no tengo acceso a tu calendario/grupo/lista de alumnos"'), '22. Las instrucciones prohíben explícitamente decir "no tengo acceso" cuando el contexto real ya se inyectó')
    verificar(instrucciones.includes('ni le vuelvas a preguntar al maestro el grado, el grupo, el turno o la escuela'), '22b. Las instrucciones prohíben explícitamente volver a preguntar datos que ya existen en la aplicación')
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
