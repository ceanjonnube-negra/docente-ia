// lib/curriculo/resolverContextoCurricularGrupo.ts
//
// Primer resolver curricular runtime real — PA-2C ("Programa Analítico
// — reparación del contexto + resolver curricular runtime"). Resuelve,
// con 0 IA / 0 embeddings / 0 fuzzy matching, la cadena:
//
//   grupo → nivel/grado → curriculo_grado → curriculo_fase →
//   curriculo_version → cobertura → campos disponibles
//
// Fail-closed en cada paso: nunca hay un resultado parcial válido. No
// carga contenidos ni PDA (ver PA-2B §10/§I) — eso queda para una
// función específica posterior, por campo, bajo demanda.
//
// Recibe un SupabaseClient YA autenticado con la sesión real del
// docente (mismo patrón que lib/server/authApi.ts) — nunca
// service_role. RLS de `grupos` ("docente_id = auth.uid()") es la
// única barrera real: si se pasa el grupo_id de otro docente, la
// consulta a `grupos` no devuelve fila y el resultado es
// GRUPO_NO_ENCONTRADO, sin filtrar si el grupo ajeno existe o no.

import type { SupabaseClient } from '@supabase/supabase-js'

export type ErrorContextoCurricular =
  | 'GRUPO_NO_ENCONTRADO'
  | 'GRUPO_SIN_GRADO'
  | 'GRUPO_SIN_NIVEL'
  | 'GRADO_CURRICULAR_NO_ENCONTRADO'
  | 'FASE_NO_ENCONTRADA'
  | 'FASE_AMBIGUA'
  | 'VERSION_CURRICULAR_NO_RESUELTA'
  | 'VERSION_CURRICULAR_AMBIGUA'
  | 'COBERTURA_INCOMPLETA'

export type CampoConCobertura = { id: string; clave: string; nombre: string }

export type ContextoCurricularGrupo = {
  grupoId: string
  cicloEscolarId: string
  nivelEducativo: string
  gradoGrupo: string
  curriculoGradoId: string
  curriculoFaseId: string
  curriculoFaseClave: string
  curriculoVersionId: string
  // Solo para observabilidad interna — nunca se usa como criterio en
  // ningún otro módulo. true cuando no había ninguna versión
  // 'vigente' compatible y se usó la única 'borrador' compatible (ver
  // elegirVersion más abajo).
  fallbackBorrador: boolean
  camposConCobertura: CampoConCobertura[]
}

export type ResultadoResolverContexto =
  | { ok: true; contexto: ContextoCurricularGrupo }
  | { ok: false; error: ErrorContextoCurricular }

// ============================================================
// Funciones puras de política — sin I/O, testeables con arrays
// construidos a mano (ver scripts/verificar-resolver-contexto-
// curricular.ts).
// ============================================================

export type FaseVersionCandidata = {
  faseId: string
  faseClave: string
  versionId: string
  versionEstado: 'borrador' | 'vigente' | 'historico'
}

type ResultadoVersion =
  | { ok: true; versionId: string; fallbackBorrador: boolean }
  | { ok: false; error: 'VERSION_CURRICULAR_NO_RESUELTA' | 'VERSION_CURRICULAR_AMBIGUA' }

// Único punto del proyecto donde vive esta política — no dispersar.
//
// Regla (PA-2B §G / PA-2C §8, aprobada como transitoria):
// 1. preferir 'vigente'; si hay exactamente una, usarla.
// 2. si hay 2+ 'vigente', VERSION_CURRICULAR_AMBIGUA.
// 3. si no hay ninguna 'vigente', permitir EXCLUSIVAMENTE una única
//    'borrador' compatible como fallback transitorio — esto debe
//    desaparecer (quedando solo el paso 1) el día que exista una
//    operación administrativa real de promoción a 'vigente'.
// 4. si hay 2+ 'borrador' sin ninguna 'vigente', VERSION_CURRICULAR_AMBIGUA.
// 5. si no hay ninguna candidata, VERSION_CURRICULAR_NO_RESUELTA.
// 6. 'historico' nunca se considera (el llamador ya lo filtra, pero
//    esta función lo refuerza por si acaso).
export function elegirVersion(candidatas: { id: string; estado: 'borrador' | 'vigente' | 'historico' }[]): ResultadoVersion {
  const vigentes = candidatas.filter((v) => v.estado === 'vigente')
  if (vigentes.length === 1) return { ok: true, versionId: vigentes[0].id, fallbackBorrador: false }
  if (vigentes.length > 1) return { ok: false, error: 'VERSION_CURRICULAR_AMBIGUA' }

  const borradores = candidatas.filter((v) => v.estado === 'borrador')
  if (borradores.length === 1) return { ok: true, versionId: borradores[0].id, fallbackBorrador: true }
  if (borradores.length > 1) return { ok: false, error: 'VERSION_CURRICULAR_AMBIGUA' }

  return { ok: false, error: 'VERSION_CURRICULAR_NO_RESUELTA' }
}

type ResultadoFaseVersion =
  | { ok: true; faseId: string; faseClave: string; versionId: string; fallbackBorrador: boolean }
  | { ok: false; error: 'FASE_NO_ENCONTRADA' | 'FASE_AMBIGUA' | 'VERSION_CURRICULAR_NO_RESUELTA' | 'VERSION_CURRICULAR_AMBIGUA' }

// Resuelve fase (existencia/consistencia) y versión (política de
// elegirVersion) sobre el mismo conjunto de candidatas: un
// curriculo_grado puede estar conectado, vía curriculo_fase_grado, a
// una fila de curriculo_fase por cada curriculo_version que exista
// (cada versión trae su propio árbol de fases) — nunca se asume que
// solo existe una versión.
export function elegirFaseYVersion(candidatas: FaseVersionCandidata[]): ResultadoFaseVersion {
  if (candidatas.length === 0) return { ok: false, error: 'FASE_NO_ENCONTRADA' }

  const clavesDistintas = new Set(candidatas.map((c) => c.faseClave))
  if (clavesDistintas.size > 1) return { ok: false, error: 'FASE_AMBIGUA' }

  // 'historico' nunca se selecciona, ni ambiguo por su presencia.
  const utilizables = candidatas.filter((c) => c.versionEstado !== 'historico')
  const resultadoVersion = elegirVersion(utilizables.map((c) => ({ id: c.versionId, estado: c.versionEstado })))
  if (!resultadoVersion.ok) return resultadoVersion

  const elegida = candidatas.find((c) => c.versionId === resultadoVersion.versionId)!
  return {
    ok: true,
    faseId: elegida.faseId,
    faseClave: elegida.faseClave,
    versionId: elegida.versionId,
    fallbackBorrador: resultadoVersion.fallbackBorrador,
  }
}

// Cobertura fail-closed: una versión candidata solo es utilizable si
// TODOS sus campos formativos tienen cobertura para esa fase/grado —
// nunca se devuelve un subconjunto como si fuera el currículo completo.
export function evaluarCobertura(
  totalCampos: number,
  camposCubiertos: CampoConCobertura[]
): { ok: true } | { ok: false; error: 'COBERTURA_INCOMPLETA' } {
  if (totalCampos === 0 || camposCubiertos.length < totalCampos) return { ok: false, error: 'COBERTURA_INCOMPLETA' }
  return { ok: true }
}

// ============================================================
// Orquestador real (I/O contra Supabase, respeta RLS).
// ============================================================

export async function resolverContextoCurricularGrupo(
  sb: SupabaseClient,
  grupoId: string
): Promise<ResultadoResolverContexto> {
  const { data: grupo } = await sb
    .from('grupos')
    .select('id, ciclo_escolar_id, nivel_educativo, grado')
    .eq('id', grupoId)
    .maybeSingle()

  if (!grupo) return { ok: false, error: 'GRUPO_NO_ENCONTRADO' }
  if (!grupo.grado) return { ok: false, error: 'GRUPO_SIN_GRADO' }
  if (!grupo.nivel_educativo) return { ok: false, error: 'GRUPO_SIN_NIVEL' }

  const { data: curriculoGrado } = await sb
    .from('curriculo_grado')
    .select('id')
    .eq('nivel_educativo', grupo.nivel_educativo)
    .eq('clave', grupo.grado)
    .maybeSingle()

  if (!curriculoGrado) return { ok: false, error: 'GRADO_CURRICULAR_NO_ENCONTRADO' }

  const { data: fasesGrado } = await sb
    .from('curriculo_fase_grado')
    .select('curriculo_fase_id')
    .eq('curriculo_grado_id', curriculoGrado.id)

  const faseIds = [...new Set((fasesGrado ?? []).map((fg) => fg.curriculo_fase_id as string))]
  if (faseIds.length === 0) return { ok: false, error: 'FASE_NO_ENCONTRADA' }

  const { data: fases } = await sb
    .from('curriculo_fase')
    .select('id, clave, curriculo_version_id')
    .in('id', faseIds)

  const versionIds = [...new Set((fases ?? []).map((f) => f.curriculo_version_id as string))]
  const { data: versiones } = await sb.from('curriculo_version').select('id, estado').in('id', versionIds)
  const estadoPorVersion = new Map((versiones ?? []).map((v) => [v.id as string, v.estado as 'borrador' | 'vigente' | 'historico']))

  const candidatas: FaseVersionCandidata[] = (fases ?? []).map((f) => ({
    faseId: f.id as string,
    faseClave: f.clave as string,
    versionId: f.curriculo_version_id as string,
    versionEstado: estadoPorVersion.get(f.curriculo_version_id as string) ?? 'historico',
  }))

  const resultadoFaseVersion = elegirFaseYVersion(candidatas)
  if (!resultadoFaseVersion.ok) return { ok: false, error: resultadoFaseVersion.error }

  const { faseId, faseClave, versionId, fallbackBorrador } = resultadoFaseVersion

  const { data: campos } = await sb
    .from('curriculo_campo_formativo')
    .select('id, clave, nombre')
    .eq('curriculo_version_id', versionId)

  const { data: cobertura } = await sb
    .from('curriculo_cobertura')
    .select('campo_formativo_id')
    .eq('curriculo_version_id', versionId)
    .eq('fase_id', faseId)
    .eq('grado_id', curriculoGrado.id)

  const idsCubiertos = new Set((cobertura ?? []).map((c) => c.campo_formativo_id as string))
  const camposConCobertura: CampoConCobertura[] = (campos ?? [])
    .filter((c) => idsCubiertos.has(c.id as string))
    .map((c) => ({ id: c.id as string, clave: c.clave as string, nombre: c.nombre as string }))

  const resultadoCobertura = evaluarCobertura((campos ?? []).length, camposConCobertura)
  if (!resultadoCobertura.ok) return { ok: false, error: resultadoCobertura.error }

  return {
    ok: true,
    contexto: {
      grupoId: grupo.id as string,
      cicloEscolarId: grupo.ciclo_escolar_id as string,
      nivelEducativo: grupo.nivel_educativo as string,
      gradoGrupo: grupo.grado as string,
      curriculoGradoId: curriculoGrado.id as string,
      curriculoFaseId: faseId,
      curriculoFaseClave: faseClave,
      curriculoVersionId: versionId,
      fallbackBorrador,
      camposConCobertura,
    },
  }
}
