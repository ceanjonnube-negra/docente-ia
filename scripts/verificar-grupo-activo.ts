// scripts/verificar-grupo-activo.ts
//
// lib/grupoActivo.ts — resolución única del grupo activo para Lista y
// Evaluación: contexto guardado (docente_contexto_activo) como
// preferencia revalidada y, si no es válido, el grupo más reciente del
// docente en un ciclo activo (empate por id). Base en memoria que aplica
// los mismos filtros, orden y límite; sin red ni credenciales.
//
// Se ejecuta con `npx tsx scripts/verificar-grupo-activo.ts`.

import { readFileSync } from 'node:fs'
import { resolverGrupoActivo } from '../lib/grupoActivo'

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
const DOC = 'doc-a', OTRO = 'doc-b'
const CICLO = 'ciclo-activo', CICLO_VIEJO = 'ciclo-inactivo', CICLO_2 = 'ciclo-activo-2'
const ciclos: Record<string, boolean> = { [CICLO]: true, [CICLO_2]: true, [CICLO_VIEJO]: false }
const grupo = (id: string, docente: string, ciclo: string, creado: string): Fila => ({ id, nombre_grupo: `Grupo ${id}`, institucion_id: 'inst', docente_id: docente, ciclo_escolar_id: ciclo, creado_en: creado })

let db: Record<string, Fila[]> = {}
let fallarGrupos = false
const escrituras: string[] = []

function consulta(tabla: string) {
  const filtros: ((f: Fila) => boolean)[] = []
  const ordenes: [string, boolean][] = []
  let limite = Infinity
  const filas = () => {
    const base = (db[tabla] ?? []).map((f) => (tabla === 'grupos' ? { ...f, ciclos_escolares: { activo: ciclos[f.ciclo_escolar_id as string] } } : f))
    const r = base.filter((f) => filtros.every((p) => p(f)))
    r.sort((a, b) => { for (const [c, asc] of ordenes) { const x = String(a[c]), y = String(b[c]); if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1) } return 0 })
    return r.slice(0, limite)
  }
  const valor = (f: Fila, c: string) => { const [a, b] = c.split('.'); return b ? (f[a] as Fila | undefined)?.[b] : f[a] }
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (c: string, v: unknown) => { filtros.push((f) => valor(f, c) === v); return b },
    order: (c: string, o: { ascending: boolean }) => { ordenes.push([c, o.ascending]); return b },
    limit: (n: number) => { limite = n; return b },
    maybeSingle: async () => ({ data: filas()[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve(tabla === 'grupos' && fallarGrupos ? { data: null, error: { code: 'XX000' } } : { data: filas(), error: null }).then(ok, ko),
  }
  for (const m of ['insert', 'update', 'upsert', 'delete']) b[m] = () => { escrituras.push(`${tabla}.${m}`); return b }
  return b
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = { from: (t: string) => consulta(t) } as any

function preparar(grupos: Fila[], contexto: Fila | null) {
  db = { grupos, docente_contexto_activo: contexto ? [{ docente_id: DOC, ...contexto }] : [] }
  fallarGrupos = false
}

async function main() {
  const G1 = grupo('g1', DOC, CICLO, '2026-08-01T00:00:00Z')
  const G2 = grupo('g2', DOC, CICLO, '2026-09-01T00:00:00Z') // el más reciente
  const G_VIEJO = grupo('g-viejo', DOC, CICLO_VIEJO, '2026-10-01T00:00:00Z')
  const G_AJENO = grupo('g-ajeno', OTRO, CICLO, '2026-10-15T00:00:00Z')

  // 1. Contexto válido: gana aunque no sea el más reciente.
  preparar([G1, G2], { grupo_id: 'g1', ciclo_escolar_id: CICLO })
  let r = await resolverGrupoActivo(sb, DOC)
  verificar(r.ok && r.grupo.id === 'g1' && r.origen === 'contexto', '1a. Contexto válido: se usa el grupo guardado (g1), no el más reciente')
  preparar([G1, G2], { grupo_id: 'g1', ciclo_escolar_id: null })
  r = await resolverGrupoActivo(sb, DOC)
  verificar(r.ok && r.grupo.id === 'g1', '1b. Contexto sin ciclo guardado: basta con que el grupo sea del docente y su ciclo esté activo')

  // 2. Contexto ausente: el más reciente.
  preparar([G1, G2], null)
  r = await resolverGrupoActivo(sb, DOC)
  verificar(r.ok && r.grupo.id === 'g2' && r.origen === 'mas_reciente', '2. Sin contexto: el grupo más reciente en ciclo activo (g2)')

  // 3. Contexto inválido o ajeno: se descarta y se usa el fallback.
  preparar([G1, G2, G_AJENO], { grupo_id: 'g-ajeno', ciclo_escolar_id: CICLO })
  r = await resolverGrupoActivo(sb, DOC)
  verificar(r.ok && r.grupo.id === 'g2' && r.origen === 'mas_reciente', '3a. Contexto con grupo de otro docente: descartado, nunca se devuelve el ajeno')
  preparar([G1, G2, G_VIEJO], { grupo_id: 'g-viejo', ciclo_escolar_id: CICLO_VIEJO })
  r = await resolverGrupoActivo(sb, DOC)
  verificar(r.ok && r.grupo.id === 'g2', '3b. Contexto con grupo de ciclo inactivo: descartado')
  preparar([G1, G2], { grupo_id: 'no-existe', ciclo_escolar_id: CICLO })
  r = await resolverGrupoActivo(sb, DOC)
  verificar(r.ok && r.grupo.id === 'g2', '3c. Contexto con grupo inexistente: descartado')
  preparar([G1, G2], { grupo_id: 'g1', ciclo_escolar_id: CICLO_2 })
  r = await resolverGrupoActivo(sb, DOC)
  verificar(r.ok && r.grupo.id === 'g2', '3d. Contexto cuyo ciclo no coincide con el del grupo: descartado')

  // 4. Varios grupos autorizados: determinista.
  const G_A = grupo('g-b', DOC, CICLO, '2026-09-01T00:00:00Z'), G_B = grupo('g-a', DOC, CICLO, '2026-09-01T00:00:00Z')
  preparar([G_A, G_B, G1], null)
  const ids = new Set<string>()
  for (let i = 0; i < 5; i++) { const x = await resolverGrupoActivo(sb, DOC); if (x.ok) ids.add(x.grupo.id) }
  verificar(ids.size === 1 && ids.has('g-a'), '4a. Empate en creado_en: siempre el mismo grupo (menor id), en cada llamada')
  preparar([G_VIEJO, G_AJENO], null)
  r = await resolverGrupoActivo(sb, DOC)
  verificar(!r.ok && r.motivo === 'sin_grupo', '4b. Solo grupos ajenos o de ciclo inactivo: sin grupo (fail-closed)')
  preparar([G1], null); fallarGrupos = true
  r = await resolverGrupoActivo(sb, DOC)
  verificar(!r.ok && r.motivo === 'error', '4c. Error de Supabase: error explícito, nunca un grupo inventado')
  verificar(escrituras.length === 0, '4d. Solo lectura: ninguna escritura')

  // 5. Lista y Evaluación usan la misma resolución.
  for (const ruta of ['app/dashboard/lista/page.tsx', 'app/dashboard/evaluacion/page.tsx']) {
    const codigo = readFileSync(ruta, 'utf8')
    verificar(/resolverGrupoActivo\(supabase, user\.id\)/.test(codigo), `5a. ${ruta} resuelve el grupo con resolverGrupoActivo`)
    verificar(!/\.from\('grupos'\)/.test(codigo) && !/docente_contexto_activo'\)/.test(codigo), `5b. ${ruta} ya no tiene una resolución propia de grupos`)
  }
  preparar([G1, G2], { grupo_id: 'g1', ciclo_escolar_id: CICLO })
  const [lista, evaluacion] = await Promise.all([resolverGrupoActivo(sb, DOC), resolverGrupoActivo(sb, DOC)])
  verificar(lista.ok && evaluacion.ok && lista.grupo.id === evaluacion.grupo.id, '5c. Con los mismos datos, Lista y Evaluación obtienen el mismo grupo')

  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
    process.exit(0)
  }
}

main()
