// scripts/verificar-persistencia-planeacion.ts
//
// Prueba aislada (sin credenciales, sin red, sin datos reales) de
// lib/planeacion/persistencia.ts — Paso 2 de C-005. Usa un doble
// (fake) mínimo de SupabaseClient, en memoria, que solo implementa
// las cadenas exactas que persistencia.ts utiliza. Se ejecuta con
// `npx tsx scripts/verificar-persistencia-planeacion.ts`.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  crearPlaneacion,
  listarPlaneaciones,
  obtenerPlaneacionPorId,
  actualizarPlaneacion,
  archivarPlaneacion,
} from '../lib/planeacion/persistencia'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// --- Doble mínimo de SupabaseClient ---------------------------------

type Fila = Record<string, unknown>

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
  private rangos: Array<['gt', string, unknown]> = []
  private orden: { columna: string; ascendente: boolean } | null = null
  private operacion: 'consultar' | 'insertar' | 'actualizar' = 'consultar'
  private payload: Fila | Fila[] | null = null

  constructor(private cliente: ClienteSupabaseFalso, private tabla: string) {}

  select(_columnas: string) {
    void _columnas // el doble no filtra columnas, solo imita la firma real
    return this
  }

  insert(valores: Fila | Fila[]) {
    this.operacion = 'insertar'
    this.payload = valores
    return this
  }

  update(valores: Fila) {
    this.operacion = 'actualizar'
    this.payload = valores
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
    if (this.cliente._debeFallar(this.tabla)) {
      return { data: null, error: { message: 'Error simulado de Supabase' } }
    }
    const filas = this.cliente._tabla(this.tabla)

    if (this.operacion === 'insertar') {
      const nuevas = Array.isArray(this.payload) ? this.payload : [this.payload as Fila]
      const insertadas = nuevas.map(f => ({
        id: randomUUID(),
        creado_en: new Date().toISOString(),
        actualizado_en: new Date().toISOString(),
        ...f,
      }))
      filas.push(...insertadas)
      return { data: insertadas, error: null }
    }

    if (this.operacion === 'actualizar') {
      const coincidentes = filas.filter(f => this.filtros.every(([c, v]) => f[c] === v))
      coincidentes.forEach(f => Object.assign(f, this.payload))
      return { data: coincidentes, error: null }
    }

    let resultado = filas.filter(f =>
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
  private errorForzadoTabla: string | null = null

  constructor(private usuario: { id: string } | null, datosIniciales: Record<string, Fila[]> = {}) {
    for (const [tabla, filas] of Object.entries(datosIniciales)) {
      this.tablas.set(tabla, filas.map(f => ({ ...f })))
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

  forzarErrorEn(tabla: string) {
    this.errorForzadoTabla = tabla
  }

  _tabla(tabla: string): Fila[] {
    if (!this.tablas.has(tabla)) this.tablas.set(tabla, [])
    return this.tablas.get(tabla)!
  }

  _debeFallar(tabla: string): boolean {
    return this.errorForzadoTabla === tabla
  }
}

function clienteFalso(usuario: { id: string } | null, datos: Record<string, Fila[]> = {}): SupabaseClient {
  // Cast deliberado: es un doble mínimo, no una implementación completa
  // del SDK real — solo cubre las cadenas que persistencia.ts usa.
  return new ClienteSupabaseFalso(usuario, datos) as unknown as SupabaseClient
}

const DOCENTE_1 = { id: 'docente-1' }
const DOCENTE_2 = { id: 'docente-2' }

function datosBase(): Record<string, Fila[]> {
  return {
    grupos: [
      { id: 'grupo-1', docente_id: 'docente-1', ciclo_escolar_id: 'ciclo-1' },
      { id: 'grupo-2', docente_id: 'docente-2', ciclo_escolar_id: 'ciclo-2' },
    ],
    planeaciones: [
      {
        id: 'plan-1', docente_id: 'docente-1', grupo_id: 'grupo-1', ciclo_escolar_id: 'ciclo-1',
        periodo_evaluacion_id: 'periodo-1', nombre: 'Planeación existente', proposito: null,
        fecha_inicio: '2026-08-03', fecha_fin: '2026-08-14', estado: 'borrador', version: 1,
        creado_en: '2026-08-01T00:00:00.000Z', actualizado_en: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'plan-2', docente_id: 'docente-1', grupo_id: 'grupo-1', ciclo_escolar_id: 'ciclo-1',
        periodo_evaluacion_id: 'periodo-2', nombre: 'Otra planeación', proposito: null,
        fecha_inicio: '2026-09-01', fecha_fin: '2026-09-12', estado: 'borrador', version: 1,
        creado_en: '2026-08-01T00:00:00.000Z', actualizado_en: '2026-08-01T00:00:00.000Z',
      },
    ],
    planeacion_proyectos: [
      {
        id: 'proy-1', planeacion_id: 'plan-1', nombre: 'Proyecto de prueba', campos_formativos: [], contenidos: [],
        pda: [], ejes_articuladores: [], metodologia: null, duracion_dias: null, actividades: [], recursos: [],
        evaluacion: {}, orden: 1, creado_en: '2026-08-01T00:00:00.000Z', actualizado_en: '2026-08-01T00:00:00.000Z',
      },
    ],
  }
}

async function main() {
  // 1. Creación válida
  {
    const supabase = clienteFalso(DOCENTE_1, datosBase())
    const r = await crearPlaneacion({ supabase }, { docente_id: 'docente-1', grupo_id: 'grupo-1', nombre: 'Nueva planeación' })
    verificar(r.ok === true, '1. Creación válida devuelve ok:true')
    if (r.ok) {
      verificar(r.datos.estado === 'borrador', '1. Estado por defecto es "borrador"')
      verificar(r.datos.docente_id === 'docente-1', '1. docente_id se resuelve de la sesión')
      verificar(!!r.datos.id, '1. Se genera un id')
    }
  }

  // 2. Campos faltantes
  {
    const supabase = clienteFalso(DOCENTE_1, datosBase())
    const r = await crearPlaneacion({ supabase }, { docente_id: 'docente-1', grupo_id: 'grupo-1', nombre: '   ' })
    verificar(r.ok === false && r.error.codigo === 'CAMPOS_FALTANTES', '2. Nombre vacío produce CAMPOS_FALTANTES')
  }

  // 3. Listado por grupo
  {
    const supabase = clienteFalso(DOCENTE_1, datosBase())
    const r = await listarPlaneaciones({ supabase }, { grupo_id: 'grupo-1' })
    verificar(r.ok === true && r.datos.length === 2, '3. Listado por grupo devuelve las 2 planeaciones del grupo')
  }

  // 4. Listado por trimestre (periodo_evaluacion_id)
  {
    const supabase = clienteFalso(DOCENTE_1, datosBase())
    const r = await listarPlaneaciones({ supabase }, { grupo_id: 'grupo-1', periodo_evaluacion_id: 'periodo-2' })
    verificar(r.ok === true && r.datos.length === 1 && r.datos[0].id === 'plan-2', '4. Listado por trimestre filtra correctamente')
  }

  // 5. Consulta por ID válida, incluye proyectos vinculados
  {
    const supabase = clienteFalso(DOCENTE_1, datosBase())
    const r = await obtenerPlaneacionPorId({ supabase }, 'plan-1')
    verificar(r.ok === true, '5. Consulta por ID válida devuelve ok:true')
    if (r.ok) {
      verificar(r.datos.planeacion.id === 'plan-1', '5. Devuelve la planeación correcta')
      verificar(r.datos.proyectos.length === 1 && r.datos.proyectos[0].id === 'proy-1', '5. Incluye los proyectos vinculados')
    }
  }

  // 6. Consulta de registro inexistente
  {
    const supabase = clienteFalso(DOCENTE_1, datosBase())
    const r = await obtenerPlaneacionPorId({ supabase }, 'plan-no-existe')
    verificar(r.ok === false && r.error.codigo === 'PLANEACION_NO_ENCONTRADA', '6. Registro inexistente produce PLANEACION_NO_ENCONTRADA')
  }

  // 7. Actualización parcial (no sobrescribe campos no incluidos, incrementa version)
  {
    const supabase = clienteFalso(DOCENTE_1, datosBase())
    const r = await actualizarPlaneacion({ supabase }, 'plan-1', { proposito: 'Nuevo propósito' })
    verificar(r.ok === true, '7. Actualización parcial devuelve ok:true')
    if (r.ok) {
      verificar(r.datos.proposito === 'Nuevo propósito', '7. El campo indicado se actualiza')
      verificar(r.datos.nombre === 'Planeación existente', '7. Los campos no incluidos permanecen intactos')
      verificar(r.datos.version === 2, '7. La versión se incrementa en un cambio de contenido')
    }
  }

  // 8. Protección de docente_id (otro docente no puede leer/editar)
  {
    const supabase = clienteFalso(DOCENTE_2, datosBase())
    const rGet = await obtenerPlaneacionPorId({ supabase }, 'plan-1')
    const rUpd = await actualizarPlaneacion({ supabase }, 'plan-1', { nombre: 'Intento ajeno' })
    verificar(rGet.ok === false && rGet.error.codigo === 'PLANEACION_AJENA', '8. Consulta de planeación ajena produce PLANEACION_AJENA')
    verificar(rUpd.ok === false && rUpd.error.codigo === 'PLANEACION_AJENA', '8. Edición de planeación ajena produce PLANEACION_AJENA')
  }

  // 9. Protección de grupo_id (no se puede crear en un grupo ajeno)
  {
    const supabase = clienteFalso(DOCENTE_1, datosBase())
    const r = await crearPlaneacion({ supabase }, { docente_id: 'docente-1', grupo_id: 'grupo-2', nombre: 'Intento en grupo ajeno' })
    verificar(r.ok === false && r.error.codigo === 'GRUPO_AJENO', '9. Crear en un grupo ajeno produce GRUPO_AJENO')
  }

  // 10. Archivado sin borrado físico, sin incrementar versión
  {
    const supabase = clienteFalso(DOCENTE_1, datosBase())
    const r = await archivarPlaneacion({ supabase }, 'plan-1')
    verificar(r.ok === true, '10. Archivado devuelve ok:true')
    if (r.ok) {
      verificar(r.datos.estado === 'archivada', '10. El estado cambia a "archivada"')
      verificar(r.datos.version === 1, '10. Archivar no incrementa la versión')
    }
    const rGet = await obtenerPlaneacionPorId({ supabase }, 'plan-1')
    verificar(rGet.ok === true, '10. El registro archivado sigue existiendo (sin borrado físico)')
  }

  // 11. Error controlado de Supabase (no lanza excepción)
  {
    const supabase = clienteFalso(DOCENTE_1, datosBase()) as unknown as ClienteSupabaseFalso
    ;(supabase as unknown as ClienteSupabaseFalso).forzarErrorEn('planeaciones')
    const r = await listarPlaneaciones({ supabase: supabase as unknown as SupabaseClient }, { grupo_id: 'grupo-1' })
    verificar(r.ok === false && r.error.codigo === 'ERROR_SUPABASE', '11. Un error de Supabase se devuelve como resultado tipado, sin lanzar excepción')
  }

  // 12. Confirmación estática: nunca se usa service_role ni se crea un cliente propio
  {
    const contenido = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'persistencia.ts'), 'utf-8')
    verificar(!contenido.includes('SERVICE_ROLE'), '12. persistencia.ts no referencia ninguna clave SERVICE_ROLE')
    verificar(!contenido.includes('createClient('), '12. persistencia.ts nunca crea su propio cliente de Supabase')
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
