// scripts/verificar-roster-congelado-hoja.ts
//
// EVAL-1B — pruebas deterministas (sin credenciales, sin red, sin
// datos reales) del congelamiento de roster/indicadores al crear una
// hoja de evaluación nueva (lib/seguimiento/generarYGuardarHoja.ts) y
// de la función pura de conversión de escala
// (lib/seguimiento/conversionCalificacion.ts::nivelATextoCanonico).
// Mismo doble mínimo de SupabaseClient que
// scripts/verificar-generar-hoja-seguimiento.ts (copiado, no
// importado — mismo criterio ya establecido en esta serie de
// scripts), extendido con `inscripciones.id` real (antes ausente en
// ese archivo porque la consulta original nunca lo pedía).
//
// Las pruebas H/I/J/K (CHECK, UNIQUE, RLS) se validaron directamente
// contra el esquema real dentro de una transacción con ROLLBACK — un
// doble en memoria no puede probar un constraint de Postgres real.
// Ver informe EVAL-1B para esa evidencia. M/N se verifican por
// separado con SQL READ-ONLY contra la hoja real SG-VXKR.
//
// Se ejecuta con `npx tsx scripts/verificar-roster-congelado-hoja.ts`.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { generarYGuardarHojaSeguimiento } from '../lib/seguimiento/generarYGuardarHoja'
import { nivelATextoCanonico } from '../lib/seguimiento/conversionCalificacion'
import type { IndicadorProyecto } from '../lib/seguimiento/tipos'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

type Fila = Record<string, unknown>

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
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

  private ejecutar(): { data: Fila[] | null; error: { message: string; code?: string } | null } {
    if (this.cliente._debeFallar(this.tabla, this.operacion === 'insertar' ? 'insert' : this.operacion === 'actualizar' ? 'update' : 'select')) {
      return { data: null, error: { message: `Error simulado en ${this.tabla}` } }
    }
    const filas = this.cliente._tabla(this.tabla)

    if (this.operacion === 'insertar') {
      const nuevas = Array.isArray(this.payload) ? this.payload : [this.payload as Fila]
      for (const nueva of nuevas) {
        if (this.tabla === 'hojas_evaluacion') {
          const colision = filas.find((f) => f.identificador_visible === nueva.identificador_visible)
          if (colision) return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
        }
      }
      const insertadas = nuevas.map((f) => ({ id: randomUUID(), generado_en: new Date().toISOString(), storage_path: null, ...f }))
      filas.push(...insertadas)
      return { data: insertadas, error: null }
    }

    if (this.operacion === 'actualizar') {
      const coincidentes = filas.filter((f) => this.filtros.every(([c, v]) => f[c] === v))
      coincidentes.forEach((f) => Object.assign(f, this.payload))
      return { data: coincidentes, error: null }
    }

    const resultado = filas.filter((f) => this.filtros.every(([c, v]) => f[c] === v))
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
    onfulfilled?: ((value: { data: Fila[] | null; error: { message: string; code?: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.ejecutar()).then(onfulfilled, onrejected)
  }
}

class ClienteSupabaseFalso {
  private tablas = new Map<string, Fila[]>()
  private archivosStorage = new Map<string, Buffer>()
  public escrituras: Array<{ tabla: string; tipo: 'insert' | 'update' | 'delete' }> = []
  private fallasForzadas: Array<{ tabla: string; operacion: 'insert' | 'update' | 'select' }> = []
  private fallaStorageForzada = false

  constructor(datosIniciales: Record<string, Fila[]> = {}) {
    for (const [tabla, filas] of Object.entries(datosIniciales)) {
      this.tablas.set(tabla, filas.map((f) => ({ ...f })))
    }
  }

  from(tabla: string) {
    return new ConsultaFalsa(this, tabla)
  }

  storage = {
    getBucket: async (bucket: string) => ({ data: { name: bucket }, error: null }),
    createBucket: async () => ({ error: null }),
    from: (bucket: string) => ({
      upload: async (ruta: string, buffer: Buffer) => {
        if (this.fallaStorageForzada) return { error: { message: 'Error simulado subiendo a Storage' } }
        this.archivosStorage.set(`${bucket}/${ruta}`, buffer)
        return { error: null }
      },
      createSignedUrl: async (ruta: string) => {
        if (!this.archivosStorage.has(`${bucket}/${ruta}`)) return { data: null, error: { message: 'archivo no encontrado' } }
        return { data: { signedUrl: `https://fake-storage.local/${bucket}/${ruta}` }, error: null }
      },
      remove: async (rutas: string[]) => {
        rutas.forEach((r) => this.archivosStorage.delete(`${bucket}/${r}`))
        return { error: null }
      },
    }),
  }

  forzarErrorStorage() {
    this.fallaStorageForzada = true
  }

  quitarErrorStorage() {
    this.fallaStorageForzada = false
  }

  archivoExiste(bucket: string, ruta: string): boolean {
    return this.archivosStorage.has(`${bucket}/${ruta}`)
  }

  _tabla(tabla: string): Fila[] {
    if (!this.tablas.has(tabla)) this.tablas.set(tabla, [])
    return this.tablas.get(tabla)!
  }

  _registrarEscritura(tabla: string, tipo: 'insert' | 'update' | 'delete') {
    this.escrituras.push({ tabla, tipo })
  }

  _debeFallar(tabla: string, operacion: 'insert' | 'update' | 'select'): boolean {
    return this.fallasForzadas.some((f) => f.tabla === tabla && f.operacion === operacion)
  }

  forzarErrorEn(tabla: string, operacion: 'insert' | 'update' | 'select') {
    this.fallasForzadas.push({ tabla, operacion })
  }
}

function clienteFalso(datos: Record<string, Fila[]> = {}): { sb: SupabaseClient; interno: ClienteSupabaseFalso } {
  const interno = new ClienteSupabaseFalso(datos)
  return { sb: interno as unknown as SupabaseClient, interno }
}

const DOCENTE_1 = 'docente-1'
const GRUPO_1 = 'grupo-1'
const PROYECTO_1 = 'proyecto-1'

// Orden alfabético real esperado (obtenerRosterConPosicion ordena por
// nombre.localeCompare): Andrés(1), Beatriz(2), Carla(3).
function inscripcionesBase(): Fila[] {
  return [
    { id: 'insc-1', grupo_id: GRUPO_1, estatus: 'activo', alumnos: { id: 'a1', nombre: 'Beatriz López', curp: null, sexo: 'M', fecha_nacimiento: null } },
    { id: 'insc-2', grupo_id: GRUPO_1, estatus: 'activo', alumnos: { id: 'a2', nombre: 'Andrés Pérez', curp: null, sexo: 'H', fecha_nacimiento: null } },
    { id: 'insc-3', grupo_id: GRUPO_1, estatus: 'activo', alumnos: { id: 'a3', nombre: 'Carla Ruiz', curp: null, sexo: 'M', fecha_nacimiento: null } },
  ]
}

function datosBase(): Record<string, Fila[]> {
  return {
    inscripciones: inscripcionesBase(),
    perfiles_docentes: [{ id: DOCENTE_1, escuela: 'Escuela de prueba', grado: '4°', grupo: 'B', ciclo_escolar: '2026-2027' }],
    proyectos_seguimiento: [{ id: PROYECTO_1, grupo_id: GRUPO_1, docente_id: DOCENTE_1, estado: 'planeado', hoja_id: null }],
    hojas_evaluacion: [],
  }
}

const INDICADORES_5: IndicadorProyecto[] = [
  { indicador_especifico: 'Identifica estructura narrativa', aspecto_general: 'logro_aprendizaje' },
  { indicador_especifico: 'Lee con fluidez', aspecto_general: 'logro_aprendizaje' },
  { indicador_especifico: 'Produce una leyenda propia', aspecto_general: 'logro_aprendizaje' },
  { indicador_especifico: 'Aplica convenciones de escritura', aspecto_general: 'logro_aprendizaje' },
  { indicador_especifico: 'Reconoce el origen cultural', aspecto_general: 'logro_aprendizaje' },
]

const DATOS_HOJA = {
  proyectoId: PROYECTO_1,
  grupoId: GRUPO_1,
  nombreProyecto: 'Leyendas de mi comunidad',
  camposFormativos: ['Lenguajes'],
  trimestreNombre: 'Primer trimestre',
  fechaInicio: '2026-08-10',
  fechaFin: '2026-08-21',
  indicadores: INDICADORES_5,
}

type RosterCongeladoFila = { alumno_id: string; inscripcion_id: string; nombre: string; posicion: number }
type IndicadorCongeladoFila = { numero_indicador: number; indicador_especifico: string; aspecto_general: string }

async function main() {
  // CASO A/B — una hoja nueva persiste roster_congelado con exactamente los 4 campos esperados.
  {
    const { sb, interno } = clienteFalso(datosBase())
    const perfil = interno._tabla('perfiles_docentes')[0]
    const r = await generarYGuardarHojaSeguimiento(sb, DOCENTE_1, DATOS_HOJA, perfil, 'America/Mexico_City')
    verificar(r.ok === true, 'CASO A precondición: la hoja se genera con éxito')

    const fila = interno._tabla('hojas_evaluacion')[0] as { roster_congelado?: RosterCongeladoFila[]; indicadores?: IndicadorCongeladoFila[] }
    const roster = fila.roster_congelado ?? []
    verificar(Array.isArray(roster) && roster.length === 3, 'CASO A. roster_congelado se persiste con los 3 alumnos del grupo')

    const claves = new Set(roster.flatMap((a) => Object.keys(a)))
    verificar(claves.has('alumno_id') && claves.has('inscripcion_id') && claves.has('nombre') && claves.has('posicion') && claves.size === 4, 'CASO B. cada elemento tiene EXACTAMENTE alumno_id/inscripcion_id/nombre/posicion, nada más')

    const porNombre = new Map(roster.map((a) => [a.nombre, a]))
    verificar(porNombre.get('Andrés Pérez')?.alumno_id === 'a2' && porNombre.get('Andrés Pérez')?.inscripcion_id === 'insc-2' && porNombre.get('Andrés Pérez')?.posicion === 1, 'CASO B. Andrés Pérez congelado con alumno_id/inscripcion_id/posición correctos (primero alfabético)')
    verificar(porNombre.get('Beatriz López')?.posicion === 2, 'CASO B. Beatriz López en posición 2')
    verificar(porNombre.get('Carla Ruiz')?.posicion === 3, 'CASO B. Carla Ruiz en posición 3')
  }

  // CASO C — el mismo roster/indicadores congelados son los que alimentan el PDF (misma fuente, nunca dos arrays distintos).
  {
    const contenido = (await import('node:fs')).readFileSync(new URL('../lib/seguimiento/generarYGuardarHoja.ts', import.meta.url), 'utf-8')
    verificar(/alumnosParaPdf = rosterCongelado\.map/.test(contenido), 'CASO C (estructural). alumnosParaPdf se deriva literalmente de rosterCongelado, nunca de una segunda lectura de `roster`')
    verificar(/indicadoresParaPdf = indicadoresCongelados/.test(contenido), 'CASO C (estructural). indicadoresParaPdf se deriva literalmente de indicadoresCongelados')

    const { sb, interno } = clienteFalso(datosBase())
    const perfil = interno._tabla('perfiles_docentes')[0]
    await generarYGuardarHojaSeguimiento(sb, DOCENTE_1, DATOS_HOJA, perfil, null)
    const fila = interno._tabla('hojas_evaluacion')[0] as { storage_path?: string }
    verificar(!!fila.storage_path && interno.archivoExiste('hojas-seguimiento', fila.storage_path), 'CASO C. el PDF real se generó y subió a Storage a partir de esos mismos arrays (sin excepción, sin datos faltantes)')
  }

  // CASO D — modificar el roster vivo DESPUÉS de crear la hoja no cambia roster_congelado.
  {
    const datos = datosBase()
    const { sb, interno } = clienteFalso(datos)
    const perfil = interno._tabla('perfiles_docentes')[0]
    await generarYGuardarHojaSeguimiento(sb, DOCENTE_1, DATOS_HOJA, perfil, null)
    const congeladoOriginal = JSON.stringify((interno._tabla('hojas_evaluacion')[0] as { roster_congelado?: unknown }).roster_congelado)

    // Simula un alta real en el grupo después de generada la hoja.
    interno._tabla('inscripciones').push({ id: 'insc-4', grupo_id: GRUPO_1, estatus: 'activo', alumnos: { id: 'a4', nombre: 'Diego Torres', curp: null, sexo: 'H', fecha_nacimiento: null } })

    const congeladoDespues = JSON.stringify((interno._tabla('hojas_evaluacion')[0] as { roster_congelado?: unknown }).roster_congelado)
    verificar(congeladoOriginal === congeladoDespues, 'CASO D. roster_congelado permanece IDÉNTICO tras un alta posterior en el grupo — nunca se recalcula')
    verificar(!congeladoDespues.includes('Diego Torres'), 'CASO D. el alumno dado de alta después NUNCA aparece en el roster ya congelado')
  }

  // CASO E/G — un retry sobre una hoja existente NO modifica roster_congelado ni indicadores, incluso si el roster vivo cambió entre intentos.
  {
    const { sb, interno } = clienteFalso(datosBase())
    const perfil = interno._tabla('perfiles_docentes')[0]
    interno.forzarErrorStorage()
    const r1 = await generarYGuardarHojaSeguimiento(sb, DOCENTE_1, DATOS_HOJA, perfil, null)
    verificar(!r1.ok, 'CASO E precondición: el primer intento falla (Storage forzado a fallar), pero la fila con roster_congelado ya quedó creada')
    const congeladoOriginal = JSON.stringify((interno._tabla('hojas_evaluacion')[0] as { roster_congelado?: unknown }).roster_congelado)
    const indicadoresOriginal = JSON.stringify((interno._tabla('hojas_evaluacion')[0] as { indicadores?: unknown }).indicadores)

    // El roster vivo cambia ENTRE el primer intento y el retry.
    interno._tabla('inscripciones').push({ id: 'insc-5', grupo_id: GRUPO_1, estatus: 'activo', alumnos: { id: 'a5', nombre: 'Elena Vidal', curp: null, sexo: 'M', fecha_nacimiento: null } })

    interno.quitarErrorStorage()
    const r2 = await generarYGuardarHojaSeguimiento(sb, DOCENTE_1, DATOS_HOJA, perfil, null)
    verificar(r2.ok === true, 'CASO E. el retry completa el guardado')
    verificar(interno._tabla('hojas_evaluacion').length === 1, 'CASO E. sigue existiendo una sola fila de hojas_evaluacion — el retry no duplica')

    const congeladoTrasRetry = JSON.stringify((interno._tabla('hojas_evaluacion')[0] as { roster_congelado?: unknown }).roster_congelado)
    const indicadoresTrasRetry = JSON.stringify((interno._tabla('hojas_evaluacion')[0] as { indicadores?: unknown }).indicadores)
    verificar(congeladoOriginal === congeladoTrasRetry, 'CASO E. roster_congelado tras el retry es IDÉNTICO al del primer intento — nunca se reescribe')
    verificar(!congeladoTrasRetry.includes('Elena Vidal'), 'CASO E. el alumno dado de alta ENTRE intentos nunca contamina el roster ya congelado')
    verificar(indicadoresOriginal === indicadoresTrasRetry, 'CASO G. indicadores (con numero_indicador) permanecen estables tras el retry, sin reordenarse ni recalcularse')
  }

  // CASO F — los 5 indicadores nuevos reciben numero_indicador exactamente 1..5, en orden.
  {
    const { sb, interno } = clienteFalso(datosBase())
    const perfil = interno._tabla('perfiles_docentes')[0]
    await generarYGuardarHojaSeguimiento(sb, DOCENTE_1, DATOS_HOJA, perfil, null)
    const indicadores = (interno._tabla('hojas_evaluacion')[0] as { indicadores?: IndicadorCongeladoFila[] }).indicadores ?? []
    verificar(indicadores.length === 5, 'CASO F precondición: se congelaron los 5 indicadores')
    verificar(indicadores.every((ind, i) => ind.numero_indicador === i + 1), 'CASO F. numero_indicador es exactamente 1,2,3,4,5 en el mismo orden del array original')
    verificar(indicadores[0].indicador_especifico === INDICADORES_5[0].indicador_especifico && indicadores[4].indicador_especifico === INDICADORES_5[4].indicador_especifico, 'CASO F. indicador_especifico se conserva sin cambios junto al numero_indicador nuevo')
  }

  // CASO L — mapeo puro de escala numérica de captura al enum canónico de DB.
  {
    verificar(nivelATextoCanonico(4) === 'destacado', 'CASO L. 4 → destacado')
    verificar(nivelATextoCanonico(3) === 'logrado', 'CASO L. 3 → logrado')
    verificar(nivelATextoCanonico(2) === 'en_proceso', 'CASO L. 2 → en_proceso')
    verificar(nivelATextoCanonico(1) === 'requiere_apoyo', 'CASO L. 1 → requiere_apoyo')
    verificar(nivelATextoCanonico(null) === 'no_evaluado', 'CASO L. sin valor (null) → no_evaluado')
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
