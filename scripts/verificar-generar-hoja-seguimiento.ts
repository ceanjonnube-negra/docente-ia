// scripts/verificar-generar-hoja-seguimiento.ts
//
// Prueba aislada (sin credenciales, sin red, sin datos reales) de
// lib/seguimiento/generarYGuardarHoja.ts — la función compartida
// extraída de app/api/proyectos-seguimiento/[id]/hoja/route.ts que
// ahora también reutiliza lib/planeacion/aprobarBorrador.ts (C-005,
// corrección funcional: integración de la hoja de evaluación real).
// Usa un doble en memoria de SupabaseClient, extendido con un mock de
// `storage` (upload/createSignedUrl/remove/getBucket). Se ejecuta con
// `npx tsx scripts/verificar-generar-hoja-seguimiento.ts`.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { generarYGuardarHojaSeguimiento } from '../lib/seguimiento/generarYGuardarHoja'
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
    // getBucket/createBucket viven directo en `.storage` en el SDK
    // real (asegurarBucket en lib/documentGen/almacenamiento.ts los
    // llama así) — nunca en `.storage.from(bucket)`.
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

  forzarErrorEn(tabla: string, operacion: 'insert' | 'update' | 'select') {
    this.fallasForzadas.push({ tabla, operacion })
  }

  quitarErrorForzado(tabla: string, operacion: 'insert' | 'update' | 'select') {
    this.fallasForzadas = this.fallasForzadas.filter((f) => !(f.tabla === tabla && f.operacion === operacion))
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
}

function clienteFalso(datos: Record<string, Fila[]> = {}): { sb: SupabaseClient; interno: ClienteSupabaseFalso } {
  const interno = new ClienteSupabaseFalso(datos)
  return { sb: interno as unknown as SupabaseClient, interno }
}

const DOCENTE_1 = 'docente-1'
const GRUPO_1 = 'grupo-1'
const PROYECTO_1 = 'proyecto-1'

function datosBase(): Record<string, Fila[]> {
  return {
    inscripciones: [
      { grupo_id: GRUPO_1, estatus: 'activo', alumnos: { id: 'a1', nombre: 'Beatriz López', curp: null, sexo: 'M', fecha_nacimiento: null } },
      { grupo_id: GRUPO_1, estatus: 'activo', alumnos: { id: 'a2', nombre: 'Andrés Pérez', curp: null, sexo: 'H', fecha_nacimiento: null } },
    ],
    perfiles_docentes: [{ id: DOCENTE_1, escuela: 'Escuela de prueba', grado: '4°', grupo: 'B', ciclo_escolar: '2026-2027' }],
    proyectos_seguimiento: [{ id: PROYECTO_1, grupo_id: GRUPO_1, docente_id: DOCENTE_1, estado: 'planeado', hoja_id: null }],
    hojas_evaluacion: [],
  }
}

const INDICADORES: IndicadorProyecto[] = [{ indicador_especifico: 'Identifica estructura narrativa', aspecto_general: 'logro_aprendizaje' }]

const DATOS_HOJA = {
  proyectoId: PROYECTO_1,
  grupoId: GRUPO_1,
  nombreProyecto: 'Leyendas de mi comunidad',
  camposFormativos: ['Lenguajes'],
  trimestreNombre: 'Primer trimestre',
  fechaInicio: '2026-08-10',
  fechaFin: '2026-08-21',
  indicadores: INDICADORES,
}

async function main() {
  // Generación exitosa de principio a fin
  {
    const { sb, interno } = clienteFalso(datosBase())
    const perfil = interno._tabla('perfiles_docentes')[0]
    const r = await generarYGuardarHojaSeguimiento(sb, DOCENTE_1, DATOS_HOJA, perfil, 'America/Mexico_City')
    verificar(r.ok === true, 'Genera y guarda la hoja con éxito de principio a fin')
    if (r.ok) {
      verificar(r.identificadorVisible.startsWith('SG-'), 'El identificador definitivo tiene el formato real (SG-XXXX)')
      verificar(r.url.includes('hojas-seguimiento'), 'La URL apunta al bucket de hojas de seguimiento')
    }
    verificar(interno._tabla('hojas_evaluacion').length === 1, 'Se insertó exactamente 1 fila en hojas_evaluacion')
    const proyecto = interno._tabla('proyectos_seguimiento')[0] as { estado: string; hoja_id: string | null }
    verificar(proyecto.estado === 'hoja_generada' && !!proyecto.hoja_id, 'proyectos_seguimiento queda vinculado y en estado hoja_generada')
  }

  // Reintento tras fallo en Storage — recupera la misma fila, no inserta otra
  {
    const { sb, interno } = clienteFalso(datosBase())
    const perfil = interno._tabla('perfiles_docentes')[0]
    interno.forzarErrorStorage()
    const r1 = await generarYGuardarHojaSeguimiento(sb, DOCENTE_1, DATOS_HOJA, perfil, null)
    verificar(!r1.ok, 'Si falla la subida a Storage, se reporta como fallo controlado')
    verificar(interno._tabla('hojas_evaluacion').length === 1, 'La fila de hojas_evaluacion ya quedó creada (storage_path aún null)')

    interno.quitarErrorStorage()
    const r2 = await generarYGuardarHojaSeguimiento(sb, DOCENTE_1, DATOS_HOJA, perfil, null)
    verificar(r2.ok === true, 'El reintento después del fallo de Storage completa el guardado')
    verificar(interno._tabla('hojas_evaluacion').length === 1, 'Sigue existiendo exactamente 1 fila — el reintento reutilizó la misma, no insertó otra')
  }

  // Ya estaba completamente lista — no se regenera ni se vuelve a subir
  {
    const datos = datosBase()
    datos.hojas_evaluacion = [{ id: 'hoja-1', proyecto_id: PROYECTO_1, identificador_visible: 'SG-TEST', storage_path: `${DOCENTE_1}/hoja-existente.pdf`, indicadores: [] }]
    const { sb, interno } = clienteFalso(datos)
    // Simula que el archivo ya existe en Storage de un intento previo.
    await interno.storage.from('hojas-seguimiento').upload(`${DOCENTE_1}/hoja-existente.pdf`, Buffer.from('contenido-previo'))
    const perfil = interno._tabla('perfiles_docentes')[0]
    const r = await generarYGuardarHojaSeguimiento(sb, DOCENTE_1, DATOS_HOJA, perfil, null)
    verificar(r.ok === true && r.identificadorVisible === 'SG-TEST', 'Si ya existe una hoja completa, se reutiliza tal cual (mismo identificador)')
    verificar(interno.escrituras.filter((e) => e.tabla === 'hojas_evaluacion' && e.tipo === 'insert').length === 0, 'No se inserta una segunda fila en hojas_evaluacion')
  }

  // Colisión de identificador — reintenta con uno nuevo, nunca falla por eso solo
  {
    const datos = datosBase()
    datos.hojas_evaluacion = [{ id: 'hoja-colision', proyecto_id: 'otro-proyecto', identificador_visible: 'SG-FIJO', storage_path: null, indicadores: [] }]
    const { sb, interno } = clienteFalso(datos)
    const perfil = interno._tabla('perfiles_docentes')[0]
    const r = await generarYGuardarHojaSeguimiento(sb, DOCENTE_1, DATOS_HOJA, perfil, null)
    verificar(r.ok === true, 'Una colisión de identificador con OTRO proyecto no impide generar la hoja (reintenta con otro código)')
  }

  // Sin alumnos: no debe explotar, genera la hoja igual (tabla vacía de alumnos)
  {
    const datos = datosBase()
    datos.inscripciones = []
    const { sb, interno } = clienteFalso(datos)
    const perfil = interno._tabla('perfiles_docentes')[0]
    const r = await generarYGuardarHojaSeguimiento(sb, DOCENTE_1, DATOS_HOJA, perfil, null)
    verificar(r.ok === true, 'Genera la hoja incluso sin alumnos inscritos (tabla vacía, sin excepción)')
  }

  // Seguridad: sin service_role, sin cliente propio, sin DELETE de filas
  {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const contenido = fs.readFileSync(path.join(__dirname, '..', 'lib', 'seguimiento', 'generarYGuardarHoja.ts'), 'utf-8')
    verificar(!contenido.includes('SERVICE_ROLE') && !contenido.includes('createClient('), 'generarYGuardarHoja.ts no usa SERVICE_ROLE ni crea su propio cliente')
    verificar(!contenido.includes(".from('hojas_evaluacion').delete(") && !contenido.includes(".from('proyectos_seguimiento').delete("), 'generarYGuardarHoja.ts nunca ejecuta DELETE sobre filas de base de datos')
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
