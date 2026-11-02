// scripts/verificar-hoja-confirmacion-concurrente.ts
//
// generarYGuardarHojaSeguimiento (lib/seguimiento/generarYGuardarHoja.ts)
// no debe devolver a 'hoja_generada' un proyecto cuyos resultados se
// confirmaron mientras se generaba la hoja: el UPDATE del proyecto va
// condicionado (confirmado_en null y estado anterior a la confirmación)
// y 0 filas afectadas es un conflicto que revierte lo que hizo ese mismo
// intento (ruta de Storage y archivo recién subido) sin tocar nada más.
//
// Determinista, sin red ni credenciales: base en memoria que evalúa los
// filtros del UPDATE como lo haría PostgreSQL sobre la fila, y dobles de
// roster, PDF y Storage. La "confirmación concurrente" se simula
// confirmando el proyecto justo antes de que se ejecute el UPDATE.
//
// Se ejecuta con `npx tsx scripts/verificar-hoja-confirmacion-concurrente.ts`.

import { readFileSync } from 'node:fs'

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
const DOCENTE = 'a1111111-1111-4111-8111-111111111111'
const PROYECTO = 'd0000000-0000-4000-8000-000000000001'
const HOJA = 'e0000000-0000-4000-8000-000000000001'
const CONFIRMADO_EN = '2026-11-02T16:17:47Z'

// ------------------------------------------------ base en memoria
let db: Record<string, Fila[]> = {}
const ops: string[] = [] // bitácora de escrituras efectivas y de Storage
let antesDelUpdateProyecto: (() => void) | null = null
let fallarUpdateProyecto = false
// Reversión de storage_path (update de hojas_evaluacion a null): forzar
// error de Supabase o cambiar la fila justo antes (0 filas afectadas).
let fallarRevertirHoja = false
let antesDeRevertirHoja: (() => void) | null = null
let errorAlEliminar: string | null = null

function condicionOr(expr: string): (f: Fila) => boolean {
  // Soporta exactamente la forma usada: "col.is.null,col.not.in.(a,b)"
  const partes = expr.match(/[^,(]+(\([^)]*\))?/g) ?? []
  const preds = partes.map((p) => {
    const m = p.match(/^(\w+)\.(is\.null|not\.in\.\((.*)\))$/)
    if (!m) throw new Error(`or() no soportado: ${p}`)
    if (m[2] === 'is.null') return (f: Fila) => f[m[1]] == null
    const lista = m[3].split(',')
    return (f: Fila) => f[m[1]] != null && !lista.includes(String(f[m[1]]))
  })
  return (f) => preds.some((pr) => pr(f))
}
function consulta(tabla: string) {
  const filtros: ((f: Fila) => boolean)[] = []
  let accion: { tipo: 'select' | 'update' | 'insert'; valores?: Fila } = { tipo: 'select' }
  let devolver = false
  const filas = () => (db[tabla] ??= [])
  const ejecutar = () => {
    if (accion.tipo === 'insert') {
      const nueva: Fila = { id: HOJA, storage_path: null, ...accion.valores }
      filas().push(nueva)
      ops.push(`insert ${tabla}`)
      return { data: { id: nueva.id, identificador_visible: nueva.identificador_visible }, error: null }
    }
    if (accion.tipo === 'update') {
      if (tabla === 'proyectos_seguimiento') {
        antesDelUpdateProyecto?.()
        antesDelUpdateProyecto = null
        if (fallarUpdateProyecto) return { data: null, error: { code: 'XX000', message: 'falla simulada' } }
      }
      if (tabla === 'hojas_evaluacion' && accion.valores?.storage_path === null) {
        antesDeRevertirHoja?.()
        antesDeRevertirHoja = null
        if (fallarRevertirHoja) return { data: null, error: { code: 'XX000', message: 'falla simulada' } }
      }
      const afectadas = filas().filter((f) => filtros.every((p) => p(f)))
      for (const f of afectadas) Object.assign(f, accion.valores)
      if (afectadas.length) ops.push(`update ${tabla} ${Object.keys(accion.valores ?? {}).join('+')}`)
      return { data: devolver ? afectadas.map((f) => ({ id: f.id })) : null, error: null }
    }
    return { data: filas().filter((f) => filtros.every((p) => p(f))), error: null }
  }
  const b: Record<string, unknown> = {
    select: () => { devolver = true; return b },
    insert: (v: Fila) => { accion = { tipo: 'insert', valores: v }; return b },
    update: (v: Fila) => { accion = { tipo: 'update', valores: v }; return b },
    eq: (c: string, v: unknown) => { filtros.push((f) => f[c] === v); return b },
    is: (c: string, v: unknown) => { filtros.push((f) => (v === null ? f[c] == null : f[c] === v)); return b },
    or: (expr: string) => { filtros.push(condicionOr(expr)); return b },
    maybeSingle: async () => { const r = ejecutar(); return { data: (r.data as Fila[])[0] ?? null, error: r.error } },
    single: async () => ejecutar(),
    then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(ejecutar()).then(ok, ko),
  }
  return b
}
const sb = { from: (t: string) => consulta(t) }

// ------------------------------------------------ dobles de dependencias
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sustituir = (ruta: string, exports: unknown) => { require.cache[ruta] = { id: ruta, filename: ruta, loaded: true, exports } as any }
let secuencia = 0
sustituir(require.resolve('../lib/rosterGrupo'), {
  obtenerRosterConPosicion: async () => ({ data: [{ id: 'alu-1', inscripcion_id: 'ins-1', nombre: 'Alumno Uno', posicion: 1 }], error: null }),
})
sustituir(require.resolve('../lib/documentGen/generarHojaSeguimientoPdf'), {
  generarHojaSeguimientoPdfBuffer: async () => Buffer.from('%PDF-prueba'),
  nombreArchivoHoja: (codigo: string) => `hoja-seguimiento-${codigo}.pdf`,
})
sustituir(require.resolve('../lib/documentGen/almacenamiento'), {
  BUCKET_HOJAS_SEGUIMIENTO: 'hojas-seguimiento',
  rutaArchivo: (docente: string, nombre: string) => `${docente}/${++secuencia}-${nombre}`,
  subirBuffer: async (_sb: unknown, ruta: string) => { ops.push(`storage upload ${ruta}`) },
  eliminarArchivo: async (_sb: unknown, ruta: string) => {
    ops.push(errorAlEliminar ? `storage remove FALLIDO ${ruta}` : `storage remove ${ruta}`)
    return errorAlEliminar
  },
  crearUrlFirmada: async (_sb: unknown, ruta: string) => { ops.push('storage url'); return `https://firmada/${ruta}` },
})

function preparar(proyecto: Fila, hoja: Fila | null) {
  db = {
    proyectos_seguimiento: [{ id: PROYECTO, hoja_id: null, confirmado_en: null, estado: 'planeado', ...proyecto }],
    hojas_evaluacion: hoja ? [{ id: HOJA, proyecto_id: PROYECTO, identificador_visible: 'SG-ABCD', roster_congelado: [{ alumno_id: 'alu-1', inscripcion_id: 'ins-1', nombre: 'Alumno Uno', posicion: 1 }], indicadores: [{ numero_indicador: 1, indicador_especifico: 'I1', aspecto_general: 'logro_aprendizaje' }], ...hoja }] : [],
    seguimiento_resultados: [{ proyecto_id: PROYECTO, inscripcion_id: 'ins-1', indicador_numero: 1, nivel: 'logrado' }],
  }
  ops.length = 0
  antesDelUpdateProyecto = null
  fallarUpdateProyecto = false
  fallarRevertirHoja = false
  antesDeRevertirHoja = null
  errorAlEliminar = null
}
const confirmarConcurrente = () => {
  Object.assign(db.proyectos_seguimiento[0], { estado: 'confirmado', confirmado_en: CONFIRMADO_EN })
}
const proyecto = () => db.proyectos_seguimiento[0]
const hoja = () => db.hojas_evaluacion[0]
const resultadosIntactos = () => JSON.stringify(db.seguimiento_resultados) === JSON.stringify([{ proyecto_id: PROYECTO, inscripcion_id: 'ins-1', indicador_numero: 1, nivel: 'logrado' }])

async function main() {
  const { generarYGuardarHojaSeguimiento, MENSAJE_PROYECTO_CONFIRMADO } = await import('../lib/seguimiento/generarYGuardarHoja')
  const datos = { proyectoId: PROYECTO, grupoId: 'g', nombreProyecto: 'P', camposFormativos: [], trimestreNombre: null, fechaInicio: null, fechaFin: null, indicadores: [{ indicador_especifico: 'I1', aspecto_general: 'logro_aprendizaje' as const }] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generar = () => generarYGuardarHojaSeguimiento(sb as any, DOCENTE, datos, {}, null)

  // 1. Generación normal (hoja nueva, como en la aprobación de planeación).
  preparar({ estado: 'planeado' }, null)
  let r = await generar()
  verificar(r.ok, '1a. Hoja nueva: ok')
  verificar(proyecto().estado === 'hoja_generada' && proyecto().hoja_id === HOJA, '1b. Hoja nueva: proyecto enlazado y en hoja_generada')
  verificar(!!hoja()?.storage_path && ops.includes(`storage upload ${hoja().storage_path}`), '1c. Hoja nueva: PDF subido y storage_path registrado')
  verificar(!ops.some((o) => o.startsWith('storage remove')), '1d. Hoja nueva: ningún archivo eliminado')

  // 6. Compatibilidad con la aprobación: proyecto recién creado con estado nulo.
  preparar({ estado: null }, null)
  r = await generar()
  verificar(r.ok && proyecto().estado === 'hoja_generada', '6. Proyecto recién creado sin estado (aprobación de planeación): ok')

  // Reintentos legítimos antes de confirmar.
  preparar({ estado: 'hoja_generada', hoja_id: HOJA }, { storage_path: 'previa/hoja.pdf' })
  r = await generar()
  verificar(r.ok && proyecto().estado === 'hoja_generada' && !ops.some((o) => o.startsWith('storage upload')), '1e. Reintento con hoja completa: ok, sin volver a subir')
  preparar({ estado: 'requiere_revision', hoja_id: HOJA }, { storage_path: null })
  r = await generar()
  verificar(r.ok && !!hoja().storage_path && proyecto().estado === 'hoja_generada', '1f. Reintento con hoja sin PDF y sin confirmar: sube y enlaza')

  // 2/4/5. Confirmación concurrente antes del UPDATE — hoja ya completa.
  preparar({ estado: 'hoja_generada', hoja_id: HOJA }, { storage_path: 'previa/hoja.pdf' })
  antesDelUpdateProyecto = confirmarConcurrente
  r = await generar()
  verificar(!r.ok && 'conflicto' in r && r.conflicto === true && r.error === MENSAJE_PROYECTO_CONFIRMADO, '2a. Hoja completa + confirmación concurrente: conflicto')
  verificar(proyecto().estado === 'confirmado' && proyecto().confirmado_en === CONFIRMADO_EN, '4a. El proyecto conserva estado confirmado y confirmado_en')
  verificar(hoja().storage_path === 'previa/hoja.pdf', '4b. La hoja existente no cambia')
  verificar(resultadosIntactos(), '4c. Los resultados confirmados no cambian')
  verificar(ops.length === 0, '5a. Sin escrituras ni Storage (ni siquiera URLs firmadas) tras el conflicto')

  // 2/4/5. Confirmación concurrente antes del UPDATE — reintento que ya subió PDF.
  preparar({ estado: 'requiere_revision', hoja_id: HOJA }, { storage_path: null })
  antesDelUpdateProyecto = confirmarConcurrente
  r = await generar()
  const subida = ops.find((o) => o.startsWith('storage upload'))?.replace('storage upload ', '')
  verificar(!r.ok && 'conflicto' in r && r.conflicto === true, '2b. Reintento sin PDF + confirmación concurrente: conflicto')
  verificar(proyecto().estado === 'confirmado' && proyecto().confirmado_en === CONFIRMADO_EN && proyecto().hoja_id === HOJA, '4d. El proyecto conserva su estado confirmado')
  verificar(hoja().storage_path === null, '4e. La ruta registrada por este intento se revierte (hoja como estaba)')
  verificar(!!subida && ops.includes(`storage remove ${subida}`), '5b. El PDF recién subido se elimina (sin huérfanos)')
  verificar(ops.indexOf('update hojas_evaluacion storage_path') < ops.lastIndexOf('update hojas_evaluacion storage_path') && ops.at(-1) === `storage remove ${subida}`, '5c. Orden seguro: se quita la ruta y después el archivo; nada más se ejecuta')
  verificar(!ops.includes('storage url') && resultadosIntactos(), '5d. Sin URLs firmadas tras el conflicto; resultados intactos')

  // 3. UPDATE condicional sin filas afectadas (indicadores ya confirmados).
  for (const [estado, confirmadoEn, etiqueta] of [
    ['confirmado', CONFIRMADO_EN, 'confirmado'],
    ['corregido', null, 'corregido sin confirmado_en'],
    ['cerrado', CONFIRMADO_EN, 'cerrado'],
    ['hoja_generada', CONFIRMADO_EN, 'hoja_generada con confirmado_en'],
  ] as const) {
    preparar({ estado, confirmado_en: confirmadoEn, hoja_id: HOJA }, { storage_path: 'previa/hoja.pdf' })
    r = await generar()
    verificar(!r.ok && 'conflicto' in r && r.conflicto === true && proyecto().estado === estado && ops.length === 0, `3. ${etiqueta}: 0 filas afectadas → conflicto, sin cambios`)
  }

  // Error real del UPDATE: falla (no conflicto) y también revierte.
  preparar({ estado: 'requiere_revision', hoja_id: HOJA }, { storage_path: null })
  fallarUpdateProyecto = true
  r = await generar()
  verificar(!r.ok && !('conflicto' in r && r.conflicto) && hoja().storage_path === null && ops.some((o) => o.startsWith('storage remove')), '3e. Error del UPDATE: falla sin conflicto y revierte su propio archivo')

  // 7. Reversión tras un conflicto: el PDF solo se elimina si se confirmó
  //    que la referencia de ESTE intento se retiró.
  const silenciarConsola = console.error
  const registrosError: string[] = []
  console.error = (...args: unknown[]) => { registrosError.push(args.join(' ')) }
  const conflictoConPdfNuevo = async () => {
    preparar({ estado: 'requiere_revision', hoja_id: HOJA }, { storage_path: null })
    antesDelUpdateProyecto = confirmarConcurrente
  }
  const subidaDe = () => ops.find((o) => o.startsWith('storage upload'))?.replace('storage upload ', '')
  const estadoConfirmadoIntacto = () => proyecto().estado === 'confirmado' && proyecto().confirmado_en === CONFIRMADO_EN && hoja().roster_congelado !== undefined && resultadosIntactos()

  // 7a. Reversión exitosa.
  await conflictoConPdfNuevo()
  r = await generar()
  verificar(!r.ok && hoja().storage_path === null && ops.includes(`storage remove ${subidaDe()}`) && estadoConfirmadoIntacto(), '7a. Reversión exitosa: ruta retirada y después PDF eliminado; lo confirmado intacto')

  // 7b. Error de Supabase al retirar storage_path: el PDF se conserva.
  await conflictoConPdfNuevo()
  fallarRevertirHoja = true
  registrosError.length = 0
  r = await generar()
  let pdfIntento = subidaDe()
  verificar(!r.ok && 'conflicto' in r && r.conflicto === true, '7b. Error al retirar storage_path: sigue siendo un conflicto controlado')
  verificar(!ops.some((o) => o.startsWith('storage remove')), '7c. Error al retirar storage_path: el PDF NO se elimina')
  verificar(hoja().storage_path === pdfIntento && ops.includes(`storage upload ${pdfIntento}`), '7d. La hoja apunta a un PDF que sigue existiendo (referencia válida)')
  verificar(registrosError.some((e) => e.includes('no se pudo confirmar la reversión')) && !/limpi|elimin[oó]/i.test(r.ok ? '' : r.error), '7e. Se registra la reversión no confirmada y el error no afirma ninguna limpieza')
  verificar(estadoConfirmadoIntacto(), '7f. Estado, confirmado_en, roster y resultados intactos')

  // 7g. UPDATE de reversión sin filas afectadas (la ruta ya no es la de
  //     este intento): no se borra nada y la otra referencia se conserva.
  await conflictoConPdfNuevo()
  antesDeRevertirHoja = () => { db.hojas_evaluacion[0].storage_path = 'otra/referencia-valida.pdf' }
  registrosError.length = 0
  r = await generar()
  verificar(!r.ok && !ops.some((o) => o.startsWith('storage remove')), '7g. 0 filas afectadas al revertir: el PDF NO se elimina')
  verificar(hoja().storage_path === 'otra/referencia-valida.pdf', '7h. La referencia ajena a este intento se conserva')
  verificar(registrosError.some((e) => e.includes('no se pudo confirmar la reversión')), '7i. Se registra la reversión no confirmada')

  // 7j. Error al eliminar el archivo tras una reversión confirmada.
  await conflictoConPdfNuevo()
  errorAlEliminar = 'falla simulada de Storage'
  registrosError.length = 0
  r = await generar()
  pdfIntento = subidaDe()
  verificar(!r.ok && 'conflicto' in r && r.conflicto === true && hoja().storage_path === null, '7j. Error al eliminar: la ruta ya está retirada (nunca apunta a un archivo inexistente)')
  verificar(ops.includes(`storage remove FALLIDO ${pdfIntento}`) && registrosError.some((e) => e.includes('no se pudo eliminar el archivo')), '7k. Error al eliminar: se intenta una sola vez y se registra')
  verificar(estadoConfirmadoIntacto(), '7l. Estado, confirmado_en, roster y resultados intactos')
  console.error = silenciarConsola

  // 6. La aprobación de planeación sigue llamando la misma función y
  //    trata cualquier ok:false como fallo genérico (sin cambios).
  const aprobar = readFileSync('lib/planeacion/aprobarBorrador.ts', 'utf8')
  verificar(/generarYGuardarHojaSeguimiento\(/.test(aprobar) && /if \(!resultadoHoja\.ok\)/.test(aprobar), '6b. aprobarBorrador usa el mismo generador y maneja ok:false')
  const ruta = readFileSync('app/api/proyectos-seguimiento/[id]/hoja/route.ts', 'utf8')
  verificar(/resultado\.conflicto \? 409 : 500/.test(ruta), '6c. POST /hoja traduce el conflicto del generador a 409')

  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
    process.exit(0)
  }
}

main()
