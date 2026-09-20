// scripts/verificar-resolver-contexto-curricular.ts
//
// Prueba aislada (sin credenciales, sin red) del resolver curricular
// runtime — PA-2C ("reparación del contexto + resolver curricular
// runtime"). La lógica de política (elegirVersion, elegirFaseYVersion,
// evaluarCobertura) es pura y se prueba aquí con arrays construidos a
// mano, mismo doble mínimo de SupabaseClient que ya usan los demás
// scripts de C-005/contexto autenticado (ver
// scripts/verificar-contexto-autenticado-planeacion.ts), extendido con
// .in() — no usado hasta ahora en ningún otro script de esta serie. El
// resultado real contra el grupo 4°B (datos reales, ya reparados) se
// verifica aparte, contra Supabase real — ver el reporte de PA-2C.
//
// Se ejecuta con `npx tsx scripts/verificar-resolver-contexto-curricular.ts`.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  elegirVersion,
  elegirFaseYVersion,
  evaluarCobertura,
  resolverContextoCurricularGrupo,
  type FaseVersionCandidata,
  type CampoConCobertura,
} from '../lib/curriculo/resolverContextoCurricularGrupo'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// --- Mismo doble mínimo de SupabaseClient que los demás scripts de
//     esta serie, extendido con .in(). ---

type Fila = Record<string, unknown>

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
  private filtrosIn: Array<[string, unknown[]]> = []

  constructor(private cliente: ClienteSupabaseFalso, private tabla: string) {}

  select(_columnas: string) {
    void _columnas
    return this
  }

  eq(columna: string, valor: unknown) {
    this.filtros.push([columna, valor])
    return this
  }

  in(columna: string, valores: unknown[]) {
    this.filtrosIn.push([columna, valores])
    return this
  }

  private ejecutar(): { data: Fila[] | null; error: { message: string } | null } {
    const filas = this.cliente._tabla(this.tabla)
    const resultado = filas.filter((f) => {
      if (!this.filtros.every(([c, v]) => f[c] === v)) return false
      if (!this.filtrosIn.every(([c, vs]) => vs.includes(f[c]))) return false
      return true
    })
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

  constructor(datosIniciales: Record<string, Fila[]> = {}) {
    for (const [tabla, filas] of Object.entries(datosIniciales)) {
      this.tablas.set(tabla, filas.map((f) => ({ ...f })))
    }
  }

  from(tabla: string) {
    return new ConsultaFalsa(this, tabla)
  }

  _tabla(tabla: string): Fila[] {
    if (!this.tablas.has(tabla)) this.tablas.set(tabla, [])
    return this.tablas.get(tabla)!
  }
}

function clienteFalso(datos: Record<string, Fila[]> = {}): SupabaseClient {
  return new ClienteSupabaseFalso(datos) as unknown as SupabaseClient
}

// Fixture base: 1 grado curricular (grado 4 primaria), 1 fase, 1
// versión vigente, 4 campos, cobertura completa — cada test parte de
// esto y solo cambia lo que le interesa probar.
const GRADO_ID = 'grado-4-real'
const FASE_ID = 'fase-4-real'
const VERSION_ID = 'version-vigente-1'
const CAMPOS = [
  { id: 'campo-1', clave: 'lenguajes', nombre: 'Lenguajes', curriculo_version_id: VERSION_ID },
  { id: 'campo-2', clave: 'saberes_pensamiento_cientifico', nombre: 'Saberes y Pensamiento Científico', curriculo_version_id: VERSION_ID },
  { id: 'campo-3', clave: 'etica_naturaleza_sociedades', nombre: 'Ética, Naturaleza y Sociedades', curriculo_version_id: VERSION_ID },
  { id: 'campo-4', clave: 'lo_humano_lo_comunitario', nombre: 'De lo Humano y lo Comunitario', curriculo_version_id: VERSION_ID },
]
function coberturaCompletaPara(versionId: string, faseId: string, gradoId: string) {
  return CAMPOS.map((c) => ({ curriculo_version_id: versionId, fase_id: faseId, grado_id: gradoId, campo_formativo_id: c.id }))
}

function fixtureBase(overrides: Partial<Record<string, Fila[]>> = {}): Record<string, Fila[]> {
  return {
    grupos: [{ id: 'grupo-4b', ciclo_escolar_id: 'ciclo-actual', nivel_educativo: 'primaria', grado: '4' }],
    curriculo_grado: [{ id: GRADO_ID, nivel_educativo: 'primaria', clave: '4' }],
    curriculo_fase_grado: [{ curriculo_grado_id: GRADO_ID, curriculo_fase_id: FASE_ID }],
    curriculo_fase: [{ id: FASE_ID, clave: 'fase_4', curriculo_version_id: VERSION_ID }],
    curriculo_version: [{ id: VERSION_ID, estado: 'vigente' }],
    curriculo_campo_formativo: CAMPOS.map(({ id, clave, nombre, curriculo_version_id }) => ({ id, clave, nombre, curriculo_version_id })),
    curriculo_cobertura: coberturaCompletaPara(VERSION_ID, FASE_ID, GRADO_ID),
    ...overrides,
  }
}

async function main() {
  // --- 1. grupo válido primaria 4 → grado curricular correcto, y no
  //        carga contenidos/PDA (caso 1 y 12). ---
  {
    const sb = clienteFalso(fixtureBase())
    const r = await resolverContextoCurricularGrupo(sb, 'grupo-4b')
    verificar(r.ok === true, '1. grupo válido primaria/4 resuelve ok:true')
    if (r.ok) {
      verificar(r.contexto.curriculoGradoId === GRADO_ID, '1b. curriculoGradoId es el correcto')
      verificar(r.contexto.curriculoFaseClave === 'fase_4', '1c. curriculoFaseClave es fase_4')
      verificar(r.contexto.curriculoVersionId === VERSION_ID, '1d. curriculoVersionId es la vigente')
      verificar(r.contexto.fallbackBorrador === false, '1e. fallbackBorrador=false cuando hay vigente')
      verificar(r.contexto.camposConCobertura.length === 4, '1f. devuelve los 4 campos')
      const claves = Object.keys(r.contexto)
      verificar(!claves.includes('contenidos') && !claves.includes('pda'), '12. el contexto devuelto no incluye contenidos ni PDA')
    }
  }

  // --- 2. nivel NULL → GRUPO_SIN_NIVEL ---
  {
    const sb = clienteFalso(fixtureBase({ grupos: [{ id: 'grupo-4b', ciclo_escolar_id: 'c', nivel_educativo: null, grado: '4' }] }))
    const r = await resolverContextoCurricularGrupo(sb, 'grupo-4b')
    verificar(!r.ok && r.error === 'GRUPO_SIN_NIVEL', '2. nivel_educativo NULL → GRUPO_SIN_NIVEL')
  }

  // --- 3. grado inexistente en el catálogo curricular → GRADO_CURRICULAR_NO_ENCONTRADO ---
  {
    const sb = clienteFalso(fixtureBase({ grupos: [{ id: 'grupo-4b', ciclo_escolar_id: 'c', nivel_educativo: 'primaria', grado: '9' }] }))
    const r = await resolverContextoCurricularGrupo(sb, 'grupo-4b')
    verificar(!r.ok && r.error === 'GRADO_CURRICULAR_NO_ENCONTRADO', '3. grado sin catálogo curricular → GRADO_CURRICULAR_NO_ENCONTRADO')
  }

  // --- 4. fase ausente → FASE_NO_ENCONTRADA ---
  {
    const sb = clienteFalso(fixtureBase({ curriculo_fase_grado: [] }))
    const r = await resolverContextoCurricularGrupo(sb, 'grupo-4b')
    verificar(!r.ok && r.error === 'FASE_NO_ENCONTRADA', '4. sin curriculo_fase_grado → FASE_NO_ENCONTRADA')
  }

  // --- 5. fase ambigua (política pura) ---
  {
    const candidatas: FaseVersionCandidata[] = [
      { faseId: 'f1', faseClave: 'fase_3', versionId: 'v1', versionEstado: 'vigente' },
      { faseId: 'f2', faseClave: 'fase_4', versionId: 'v2', versionEstado: 'vigente' },
    ]
    const r = elegirFaseYVersion(candidatas)
    verificar(!r.ok && r.error === 'FASE_AMBIGUA', '5. dos claves de fase distintas para el mismo grado → FASE_AMBIGUA')
  }

  // --- 6. exactamente una vigente → se usa vigente (política pura) ---
  {
    const r = elegirVersion([{ id: 'v1', estado: 'vigente' }])
    verificar(r.ok && r.versionId === 'v1' && r.fallbackBorrador === false, '6. una única vigente se usa sin fallback')
  }

  // --- 7. ninguna vigente + exactamente un borrador compatible → fallback transitorio ---
  {
    const r = elegirVersion([{ id: 'v1', estado: 'borrador' }])
    verificar(r.ok && r.versionId === 'v1' && r.fallbackBorrador === true, '7. sin vigente, un único borrador se permite con fallbackBorrador=true')
  }

  // --- 8. dos borradores compatibles → VERSION_CURRICULAR_AMBIGUA ---
  {
    const r = elegirVersion([{ id: 'v1', estado: 'borrador' }, { id: 'v2', estado: 'borrador' }])
    verificar(!r.ok && r.error === 'VERSION_CURRICULAR_AMBIGUA', '8. dos borradores sin vigente → VERSION_CURRICULAR_AMBIGUA')
  }

  // --- 9. histórico nunca se selecciona ---
  {
    const r = elegirVersion([{ id: 'v1', estado: 'historico' }])
    verificar(!r.ok && r.error === 'VERSION_CURRICULAR_NO_RESUELTA', '9a. solo histórico disponible → VERSION_CURRICULAR_NO_RESUELTA, nunca se usa')
    const r2 = elegirVersion([{ id: 'v1', estado: 'historico' }, { id: 'v2', estado: 'borrador' }])
    verificar(r2.ok && r2.versionId === 'v2', '9b. histórico se ignora aunque haya un borrador compatible junto a él')
  }

  // --- 10. cobertura incompleta → COBERTURA_INCOMPLETA ---
  {
    const sb = clienteFalso(fixtureBase({ curriculo_cobertura: coberturaCompletaPara(VERSION_ID, FASE_ID, GRADO_ID).slice(0, 3) }))
    const r = await resolverContextoCurricularGrupo(sb, 'grupo-4b')
    verificar(!r.ok && r.error === 'COBERTURA_INCOMPLETA', '10. cobertura 3/4 → COBERTURA_INCOMPLETA')
  }

  // --- 11. cobertura completa → devuelve todos los campos cubiertos ---
  {
    const camposCubiertos: CampoConCobertura[] = CAMPOS.map(({ id, clave, nombre }) => ({ id, clave, nombre }))
    const r = evaluarCobertura(4, camposCubiertos)
    verificar(r.ok === true, '11a. evaluarCobertura pura: 4/4 → ok')
    const sb = clienteFalso(fixtureBase())
    const real = await resolverContextoCurricularGrupo(sb, 'grupo-4b')
    verificar(real.ok && real.contexto.camposConCobertura.length === 4, '11b. resolver real devuelve los 4 campos cuando la cobertura es completa')
  }

  // --- refuerzo: grupo ajeno/inexistente (RLS ya lo filtra antes de
  //     llegar aquí) → GRUPO_NO_ENCONTRADO, nunca un error distinto que
  //     revele si el grupo existe. ---
  {
    const sb = clienteFalso(fixtureBase())
    const r = await resolverContextoCurricularGrupo(sb, 'grupo-de-otro-docente')
    verificar(!r.ok && r.error === 'GRUPO_NO_ENCONTRADO', 'extra. grupo_id no visible (ajeno o inexistente) → GRUPO_NO_ENCONTRADO')
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
