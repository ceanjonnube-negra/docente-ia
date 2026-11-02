// scripts/verificar-hoja-bloqueo-confirmado.ts
//
// POST /api/proyectos-seguimiento/[id]/hoja no debe regenerar la hoja ni
// devolver a 'hoja_generada' un proyecto cuyos resultados ya fueron
// confirmados (confirmado_en o estado confirmado/corregido/sustituido/
// cerrado). Prueba de comportamiento determinista, sin red ni
// credenciales: se sustituyen @supabase/supabase-js y
// lib/seguimiento/generarYGuardarHoja por dobles que registran cada
// llamada.
//
// Se ejecuta con `npx tsx scripts/verificar-hoja-bloqueo-confirmado.ts`.

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:1'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'clave-anon-ficticia'

const DOC_A = 'a1111111-1111-4111-8111-111111111111'
const DOC_B = 'b2222222-2222-4222-8222-222222222222'
const id = (n: number) => `d0000000-0000-4000-8000-00000000000${n}`
type Fila = Record<string, unknown>
const proyecto = (n: number, estado: string, confirmadoEn: string | null, docente = DOC_A): Fila => ({
  id: id(n), docente_id: docente, grupo_id: 'g', nombre: `Proyecto ${n}`, campos_formativos: [], periodo_evaluacion_id: null,
  fecha_inicio: null, fecha_fin: null, estado, hoja_id: null, confirmado_en: confirmadoEn,
})
const CONFIRMADO_EN = '2026-11-02T16:17:47Z'
const proyectos: Fila[] = [
  proyecto(1, 'borrador', null),
  proyecto(2, 'hoja_generada', null),
  proyecto(3, 'requiere_revision', null),
  proyecto(4, 'confirmado', CONFIRMADO_EN),
  proyecto(5, 'corregido', CONFIRMADO_EN),
  proyecto(6, 'sustituido', CONFIRMADO_EN),
  proyecto(7, 'cerrado', CONFIRMADO_EN),
  proyecto(8, 'hoja_generada', CONFIRMADO_EN), // inconsistente: estado regresó, confirmado_en no
  proyecto(9, 'confirmado', null), // inconsistente: estado confirmado sin confirmado_en
]

// ------------------------------------------------ doble de supabase-js
const registro = { escrituras: [] as string[], storage: 0, lecturas: [] as string[], generar: 0 }
const ESCRITURA = ['insert', 'update', 'upsert', 'delete']
function consulta(tabla: string) {
  registro.lecturas.push(tabla)
  const filtros: ((f: Fila) => boolean)[] = []
  const datos = () => (tabla === 'proyectos_seguimiento' ? proyectos : tabla === 'perfiles_docentes' ? [{ id: DOC_A }] : []).filter((f) => filtros.every((p) => p(f)))
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (c: string, v: unknown) => { filtros.push((f) => f[c] === v); return b },
    maybeSingle: async () => ({ data: datos()[0] ?? null, error: null }),
    single: async () => ({ data: datos()[0] ?? null, error: null }),
  }
  for (const m of ESCRITURA) b[m] = () => { registro.escrituras.push(`${tabla}.${m}`); return b }
  return b
}
const USUARIOS: Record<string, string> = { 'token-a': DOC_A, 'token-b': DOC_B }
function createClient() {
  return {
    auth: { getUser: async (t: string) => (USUARIOS[t] ? { data: { user: { id: USUARIOS[t] } }, error: null } : { data: { user: null }, error: { message: 'invalid' } }) },
    from: (tabla: string) => consulta(tabla),
    rpc: () => { registro.escrituras.push('rpc'); return consulta('rpc') },
    storage: { from: () => { registro.storage++; return {} } },
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sustituir = (ruta: string, exports: unknown) => { require.cache[ruta] = { id: ruta, filename: ruta, loaded: true, exports } as any }
sustituir(require.resolve('@supabase/supabase-js'), { createClient })
const MENSAJE_PROYECTO_CONFIRMADO = 'Los resultados de este proyecto ya fueron confirmados; la hoja no se puede volver a generar.'
// Simula una confirmación concurrente detectada por el UPDATE condicional
// del generador (ver scripts/verificar-hoja-confirmacion-concurrente.ts).
let generadorEnConflicto = false
sustituir(require.resolve('../lib/seguimiento/generarYGuardarHoja'), {
  MENSAJE_PROYECTO_CONFIRMADO,
  generarYGuardarHojaSeguimiento: async () => {
    registro.generar++
    if (generadorEnConflicto) return { ok: false, conflicto: true, error: MENSAJE_PROYECTO_CONFIRMADO }
    return { ok: true, hojaId: 'h', identificadorVisible: 'SG-TEST', url: 'u', urlVer: 'v' }
  },
})

async function main() {
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../app/api/proyectos-seguimiento/[id]/hoja/route')
  const INDICADORES = [{ indicador_especifico: 'Explica el ciclo del agua', aspecto_general: 'logro_aprendizaje' }]

  async function pedir(proyectoId: string, token = 'token-a') {
    registro.escrituras.length = 0; registro.storage = 0; registro.lecturas.length = 0; registro.generar = 0
    const req = new NextRequest('http://localhost/api/proyectos-seguimiento/x/hoja', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: token, indicadores: INDICADORES, zona_horaria: 'America/Mexico_City' }),
    })
    const r = await POST(req, { params: Promise.resolve({ id: proyectoId }) })
    return { status: r.status, cuerpo: await r.json() }
  }
  const sinEfectos = () => registro.generar === 0 && registro.escrituras.length === 0 && registro.storage === 0 && registro.lecturas.join() === 'proyectos_seguimiento'

  // 1. Sin confirmar: flujo permitido.
  for (const [n, estado] of [[1, 'borrador'], [2, 'hoja_generada'], [3, 'requiere_revision']] as const) {
    const r = await pedir(id(n))
    verificar(r.status === 200 && registro.generar === 1 && r.cuerpo.hoja?.identificador_visible === 'SG-TEST', `1. Estado ${estado} sin confirmado_en → 200 y genera la hoja`)
  }

  // 2. Confirmado y estados posteriores: 409 sin efectos.
  for (const [n, estado] of [[4, 'confirmado'], [5, 'corregido'], [6, 'sustituido'], [7, 'cerrado']] as const) {
    const r = await pedir(id(n))
    verificar(r.status === 409, `2a. Estado ${estado} → 409`)
    verificar(sinEfectos(), `2b. Estado ${estado}: no genera, no escribe, no toca Storage, solo lee el proyecto`)
  }

  // 3. Indicadores inconsistentes: cualquiera de los dos basta.
  let r = await pedir(id(8))
  verificar(r.status === 409 && sinEfectos(), '3a. confirmado_en no nulo con estado hoja_generada → 409 sin efectos')
  r = await pedir(id(9))
  verificar(r.status === 409 && sinEfectos(), '3b. Estado confirmado sin confirmado_en → 409 sin efectos')
  verificar(/confirmad/i.test(String(r.cuerpo.error)), '3c. El 409 explica que los resultados ya fueron confirmados')

  // 3d. Confirmación concurrente: la lectura previa vio el proyecto sin
  //     confirmar, pero el UPDATE condicional del generador no afectó filas.
  generadorEnConflicto = true
  r = await pedir(id(3))
  generadorEnConflicto = false
  verificar(r.status === 409 && registro.generar === 1 && r.cuerpo.error === MENSAJE_PROYECTO_CONFIRMADO, '3d. Conflicto del generador (confirmación concurrente) → 409, no 500')
  verificar(!registro.lecturas.slice(1).includes('proyectos_seguimiento'), '3e. Tras el conflicto no se vuelve a leer ni a devolver el proyecto')

  // 4. Las verificaciones previas siguen intactas y van antes del bloqueo.
  verificar((await pedir('no-es-uuid')).status === 400, '4a. Id no UUID → 400')
  verificar((await pedir(id(4), 'token-falso')).status === 401, '4b. Token inválido → 401 (antes de revelar el estado)')
  r = await pedir(id(4), 'token-b')
  verificar(r.status === 403 && registro.generar === 0, '4c. Proyecto confirmado de otro docente → 403 (no revela el estado)')
  verificar((await pedir('99999999-9999-4999-8999-999999999999')).status === 404, '4d. Proyecto inexistente → 404')

  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
    process.exit(0)
  }
}

main()

export {}
