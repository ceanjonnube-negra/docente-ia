// scripts/verificar-encabezado-lista-grupo.ts
//
// El encabezado de la lista de alumnos del Chat ("📋 LISTA OFICIAL DE
// ALUMNOS / 4° B") usa el grado y la letra del grupo EFECTIVO de la sesión
// (conversación fijada o contexto activo), nunca los del perfil docente.
// Base en memoria; sin red, sin IA.
//
// Se ejecuta con `npx tsx scripts/verificar-encabezado-lista-grupo.ts`.

import { readFileSync } from 'node:fs'
import { obtenerSesionContexto } from '../lib/sesionContexto'
import { rotuloGrupo } from '../lib/grupoActivo'
import { leerVinculoConversacion } from '../lib/vinculoConversacion'
import { construirTextoListaAlumnos } from '../lib/motorContexto'

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
const DOC = 'doc-a'
const grupo = (id: string, grado: string | null, letra: string | null, nombre: string | null, creado: string): Fila =>
  ({ id, nombre_grupo: nombre, institucion_id: 'inst', docente_id: DOC, ciclo_escolar_id: 'c1', creado_en: creado, grado, grupo: letra })
const inscripcion = (grupoId: string, alumno: string, nombre: string): Fila => ({ grupo_id: grupoId, estatus: 'activo', alumno_id: alumno, numero_lista: 1, alumnos: { nombre, sexo: 'M' } })
const db: Record<string, Fila[]> = {
  grupos: [grupo('g-a', '4', 'A', '4° A', '2026-08-01T00:00:00Z'), grupo('g-b', '4', 'B', '4° B', '2026-09-01T00:00:00Z')],
  docente_contexto_activo: [{ docente_id: DOC, grupo_id: 'g-b', ciclo_escolar_id: 'c1' }],
  // El perfil dice "4° A": no debe aparecer en la lista de B.
  perfiles_docentes: [{ id: DOC, grado: '4°', grupo: 'A' }],
  inscripciones: [inscripcion('g-a', 'alu-a', 'Ana del Grupo A'), inscripcion('g-b', 'alu-b', 'Beto del Grupo B')],
  conversaciones_chat: [{ id: 'c-a', docente_id: DOC, grupo_contexto_version: 1, grupo_id: 'g-a' }],
}
function consulta(tabla: string) {
  const filtros: ((f: Fila) => boolean)[] = []
  const ordenes: [string, boolean][] = []
  let limite = Infinity
  const valor = (f: Fila, c: string) => { const [a, b] = c.split('.'); return b ? (f[a] as Fila | undefined)?.[b] : f[a] }
  const filas = () => {
    const base = (db[tabla] ?? []).map((f) => (tabla === 'grupos' ? { ...f, ciclos_escolares: { activo: true } } : f))
    const r = base.filter((f) => filtros.every((p) => p(f)))
    r.sort((a, b) => { for (const [c, asc] of ordenes) { const x = String(a[c]), y = String(b[c]); if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1) } return 0 })
    return r.slice(0, limite)
  }
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (c: string, v: unknown) => { filtros.push((f) => valor(f, c) === v); return b },
    order: (c: string, o: { ascending: boolean }) => { ordenes.push([c, o.ascending]); return b },
    limit: (n: number) => { limite = n; return b },
    maybeSingle: async () => ({ data: filas()[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve({ data: filas(), error: null }).then(ok, ko),
  }
  return b
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = { from: (t: string) => consulta(t) } as any

async function lista(conversacionId: string | null) {
  const sesion = await obtenerSesionContexto(sb, DOC, 'America/Mexico_City', await leerVinculoConversacion(sb, conversacionId))
  return { sesion, texto: construirTextoListaAlumnos(sesion.alumnos_del_grupo_activo, sesion.grupo_activo_grado, sesion.grupo_activo_letra) }
}

async function main() {
  // 1. Grupo A por conversación fijada; grupo B por contexto activo.
  const a = await lista('c-a')
  verificar(a.texto.split('\n')[1] === '4° A' && a.texto.includes('Ana del Grupo A') && !a.texto.includes('Beto'), '1a. Conversación fijada a A: encabezado "4° A" y solo alumnos de A')
  const b = await lista(null)
  verificar(b.texto.split('\n')[1] === '4° B' && b.texto.includes('Beto del Grupo B') && !b.texto.includes('Ana'), '1b. Contexto activo B: encabezado "4° B" (no el "4° A" del perfil) y solo alumnos de B')
  verificar(a.sesion.grupo_activo_id === 'g-a' && b.sesion.grupo_activo_id === 'g-b', '1c. La resolución de grupo no cambia (A por conversación, B por contexto)')

  // 2. Rótulo independiente del nivel educativo y de datos incompletos.
  const casos: [string, Parameters<typeof rotuloGrupo>[0], string][] = [
    ['preescolar 2° C', { grado: '2', grupo: 'C', nombre_grupo: null }, '2° C'],
    ['secundaria 3° A', { grado: '3', grupo: 'A', nombre_grupo: null }, '3° A'],
    ['grado ya con símbolo, sin duplicarlo', { grado: '5°', grupo: 'B', nombre_grupo: null }, '5° B'],
    ['sin letra', { grado: '1', grupo: null, nombre_grupo: null }, '1°'],
    ['sin grado: nombre del grupo', { grado: null, grupo: null, nombre_grupo: 'Grupo Rojo' }, 'Grupo Rojo'],
    ['sin datos: subtítulo vacío, nunca del perfil', { grado: null, grupo: null, nombre_grupo: null }, ''],
  ]
  for (const [nombre, g, esperado] of casos) {
    const r = rotuloGrupo(g)
    const subtitulo = construirTextoListaAlumnos([], r.grado, r.letra).split('\n')[1]
    verificar(subtitulo === esperado, `2. ${nombre} → "${esperado}"`)
  }

  // 3. /api/chat arma el encabezado con la sesión, no con el perfil.
  const ruta = readFileSync('app/api/chat/route.ts', 'utf8')
  verificar(/construirTextoListaAlumnos\(sesion\.alumnos_del_grupo_activo, sesion\.grupo_activo_grado, sesion\.grupo_activo_letra\)/.test(ruta) && !/construirTextoListaAlumnos\([^)]*perfilLista/.test(ruta), '3. /api/chat usa grado y letra del grupo efectivo, no perfilLista')

  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
    process.exit(0)
  }
}

main()
