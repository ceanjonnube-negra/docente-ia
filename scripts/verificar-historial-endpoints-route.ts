// scripts/verificar-historial-endpoints-route.ts
//
// Etapa 2 del historial académico: endpoints de solo lectura
//   GET /api/proyectos-seguimiento/historial-grupo
//   GET /api/proyectos-seguimiento/[id]/resultados-confirmados
//
// Prueba de comportamiento determinista, sin red ni credenciales: se
// sustituye @supabase/supabase-js por un doble en memoria (dos docentes,
// sus grupos, proyectos y resultados) y se llaman los GET reales.
// Comprueba autenticación, aislamiento entre docentes, validación de
// entradas, ciclo resuelto en servidor, estado del proyecto, que nunca se
// usa service_role y que no hay ninguna operación de escritura.
//
// Se ejecuta con `npx tsx scripts/verificar-historial-endpoints-route.ts`.

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

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:1'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'clave-anon-ficticia'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'clave-service-role-que-nunca-debe-usarse'

const DOC_A = 'a1111111-1111-4111-8111-111111111111'
const DOC_B = 'b2222222-2222-4222-8222-222222222222'
const CICLO = 'c1111111-1111-4111-8111-111111111111'
const CICLO_ANTERIOR = 'c0000000-0000-4000-8000-000000000000'
const G_A = 'a0000000-0000-4000-8000-0000000000a1'
const G_B = 'b0000000-0000-4000-8000-0000000000b1'
const G_SIN_CICLO = 'a0000000-0000-4000-8000-0000000000a2'
const P_CONF = 'd0000000-0000-4000-8000-000000000001'
const P_PEND = 'd0000000-0000-4000-8000-000000000002'
const P_SIN_HOJA = 'd0000000-0000-4000-8000-000000000003'
const P_B = 'd0000000-0000-4000-8000-000000000004'
const P_OTRO_CICLO = 'd0000000-0000-4000-8000-000000000005'
const H1 = 'e0000000-0000-4000-8000-000000000001'
const H2 = 'e0000000-0000-4000-8000-000000000002'
const H_B = 'e0000000-0000-4000-8000-000000000004'
const INS_1 = 'f0000000-0000-4000-8000-000000000001', ALU_1 = 'f1000000-0000-4000-8000-000000000001'
const INS_2 = 'f0000000-0000-4000-8000-000000000002', ALU_2 = 'f1000000-0000-4000-8000-000000000002'
const INS_B = 'f0000000-0000-4000-8000-000000000009', ALU_B = 'f1000000-0000-4000-8000-000000000009'
const INEXISTENTE = '99999999-9999-4999-8999-999999999999'

type Fila = Record<string, unknown>
const proyectos: Fila[] = [
  { id: P_CONF, docente_id: DOC_A, grupo_id: G_A, ciclo_escolar_id: CICLO, estado: 'confirmado', hoja_id: H1, confirmado_en: '2026-11-02T16:17:47Z', periodo_evaluacion_id: null, nombre: 'Confirmado', origen_resultados: 'fotografia' },
  { id: P_PEND, docente_id: DOC_A, grupo_id: G_A, ciclo_escolar_id: CICLO, estado: 'requiere_revision', hoja_id: H2, confirmado_en: null, periodo_evaluacion_id: null, nombre: 'Pendiente', origen_resultados: null },
  { id: P_SIN_HOJA, docente_id: DOC_A, grupo_id: G_A, ciclo_escolar_id: CICLO, estado: 'borrador', hoja_id: null, confirmado_en: null, periodo_evaluacion_id: null, nombre: 'Sin hoja', origen_resultados: null },
  { id: P_B, docente_id: DOC_B, grupo_id: G_B, ciclo_escolar_id: CICLO, estado: 'confirmado', hoja_id: H_B, confirmado_en: '2026-11-01T10:00:00Z', periodo_evaluacion_id: null, nombre: 'De B', origen_resultados: 'fotografia' },
  { id: P_OTRO_CICLO, docente_id: DOC_A, grupo_id: G_A, ciclo_escolar_id: CICLO_ANTERIOR, estado: 'confirmado', hoja_id: null, confirmado_en: '2025-11-01T10:00:00Z', periodo_evaluacion_id: null, nombre: 'Ciclo anterior', origen_resultados: 'fotografia' },
]
const proyectoPorId = (id: string) => proyectos.find((p) => p.id === id)!
function resultado(proyectoId: string, ins: string, alu: string, n: number, nivel: string): Fila {
  return { proyecto_id: proyectoId, alumno_id: alu, inscripcion_id: ins, indicador_numero: n, indicador_especifico: `Indicador ${n}`, aspecto_general: 'logro_aprendizaje', nivel, confianza: 1, corregido_manualmente: false, observacion: null, proyectos_seguimiento: proyectoPorId(proyectoId) }
}
const tablas: Record<string, Fila[]> = {
  grupos: [
    { id: G_A, docente_id: DOC_A, ciclo_escolar_id: CICLO },
    { id: G_B, docente_id: DOC_B, ciclo_escolar_id: CICLO },
    { id: G_SIN_CICLO, docente_id: DOC_A, ciclo_escolar_id: null },
  ],
  proyectos_seguimiento: proyectos,
  hojas_evaluacion: [
    { id: H1, roster_congelado: [{ alumno_id: ALU_2, inscripcion_id: INS_2, nombre: 'Alumno Dos', posicion: 2 }, { alumno_id: ALU_1, inscripcion_id: INS_1, nombre: 'Alumno Uno', posicion: 1 }], indicadores: [1, 2].map((n) => ({ numero_indicador: n, indicador_especifico: `Indicador ${n}`, aspecto_general: 'logro_aprendizaje' })) },
    { id: H2, roster_congelado: [], indicadores: [] },
  ],
  seguimiento_resultados: [
    resultado(P_CONF, INS_1, ALU_1, 1, 'destacado'), resultado(P_CONF, INS_1, ALU_1, 2, 'logrado'),
    resultado(P_CONF, INS_2, ALU_2, 1, 'en_proceso'), resultado(P_CONF, INS_2, ALU_2, 2, 'requiere_apoyo'),
    resultado(P_PEND, INS_1, ALU_1, 1, 'logrado'),
    resultado(P_B, INS_B, ALU_B, 1, 'destacado'),
    resultado(P_OTRO_CICLO, INS_1, ALU_1, 1, 'logrado'),
  ],
}

// ------------------------------------------------ doble de supabase-js
const registro = { clavesCreateClient: [] as string[], escrituras: [] as string[], tablasLeidas: [] as string[] }
let fallarTabla: string | null = null
const ESCRITURA = ['insert', 'update', 'upsert', 'delete']
function valorEn(fila: Fila, columna: string): unknown {
  const [a, b] = columna.split('.')
  return b ? (fila[a] as Fila | null)?.[b] : fila[a]
}
function consulta(tabla: string) {
  registro.tablasLeidas.push(tabla)
  const filtros: ((f: Fila) => boolean)[] = []
  const resolver = () => {
    if (fallarTabla === tabla) return { data: null, error: { code: 'XX000', message: 'falla simulada' } }
    return { data: (tablas[tabla] ?? []).filter((f) => filtros.every((p) => p(f))), error: null }
  }
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    eq: (c: string, v: unknown) => { filtros.push((f) => valorEn(f, c) === v); return b },
    not: (c: string, op: string, v: unknown) => { if (op === 'is' && v === null) filtros.push((f) => valorEn(f, c) != null); return b },
    maybeSingle: async () => { const r = resolver(); return r.error ? r : { data: (r.data as Fila[])[0] ?? null, error: null } },
    then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(resolver()).then(ok, ko),
  }
  for (const m of ESCRITURA) b[m] = () => { registro.escrituras.push(`${tabla}.${m}`); return b }
  return b
}
const USUARIOS: Record<string, string> = { 'token-a': DOC_A, 'token-b': DOC_B }
function createClient(_url: string, clave: string) {
  registro.clavesCreateClient.push(clave)
  return {
    auth: { getUser: async (token: string) => (USUARIOS[token] ? { data: { user: { id: USUARIOS[token] } }, error: null } : { data: { user: null }, error: { message: 'invalid' } }) },
    from: (tabla: string) => consulta(tabla),
    rpc: () => { registro.escrituras.push('rpc'); return consulta('rpc') },
    storage: { from: () => { registro.escrituras.push('storage'); return {} } },
  }
}
const ruta = require.resolve('@supabase/supabase-js')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
require.cache[ruta] = { id: ruta, filename: ruta, loaded: true, exports: { createClient } } as any

async function main() {
  const { NextRequest } = await import('next/server')
  const { GET: historialGrupo } = await import('../app/api/proyectos-seguimiento/historial-grupo/route')
  const { GET: resultadosConfirmados } = await import('../app/api/proyectos-seguimiento/[id]/resultados-confirmados/route')

  const pedir = (url: string, token?: string) => new NextRequest(`http://localhost${url}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  async function historial(query: string, token?: string) {
    const r = await historialGrupo(pedir(`/api/proyectos-seguimiento/historial-grupo${query}`, token))
    return { status: r.status, cuerpo: await r.json() }
  }
  async function matriz(id: string, token?: string) {
    const r = await resultadosConfirmados(pedir(`/api/proyectos-seguimiento/${id}/resultados-confirmados`, token), { params: Promise.resolve({ id }) })
    return { status: r.status, cuerpo: await r.json() }
  }

  // 1. historial-grupo
  verificar((await historial(`?grupo_id=${G_A}`)).status === 401, '1a. historial: sin token → 401')
  verificar((await historial(`?grupo_id=${G_A}`, 'token-falso')).status === 401, '1b. historial: token inválido → 401')
  verificar((await historial('', 'token-a')).status === 400, '1c. historial: falta grupo_id → 400')
  verificar((await historial('?grupo_id=no-es-uuid', 'token-a')).status === 400, '1d. historial: grupo_id no UUID → 400')
  verificar((await historial(`?grupo_id=${INEXISTENTE}`, 'token-a')).status === 404, '1e. historial: grupo inexistente → 404')
  verificar((await historial(`?grupo_id=${G_B}`, 'token-a')).status === 403, '1f. historial: grupo de otro docente → 403')
  verificar((await historial(`?grupo_id=${G_A}`, 'token-b')).status === 403, '1g. historial: el docente B no accede al grupo de A → 403')
  verificar((await historial(`?grupo_id=${G_SIN_CICLO}`, 'token-a')).status === 409, '1h. historial: grupo sin ciclo → 409')

  registro.tablasLeidas.length = 0
  const ok = await historial(`?grupo_id=${G_A}&ciclo_escolar_id=${CICLO_ANTERIOR}`, 'token-a')
  const h = ok.cuerpo.historial
  verificar(ok.status === 200, '1i. historial: grupo propio → 200')
  verificar(h?.proyectos?.map((p: { proyectoId: string }) => p.proyectoId).join() === P_CONF, '1j. historial: solo el proyecto confirmado del grupo y ciclo (excluye pendiente, otro ciclo y otro docente)')
  verificar(h?.resumen?.totalIndicadoresConfirmados === 4 && h?.resumen?.alumnosConResultados === 2, '1k. historial: 4 indicadores de 2 alumnos')
  verificar(h?.alumnos?.find((a: { inscripcionId: string }) => a.inscripcionId === INS_1)?.alumnoId === ALU_1, '1l. historial: alumno asociado por inscripción')
  verificar(h?.entradasAmbiguasExcluidas === 0 && h?.entradasInvalidasExcluidas === 0, '1m. historial: 0 exclusiones con datos válidos')
  verificar(registro.tablasLeidas.join() === 'grupos,seguimiento_resultados', '1n. historial: exactamente 2 consultas (grupo y resultados), ciclo ignorado del cliente')

  fallarTabla = 'seguimiento_resultados'
  verificar((await historial(`?grupo_id=${G_A}`, 'token-a')).status === 500, '1o. historial: error de Supabase → 500 (nunca lista vacía)')
  fallarTabla = null

  // 2. [id]/resultados-confirmados
  verificar((await matriz('no-es-uuid', 'token-a')).status === 400, '2a. matriz: id no UUID → 400')
  verificar((await matriz(P_CONF)).status === 401, '2b. matriz: sin token → 401')
  verificar((await matriz(P_CONF, 'token-falso')).status === 401, '2c. matriz: token inválido → 401')
  verificar((await matriz(INEXISTENTE, 'token-a')).status === 404, '2d. matriz: proyecto inexistente → 404')
  verificar((await matriz(P_B, 'token-a')).status === 403, '2e. matriz: proyecto de otro docente → 403')
  verificar((await matriz(P_CONF, 'token-b')).status === 403, '2f. matriz: el docente B no accede al proyecto de A → 403')
  verificar((await matriz(P_SIN_HOJA, 'token-a')).status === 409, '2g. matriz: proyecto sin hoja → 409')
  verificar((await matriz(P_PEND, 'token-a')).status === 409, '2h. matriz: proyecto no confirmado → 409')

  registro.tablasLeidas.length = 0
  const m = await matriz(P_CONF, 'token-a')
  const alumnos = m.cuerpo.matriz?.alumnos ?? []
  verificar(m.status === 200, '2i. matriz: proyecto confirmado propio → 200')
  verificar(alumnos.map((a: { inscripcionId: string }) => a.inscripcionId).join() === `${INS_1},${INS_2}`, '2j. matriz: alumnos por posición del roster congelado')
  verificar(alumnos.map((a: { celdas: { nivel: string }[] }) => a.celdas.map((c) => c.nivel).join('/')).join('|') === 'destacado/logrado|en_proceso/requiere_apoyo', '2k. matriz: niveles exactos y solo del proyecto pedido')
  verificar(registro.tablasLeidas.join() === 'proyectos_seguimiento,hojas_evaluacion,seguimiento_resultados', '2l. matriz: exactamente 3 consultas (proyecto, hoja, resultados)')

  fallarTabla = 'seguimiento_resultados'
  verificar((await matriz(P_CONF, 'token-a')).status === 500, '2m. matriz: error de Supabase → 500')
  fallarTabla = null

  // 3. Garantías transversales.
  verificar(registro.escrituras.length === 0, '3a. Ninguna escritura, RPC ni Storage en todas las llamadas')
  verificar(registro.clavesCreateClient.length > 0 && registro.clavesCreateClient.every((c) => c === 'clave-anon-ficticia'), '3b. Siempre cliente anon con el token del docente, nunca service_role')
  for (const archivo of ['app/api/proyectos-seguimiento/historial-grupo/route.ts', 'app/api/proyectos-seguimiento/[id]/resultados-confirmados/route.ts']) {
    const codigo = readFileSync(archivo, 'utf8').replace(/\/\/.*$/gm, '')
    verificar(!/export (async )?function (POST|PUT|PATCH|DELETE)/.test(codigo), `3c. ${archivo}: solo exporta GET`)
    verificar(!/SERVICE_ROLE|anthropic|openai|@ai-sdk|from ['"]ai['"]/i.test(codigo), `3d. ${archivo}: sin service_role ni IA`)
  }
  const historialCodigo = readFileSync('app/api/proyectos-seguimiento/historial-grupo/route.ts', 'utf8')
  verificar(/resultadosProyectoGrupo\(/.test(historialCodigo) && /construirHistorialGrupo\(/.test(historialCodigo) && !/from\('seguimiento_resultados'\)/.test(historialCodigo), '3e. historial reutiliza las funciones de la Etapa 1 (sin consulta duplicada)')
  const matrizCodigo = readFileSync('app/api/proyectos-seguimiento/[id]/resultados-confirmados/route.ts', 'utf8')
  verificar(/construirMatrizResultadosConfirmados\(/.test(matrizCodigo), '3f. matriz reutiliza construirMatrizResultadosConfirmados()')

  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
    process.exit(0)
  }
}

main()
