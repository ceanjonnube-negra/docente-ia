// Hito 2, etapa 3b — aprobar un borrador de AJUSTE como versión N+1.
// Sin red ni IA: Supabase en memoria y la RPC publicar_version_planeacion
// simulada con sus reglas (su lógica transaccional se validó en
// PostgreSQL local con la migración 20261127000000).
//   npx tsx scripts/verificar-aprobar-ajuste.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { aprobarAjusteSiCorresponde, cicloDelAjuste } from '../lib/planeacion/aprobarAjuste'
import { aprobarBorradorPlaneacion } from '../lib/planeacion/aprobarBorrador'
import { ETIQUETA_AJUSTE, ajustesDe, construirBorradorAjustado, continuarAjuste, detalleIndicadores, huellaBorrador, seccionesDe, type AjusteRegistrado, type BaseAjuste } from '../lib/planeacion/modificarPlaneacion'
import type { SesionContexto } from '../lib/sesionContexto'
import type { Planeacion } from '../lib/planeacion/tipos'

let fallos = 0
function verificar(condicion: boolean, nombre: string) {
  if (condicion) console.log(`✓ ${nombre}`)
  else { fallos++; console.log(`✗ ${nombre}`) }
}

type Fila = Record<string, unknown>
const DOCENTE = '11111111-1111-4111-8111-111111111111'
const GRUPO = '22222222-2222-4222-8222-222222222222'
const OTRO_GRUPO = '33333333-3333-4333-8333-333333333333'
const CONV = '44444444-4444-4444-8444-444444444444'
const PL = '55555555-5555-4555-8555-555555555555'

const CURRICULAR = '📌 CONTENIDOS Y PDA DE ESTA PLANEACIÓN\nContenido (Catálogo curricular de la app — pendiente de validación oficial):\n- Comprensión y producción de cuentos.\nPDA de referencia:\n- Escribe cuentos con secuencia causal.'
const BASE_TEXTO = [
  '📋 PLANEACIÓN DIDÁCTICA\nFase: Fase 4\nCampo Formativo: Lenguajes\nProyecto Didáctico: Cuentos propios\nDuración: 3 días',
  '🎯 PROPÓSITO GENERAL\nQue el grupo escriba cuentos propios.',
  CURRICULAR,
  '🧰 MATERIALES\n- Hojas\n- Colores',
  '📅 DÍA 1 — Leemos cuentos\n🔹 Inicio (15 min)\nLectura en voz alta.\n📌 Evaluación: participación oral.',
  '📅 DÍA 2 — Planeamos\n🔹 Inicio (15 min)\nLluvia de ideas.\n📌 Evaluación: plan escrito.',
  '📅 DÍA 3 — Escribimos\n🔹 Inicio (15 min)\nEscritura del borrador.\n📌 Evaluación: borrador completo.',
  '🎓 PRODUCTO FINAL\nCuento ilustrado.',
].join('\n\n')
const INDICADORES = 'Identifica partes del cuento; Escribe con secuencia'
const RESUMEN = (c: Record<string, string> = {}) => ['📎 RESUMEN PARA GUARDAR', 'Nombre: Cuentos propios', 'Fecha de inicio: 2026-11-24', 'Fecha de fin: 2026-11-26', 'Duración: 3 días',
  'Propósito: Que el grupo escriba cuentos propios.', 'Campos formativos: Lenguajes', 'Contenidos: Comprensión y producción de cuentos.', 'PDA: Escribe cuentos con secuencia causal.',
  'Ejes articuladores: Apropiación de las culturas', 'Metodología: Proyectos', 'Producto final: Cuento ilustrado.', 'Secuencia didáctica: Día 1: Leemos; Día 2: Planeamos; Día 3: Escribimos',
  'Recursos: Hojas; Colores', 'Evidencias: Plan; Borrador', `Indicadores de evaluación: ${c.Indicadores ?? INDICADORES}`].join('\n')
const ESTRUCTURA = {
  planeacion: { nombre: 'Cuentos propios', proposito: 'Que el grupo escriba cuentos propios.', fecha_inicio: '2026-11-24', fecha_fin: '2026-11-26', campo_formativo: 'Lenguajes' },
  proyecto: { nombre: 'Cuentos propios', campos_formativos: ['Lenguajes'], contenidos: ['Comprensión y producción de cuentos.'], pda: ['Escribe cuentos con secuencia causal.'], ejes_articuladores: ['Apropiación de las culturas'],
    metodologia: 'Proyectos', duracion_dias: 3, actividades: [{ dia: 1, resumen: 'Leemos' }, { dia: 2, resumen: 'Planeamos' }, { dia: 3, resumen: 'Escribimos' }], recursos: ['Hojas', 'Colores'],
    indicadores: ['Identifica partes del cuento', 'Escribe con secuencia'], producto_final: 'Cuento ilustrado.', evidencias: ['Plan', 'Borrador'] },
}
const TRAZABILIDAD = { esquema: 'planeacion-curricular-v1', origen: 'base' }
const PLANEACION = { id: PL, nombre: 'Cuentos propios', version: 3, grupo_id: GRUPO, fecha_inicio: '2026-11-24', fecha_fin: '2026-11-26' } as Planeacion
const BASE: BaseAjuste = { planeacion: PLANEACION, numero: 3, contenido: BASE_TEXTO, estructura: ESTRUCTURA, trazabilidad: TRAZABILIDAD }

type Escenario = { evaluacion?: 'sin_hoja' | 'libre' | 'protegida' }
// Base de datos en memoria + RPC simulada con las reglas de publicar_version_planeacion.
function crearBD(e: Escenario = {}) {
  const t: Record<string, Fila[]> = {
    conversaciones_chat: [{ id: CONV, docente_id: DOCENTE, planeacion_activa: { esquema: 'referencia-planeacion-v1', planeacionId: PL, numero: 3, opciones: [] } }],
    planeaciones: [{ id: PL, docente_id: DOCENTE, grupo_id: GRUPO, nombre: 'Cuentos propios', version: 3, fecha_inicio: '2026-11-24', fecha_fin: '2026-11-26' }],
    planeacion_versiones: [1, 2, 3].map((n) => ({ id: `v${n}`, planeacion_id: PL, docente_id: DOCENTE, grupo_id: GRUPO, numero: n, borrador_clave: `msg:${CONV}:m${n}`, contenido: n === 3 ? BASE_TEXTO : `texto v${n}`, estructura: ESTRUCTURA, trazabilidad_curricular: TRAZABILIDAD, hoja_id: 'h1' })),
    mensajes_chat: [],
    hojas_evaluacion: e.evaluacion === 'sin_hoja' ? [] : [{ id: 'h1', proyecto_id: 'ps-1', identificador_visible: 'SG-VJA2', indicadores: ESTRUCTURA.proyecto.indicadores.map((x, i) => ({ numero_indicador: i + 1, indicador_especifico: x, aspecto_general: 'logro_aprendizaje' })), reemplazada_por: null, storage_path: 'docente/SG-VJA2.pdf' }],
  }
  const llamadasRpc: Record<string, unknown>[] = []
  const escrituras: string[] = []
  let rpcVeVersion: number | null = null // para simular una carrera (la RPC ve otra versión vigente)
  const sb = {
    storage: { from: () => ({ createSignedUrl: async (ruta: string, _s: number, o?: { download?: string }) => ({ data: { signedUrl: `https://firmada/${ruta}${o?.download ? '?descarga' : ''}` }, error: null }) }) },
    rpc: async (nombre: string, a: Record<string, unknown>) => {
      llamadasRpc.push({ nombre, ...a })
      if (nombre !== 'publicar_version_planeacion') return { data: null, error: { message: 'rpc desconocida' } }
      const pl = t.planeaciones.find((p) => p.id === a.p_planeacion_id && p.docente_id === DOCENTE)
      if (!pl) return { data: { estado: 'no_encontrada' }, error: null }
      const existente = t.planeacion_versiones.find((v) => v.docente_id === DOCENTE && v.borrador_clave === a.p_borrador_clave)
      if (existente) return { data: existente.planeacion_id === pl.id ? { estado: 'ya_publicada', numero: existente.numero, version_id: existente.id, hoja: { estado: 'ya_publicada', id: existente.hoja_id } } : { estado: 'conflicto', numero: pl.version }, error: null }
      const vigente = rpcVeVersion ?? (pl.version as number)
      if (vigente !== a.p_version_base) return { data: { estado: 'conflicto', numero: vigente }, error: null }
      let hoja: { estado: string; id: string | null; anterior_id?: string } = { estado: 'sin_hoja', id: null }
      const actual = t.hojas_evaluacion.find((h) => h.reemplazada_por === null)
      if (actual) {
        const nuevos = (a.p_indicadores_hoja as { indicador_especifico: string }[]).map((x) => x.indicador_especifico.toLowerCase()).join('|')
        const previos = (actual.indicadores as { indicador_especifico: string }[]).map((x) => x.indicador_especifico.toLowerCase()).join('|')
        if (nuevos === previos) hoja = { estado: 'conservada', id: actual.id as string }
        else if (e.evaluacion === 'protegida') hoja = { estado: 'evaluacion_protegida', id: actual.id as string }
        else {
          actual.reemplazada_por = 'h2'
          t.hojas_evaluacion.push({ id: 'h2', proyecto_id: 'ps-1', identificador_visible: a.p_identificador_hoja, indicadores: a.p_indicadores_hoja, reemplazada_por: null })
          hoja = { estado: 'reemplazada', id: 'h2', anterior_id: actual.id as string }
        }
      }
      const numero = (a.p_version_base as number) + 1
      t.planeacion_versiones.push({ id: `v${numero}`, planeacion_id: pl.id, docente_id: DOCENTE, grupo_id: pl.grupo_id, numero, borrador_clave: a.p_borrador_clave, contenido: a.p_contenido, estructura: a.p_estructura, trazabilidad_curricular: a.p_trazabilidad, hoja_id: hoja.id, documento_word_archivo_id: a.p_documento_word ?? null, documento_pdf_archivo_id: a.p_documento_pdf ?? null })
      pl.version = numero
      return { data: { estado: 'publicada', numero, version_id: `v${numero}`, hoja }, error: null }
    },
    from: (tabla: string) => {
      const filtros: ((f: Fila) => boolean)[] = []
      let cambios: Fila | null = null
      let limite: number | null = null
      const filas = () => (t[tabla] ?? []).filter((f) => filtros.every((g) => g(f)))
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { filtros.push((f) => f[c] === v); return q },
        is: (c: string, v: unknown) => { filtros.push((f) => (v === null ? f[c] == null : f[c] === v)); return q },
        order: () => q,
        limit: (n: number) => { limite = n; return q },
        update: (d: Fila) => { cambios = d; return q },
        insert: (d: Fila) => { escrituras.push(`${tabla}:insert`); (t[tabla] ??= []).push(d); return q },
        maybeSingle: () => Promise.resolve({ data: filas()[0] ? JSON.parse(JSON.stringify(filas()[0])) : null, error: null }),
        single: () => Promise.resolve({ data: filas()[0] ?? {}, error: null }),
        then: (ok: (r: unknown) => unknown) => {
          const afectadas = filas()
          if (cambios) { escrituras.push(`${tabla}:update`); afectadas.forEach((f) => Object.assign(f, JSON.parse(JSON.stringify(cambios)))) }
          return Promise.resolve({ data: limite ? afectadas.slice(0, limite) : afectadas, error: null }).then(ok)
        },
      }
      return q
    },
  } as unknown as SupabaseClient
  return { sb, t, llamadasRpc, escrituras, carrera: (v: number) => { rpcVeVersion = v } }
}

// Generador idempotente simulado: completa el PDF de la hoja vigente sin PDF (nunca crea otra).
const generador = (bd: ReturnType<typeof crearBD>, llamadas: string[], falla = false) => async (ps: string) => {
  llamadas.push(ps)
  if (falla) return false
  const vigente = bd.t.hojas_evaluacion.find((h) => h.proyecto_id === ps && h.reemplazada_por === null)
  if (vigente && !vigente.storage_path) vigente.storage_path = `docente/${vigente.identificador_visible}.pdf`
  return !!vigente
}

const SESION = { docente_id: DOCENTE, grupo_activo_id: GRUPO, ciclo_escolar_id: null, grupo_activo_datos: { grado: '4', grupo: 'A' } } as unknown as SesionContexto

// Borrador de ajuste (v3 → Día 2) tal como lo deja la 3a; registrado y persistido.
function borradorAjuste(modelo = `${BASE_TEXTO.replace('Lluvia de ideas.', 'Lluvia de ideas con tarjetas.')}\n\n${RESUMEN()}`, instruccion = 'Cámbiale la sesión 2') {
  return construirBorradorAjustado({ textoModelo: modelo, base: BASE, instruccion })!.textoFinal
}
function registrar(bd: ReturnType<typeof crearBD>, texto: string, opciones: { grupoId?: string; versionBase?: number; persistir?: boolean; id?: string } = {}) {
  const ref = bd.t.conversaciones_chat[0].planeacion_activa as { ajustes?: unknown[] }
  ref.ajustes = [...(ref.ajustes ?? []), { planeacionId: PL, versionBase: opciones.versionBase ?? 3, grupoId: opciones.grupoId ?? GRUPO, huella: huellaBorrador(texto), creadoEn: '2026-11-25T10:00:00Z' }]
  if (opciones.persistir !== false) bd.t.mensajes_chat.push({ id: `${CONV}:${opciones.id ?? 'm9'}`, conversacion_id: CONV, rol: 'asistente', texto })
}
const historialCon = (texto: string) => [{ role: 'user', content: 'Cámbiale la sesión 2' }, { role: 'assistant', content: texto }]
const aprobar = (bd: ReturnType<typeof crearBD>, texto: string, completar?: (ps: string) => Promise<boolean>, sesion = SESION) =>
  aprobarAjusteSiCorresponde(bd.sb, sesion, historialCon(texto), 'Apruébala', CONV, completar ?? (async () => true))

async function main() {
  // 1. Publicación N+1 sobre la misma planeación, conservando las versiones anteriores.
  {
    const bd = crearBD()
    const anteriores = JSON.stringify(bd.t.planeacion_versiones)
    const texto = borradorAjuste()
    registrar(bd, texto)
    const r = await aprobar(bd, texto)
    const v4 = bd.t.planeacion_versiones.find((v) => v.numero === 4)!
    verificar(r?.codigo === 'VERSION_PUBLICADA' && r.numero === 4 && bd.t.planeaciones.length === 1 && bd.t.planeaciones[0].version === 4 && v4.planeacion_id === PL,
      '1a. Se publica como versión 4 de la MISMA planeación (no se crea otra)')
    verificar(JSON.stringify(bd.t.planeacion_versiones.slice(0, 3)) === anteriores, '1b. Las versiones 1–3 quedan intactas')
    const contenido = String(v4.contenido)
    verificar(contenido.includes('Lluvia de ideas con tarjetas.') && !contenido.includes('📎 RESUMEN') && !contenido.includes(ETIQUETA_AJUSTE) && !contenido.includes('¿Quieres corregir'),
      '1c. Texto canónico de la versión: el documento ajustado, sin resumen, línea de ajuste ni pregunta')
    const est = v4.estructura as typeof ESTRUCTURA
    verificar(JSON.stringify(est.proyecto.contenidos) === JSON.stringify(ESTRUCTURA.proyecto.contenidos) && JSON.stringify(est.proyecto.pda) === JSON.stringify(ESTRUCTURA.proyecto.pda) && JSON.stringify(v4.trazabilidad_curricular) === JSON.stringify(TRAZABILIDAD),
      '1d. Contenidos, PDA y trazabilidad curricular de la base se conservan (sin recalcular la selección)')
    verificar(bd.llamadasRpc.length === 1 && bd.llamadasRpc[0].p_version_base === 3 && bd.llamadasRpc[0].p_borrador_clave === `msg:${CONV}:m9` && bd.llamadasRpc[0].p_documento_word === null && bd.llamadasRpc[0].p_documento_pdf === null
      && !bd.escrituras.some((w) => w.startsWith('archivos_generados') || w.startsWith('documentos_generados')),
      '1e. Una sola publicación, clave = mensaje persistido; sin Word ni PDF de la planeación (etapa 4)')
    const ref = bd.t.conversaciones_chat[0].planeacion_activa as { numero: number; ajustes: unknown[] }
    verificar(ref.numero === 4 && ref.ajustes.length === 1 && !!r?.mensaje.includes('versión 4') && r.mensaje.includes('se conservan'), '1f. La conversación queda referida a la versión 4 (los ajustes se conservan) y el mensaje lo confirma')

    // 2. Reintento idempotente: la misma versión, sin otra publicación.
    const r2 = await aprobar(bd, texto)
    verificar(r2?.codigo === 'VERSION_YA_PUBLICADA' && r2.numero === 4 && bd.llamadasRpc.length === 1 && bd.t.planeacion_versiones.length === 4 && r2.mensaje === 'Este ajuste ya está guardado como la versión 4 de «Cuentos propios».',
      '2a. Reintento: recupera exactamente la versión 4, sin publicar de nuevo ni reportar conflicto')
  }
  {
    // 2b. Reintento cuya respuesta se perdió en plena carrera: la RPC lo resuelve (ya_publicada).
    const bd = crearBD()
    const texto = borradorAjuste()
    registrar(bd, texto)
    bd.t.planeacion_versiones.push({ id: 'v4', planeacion_id: PL, docente_id: DOCENTE, numero: 4, borrador_clave: 'msg:otra' })
    const original = bd.t.planeacion_versiones.find((v) => v.numero === 4)!
    original.borrador_clave = `msg:${CONV}:m9`
    bd.t.planeaciones[0].version = 4
    const r = await aprobar(bd, texto)
    verificar(r?.codigo === 'VERSION_YA_PUBLICADA' && r.numero === 4 && bd.llamadasRpc.length === 0, '2b. Ya publicada aunque la vigente avanzó: se reconoce por su clave, nunca como conflicto')
  }

  // 3. Conflicto: la versión base dejó de ser la vigente.
  {
    const bd = crearBD()
    const texto = borradorAjuste()
    registrar(bd, texto)
    bd.t.planeaciones[0].version = 4
    bd.t.planeacion_versiones.push({ id: 'v4', planeacion_id: PL, docente_id: DOCENTE, numero: 4, borrador_clave: 'msg:otro-ajuste', contenido: 'v4 de otro ajuste' })
    const r = await aprobar(bd, texto)
    verificar(r?.codigo === 'CONFLICTO_VERSION' && bd.llamadasRpc.length === 0 && bd.t.planeacion_versiones.length === 4 && !!r.mensaje.includes('versión vigente es la 4') && r.mensaje.includes('No sobrescribo'),
      '3a. Base 3 pero vigente 4: conflicto explicado, sin publicar ni sobrescribir')
    const bd2 = crearBD()
    registrar(bd2, texto)
    bd2.carrera(4)
    const r2 = await aprobar(bd2, texto)
    verificar(r2?.codigo === 'CONFLICTO_VERSION' && bd2.llamadasRpc.length === 1 && bd2.t.planeacion_versiones.length === 3 && bd2.t.planeaciones[0].version === 3,
      '3b. Carrera (otra versión se publica entre la verificación y la RPC): la RPC responde conflicto y nada cambia')
  }

  // 4. Identidad inválida: nunca se publica.
  {
    const texto = borradorAjuste()
    const casos: [string, (bd: ReturnType<typeof crearBD>) => Promise<unknown>, string][] = [
      ['solo la línea del resumen (sin metadata)', async (bd) => { bd.t.mensajes_chat.push({ id: `${CONV}:m9`, conversacion_id: CONV, rol: 'asistente', texto }); return aprobar(bd, texto) }, 'AJUSTE_SIN_IDENTIDAD'],
      ['texto alterado (la huella no coincide)', async (bd) => { registrar(bd, texto); const alterado = texto.replace('con tarjetas', 'con otra cosa'); bd.t.mensajes_chat.push({ id: `${CONV}:m10`, conversacion_id: CONV, rol: 'asistente', texto: alterado }); return aprobar(bd, alterado) }, 'AJUSTE_SIN_IDENTIDAD'],
      ['metadata de otro grupo', async (bd) => { registrar(bd, texto, { grupoId: OTRO_GRUPO }); return aprobar(bd, texto) }, 'AJUSTE_OTRO_GRUPO'],
      ['grupo activo distinto del de la planeación', async (bd) => { registrar(bd, texto); return aprobar(bd, texto, undefined, { ...SESION, grupo_activo_id: OTRO_GRUPO } as SesionContexto) }, 'AJUSTE_OTRO_GRUPO'],
      ['planeación de otro docente', async (bd) => { registrar(bd, texto); bd.t.planeaciones[0].docente_id = 'otro'; return aprobar(bd, texto) }, 'AJUSTE_SIN_IDENTIDAD'],
      ['mensaje aún no persistido', async (bd) => { registrar(bd, texto, { persistir: false }); return aprobar(bd, texto) }, 'BORRADOR_NO_PERSISTIDO'],
    ]
    for (const [nombre, ejecutar, codigo] of casos) {
      const bd = crearBD()
      const r = await ejecutar(bd) as { codigo: string } | null
      verificar(r?.codigo === codigo && bd.llamadasRpc.length === 0 && bd.t.planeacion_versiones.length === 3, `4. ${nombre} → ${codigo}, sin publicar`)
    }
    // La primera aprobación sigue intacta: un borrador normal no pasa por aquí.
    const bd = crearBD()
    const normal = `${BASE_TEXTO}\n\n${RESUMEN()}\n\nYa preparé la planeación. ¿Deseas corregir algo o aprobarla para guardarla?`
    verificar(await aprobar(bd, normal) === null, '4b. Un borrador normal (sin línea ni metadata) sigue la primera aprobación')
    const linea = await aprobarBorradorPlaneacion(bd.sb, SESION, historialCon(texto), 'Apruébala', CONV)
    verificar(!linea.ok && linea.codigo === 'AJUSTE_PENDIENTE' && bd.llamadasRpc.length === 0, '4c. La primera aprobación sigue rechazando un borrador de ajuste (nunca lo crea como nuevo)')
  }

  // 5. Protección de la evaluación (reglas de la RPC) y aviso discreto.
  {
    const conIndicadores = borradorAjuste(`${BASE_TEXTO.replace('Evaluación: plan escrito.', 'Evaluación: rúbrica del plan.')}\n\n${RESUMEN({ Indicadores: 'Planea con rúbrica; Escribe con secuencia' })}`, 'ajusta la evaluación del día 2')
    const bdP = crearBD({ evaluacion: 'protegida' })
    registrar(bdP, conIndicadores)
    let completadas = 0
    const rP = await aprobar(bdP, conIndicadores, async () => { completadas++; return true })
    verificar(rP?.codigo === 'VERSION_PUBLICADA' && !!rP.mensaje.includes('se conserva con sus criterios originales') && bdP.t.hojas_evaluacion.length === 1 && bdP.t.hojas_evaluacion[0].reemplazada_por === null && completadas === 0,
      '5a. Evaluación con capturas: la versión se publica, la hoja y sus criterios no cambian, aviso discreto')
    const bdL = crearBD({ evaluacion: 'libre' })
    registrar(bdL, conIndicadores)
    const pedidos: string[] = []
    const rL = await aprobar(bdL, conIndicadores, generador(bdL, pedidos))
    const nueva = bdL.t.hojas_evaluacion.find((h) => h.id === 'h2')
    verificar(rL?.codigo === 'VERSION_PUBLICADA' && !!nueva && pedidos.join() === 'ps-1' && !!rL.mensaje.includes(String(nueva.identificador_visible)) && bdL.t.planeacion_versiones.find((v) => v.numero === 4)!.hoja_id === 'h2',
      '5b. Evaluación sin capturas e indicadores nuevos: hoja reemplazada, su PDF se completa y el aviso da el código nuevo')
    const bdC = crearBD()
    const texto = borradorAjuste()
    registrar(bdC, texto)
    const rC = await aprobar(bdC, texto)
    verificar(rC?.codigo === 'VERSION_PUBLICADA' && !rC.mensaje.includes('evaluación') && bdC.t.planeacion_versiones.find((v) => v.numero === 4)!.hoja_id === 'h1', '5c. Mismos indicadores: la hoja se conserva y no hay aviso')
  }

  // 6. Seguir corrigiendo: se conservan los cambios ya pedidos (referencia = último borrador confiable).
  {
    const bd = crearBD()
    const v1 = borradorAjuste(`${BASE_TEXTO.replace('Lluvia de ideas.', 'Lluvia de ideas con tarjetas.').replace('Evaluación: plan escrito.', 'Evaluación: rúbrica del plan.')}\n\n${RESUMEN({ Indicadores: 'Planea con rúbrica; Escribe con secuencia' })}`, 'cambia la sesión 2 y su evaluación')
    registrar(bd, v1, { persistir: false })
    // El modelo, al cambiar el día 3, revierte el día 2, la evaluación y los indicadores pedidos antes, y altera lo curricular.
    const modelo = `${BASE_TEXTO.replace('Escritura del borrador.', 'Escritura en parejas.').replace(CURRICULAR, CURRICULAR.replace('Comprensión y producción de cuentos.', 'Otro contenido'))}\n\n${RESUMEN()}`
    const v2 = (await continuarAjuste(bd.sb, CONV, v1, modelo, 'ahora cambia la sesión 3'))!
    const sec = seccionesDe(v2.slice(0, v2.indexOf('📎')))!
    const dia = (n: number) => sec.find((s) => s.clave === `dia:${n}`)!.texto
    verificar(dia(2).includes('Lluvia de ideas con tarjetas.') && dia(2).includes('rúbrica del plan') && dia(3).includes('Escritura en parejas.') && v2.includes(`Indicadores de evaluación: Planea con rúbrica; Escribe con secuencia`),
      '6a. El cambio nuevo (Día 3) se aplica y los ya pedidos (Día 2, su evaluación e indicadores) se conservan')
    verificar(sec.find((s) => s.clave === 'curricular')!.texto === CURRICULAR && v2.includes('Contenidos: Comprensión y producción de cuentos.'), '6b. Lo curricular no pedido se conserva')
    verificar(v2.includes('Cambios respecto a la versión 3: Día 2, Día 3') && v2.includes('Indicadores de evaluación'), '6c. El resumen de cambios es contra la versión base (acumulado), no contra el borrador anterior')
    const ref = bd.t.conversaciones_chat[0].planeacion_activa as { ajustes: { huella: string; planeacionId: string; versionBase: number; grupoId: string }[] }
    const heredada = ref.ajustes.find((a) => a.huella === huellaBorrador(v2))
    verificar(!!heredada && heredada.planeacionId === PL && heredada.versionBase === 3 && heredada.grupoId === GRUPO, '6d. El nuevo borrador hereda la identidad registrada')
    bd.t.mensajes_chat.push({ id: `${CONV}:m11`, conversacion_id: CONV, rol: 'asistente', texto: v2 })
    const r = await aprobarAjusteSiCorresponde(bd.sb, SESION, [{ role: 'assistant', content: v1 }, { role: 'user', content: 'ahora cambia la sesión 3' }, { role: 'assistant', content: v2 }], 'Apruébala', CONV, async () => true)
    const v4 = String(bd.t.planeacion_versiones.find((v) => v.numero === 4)?.contenido ?? '')
    verificar(r?.codigo === 'VERSION_PUBLICADA' && v4.includes('Lluvia de ideas con tarjetas.') && v4.includes('Escritura en parejas.'), '6e. Al aprobar, la versión 4 lleva los cambios acumulados')
    const sinMeta = await continuarAjuste(crearBD().sb, CONV, v1, modelo, 'ahora cambia la sesión 3')
    verificar(!!sinMeta && new RegExp(`^${ETIQUETA_AJUSTE}:`, 'm').test(sinMeta) && sinMeta.includes('Lluvia de ideas.'), '6f. Sin metadata del previo: solo se copia la línea (no publicable), sin afirmar conservación')
  }

  // 8. Tarjeta de la hoja de evaluación de la versión publicada (mismo protocolo; sin Word/PDF de la planeación).
  {
    const bd = crearBD()
    const texto = borradorAjuste()
    registrar(bd, texto)
    const r = await aprobar(bd, texto)
    verificar(r?.hoja?.identificadorVisible === 'SG-VJA2' && r.hoja.proyectoSeguimientoId === 'ps-1' && !r.hoja.reemplazada && r.hoja.url === 'https://firmada/docente/SG-VJA2.pdf?descarga' && r.hoja.urlVer === 'https://firmada/docente/SG-VJA2.pdf',
      '8a. Hoja conservada: se entrega la MISMA hoja, con captura habilitada (proyecto)')
  }
  const conIndicadores = borradorAjuste(`${BASE_TEXTO.replace('Evaluación: plan escrito.', 'Evaluación: rúbrica del plan.')}\n\n${RESUMEN({ Indicadores: 'Planea con rúbrica; Escribe con secuencia' })}`, 'ajusta la evaluación del día 2')
  {
    const bd = crearBD({ evaluacion: 'libre' })
    registrar(bd, conIndicadores)
    const r = await aprobar(bd, conIndicadores, generador(bd, []))
    const nueva = bd.t.hojas_evaluacion.find((h) => h.id === 'h2')!
    verificar(r?.hoja?.identificadorVisible === nueva.identificador_visible && r?.hoja?.proyectoSeguimientoId === 'ps-1' && !r?.hoja?.reemplazada, '8b. Hoja reemplazada: se entrega la NUEVA, con captura habilitada')
  }
  {
    const bd = crearBD({ evaluacion: 'libre' })
    registrar(bd, conIndicadores)
    const intentos: string[] = []
    const r1 = await aprobar(bd, conIndicadores, generador(bd, intentos, true))
    verificar(r1?.codigo === 'VERSION_PUBLICADA' && !r1.hoja && !!r1.mensaje.includes('se terminará de generar') && intentos.length === 1, '8c. PDF de la hoja nueva fallido: versión publicada, sin tarjeta, aviso de pendiente (sin reintento en la misma solicitud)')
    const r2 = await aprobar(bd, conIndicadores, generador(bd, intentos))
    verificar(r2?.codigo === 'VERSION_YA_PUBLICADA' && r2.hoja?.identificadorVisible === bd.t.hojas_evaluacion.find((h) => h.id === 'h2')!.identificador_visible && bd.t.hojas_evaluacion.length === 2 && bd.llamadasRpc.length === 1 && intentos.join() === 'ps-1,ps-1',
      '8d. Reintento: el generador idempotente completa la MISMA hoja pendiente y se entrega su tarjeta (sin duplicar hojas ni versiones)')
    const bdF = crearBD({ evaluacion: 'libre' })
    registrar(bdF, conIndicadores)
    await aprobar(bdF, conIndicadores, generador(bdF, [], true))
    const rF = await aprobar(bdF, conIndicadores, generador(bdF, [], true))
    verificar(rF?.codigo === 'VERSION_YA_PUBLICADA' && !rF.hoja && !!rF.mensaje.includes('todavía no tiene su PDF') && bdF.t.hojas_evaluacion.length === 2, '8e. Si sigue fallando: sin tarjeta y con indicación para recuperarla, sin crear hojas')
  }
  {
    // Reintento después de que una versión posterior reemplazó la hoja de la versión 4.
    const bd = crearBD()
    const texto = borradorAjuste()
    registrar(bd, texto)
    await aprobar(bd, texto)
    bd.t.hojas_evaluacion[0].reemplazada_por = 'h3'
    bd.t.hojas_evaluacion.push({ id: 'h3', proyecto_id: 'ps-1', identificador_visible: 'SG-NVA3', reemplazada_por: null, storage_path: 'docente/SG-NVA3.pdf' })
    bd.t.planeaciones[0].version = 5
    const intentos: string[] = []
    const r = await aprobar(bd, texto, generador(bd, intentos))
    verificar(r?.codigo === 'VERSION_YA_PUBLICADA' && r.numero === 4 && r.hoja?.identificadorVisible === 'SG-VJA2' && r.hoja.reemplazada === true && r.hoja.proyectoSeguimientoId === null && intentos.length === 0,
      '8f. Reintento con la hoja de esa versión ya sustituida: se entrega la hoja EXACTA de la versión 4, solo para consulta (sin captura)')
  }
  {
    const bd = crearBD({ evaluacion: 'sin_hoja' })
    const texto = borradorAjuste()
    registrar(bd, texto)
    const r = await aprobar(bd, texto)
    verificar(r?.codigo === 'VERSION_PUBLICADA' && r.hoja === null && !r.mensaje.includes('hoja'), '8g. Sin evaluación vinculada: sin tarjeta ni aviso')
    const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
    verificar(ruta.includes('if (aprobacionAjuste) return respuestaTexto(`${aprobacionAjuste.mensaje}${avisoHojaReemplazada(aprobacionAjuste.hoja)}${aprobacionAjuste.hoja ? `\\n${marcadorHoja(aprobacionAjuste.hoja)}` : \'\'}${await archivoPedidoConAjuste(aprobacionAjuste, ')
      && ruta.includes('if (hoja) marcadores.push(marcadorHoja(hoja))'), '8h. La ruta usa el mismo marcador de tarjeta (y aviso de hoja reemplazada) que la primera aprobación')
  }

  // 7. Ruta y módulo (estático): antes de la primera aprobación; sin IA; sin Word/PDF.
  {
    const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
    const modulo = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'aprobarAjuste.ts'), 'utf-8')
    verificar(ruta.indexOf('await aprobarAjusteSiCorresponde(') > 0 && ruta.indexOf('await aprobarAjusteSiCorresponde(') < ruta.indexOf('await aprobarBorradorPlaneacion('), '7a. La ruta resuelve el ajuste antes de la primera aprobación')
    verificar(!/anthropic|clasificarNivel0|ejecutarHerramientaDocumento|generarDocumento|documentGen\/herramientas/.test(modulo) && modulo.includes('publicarVersionPlaneacion('), '7b. Aprobación N+1: reutiliza publicarVersionPlaneacion; sin IA ni Word/PDF de la planeación')
  }

  // 9. Ciclo de vida: pendiente → publicado (conserva identidad) / obsoleto.
  {
    const bd = crearBD()
    const texto = borradorAjuste()
    registrar(bd, texto)
    const ajuste = () => ajustesDe(bd.t.conversaciones_chat[0].planeacion_activa)[0]
    verificar((await cicloDelAjuste(bd.sb, DOCENTE, ajuste())).estado === 'pendiente' && !ajuste().publicadoComo, '9a. Antes de aprobar: ajuste pendiente sobre la versión vigente (3)')
    const r = await aprobar(bd, texto)
    verificar(r?.codigo === 'VERSION_PUBLICADA' && ajuste().publicadoComo === 4 && ajuste().huella === huellaBorrador(texto) && ajuste().versionBase === 3,
      '9b. Al publicar, el borrador queda marcado publicadoComo=4 y conserva su identidad (huella y base)')
    const ciclo = await cicloDelAjuste(bd.sb, DOCENTE, ajuste())
    verificar(ciclo.estado === 'publicado' && ciclo.numero === 4 && ciclo.vigente === 4, '9c. Después: publicado como versión 4 (ya no es un ajuste pendiente)')
    const rpcAntes = bd.llamadasRpc.length
    const r2 = await aprobar(bd, texto)
    verificar(r2?.codigo === 'VERSION_YA_PUBLICADA' && r2.numero === 4 && bd.llamadasRpc.length === rpcAntes && bd.t.planeacion_versiones.length === 4,
      '9d. «Apruébala» repetido: recupera la versión 4 por su identidad, sin publicar otra')
    const continuado = await continuarAjuste(bd.sb, CONV, texto, `${BASE_TEXTO.replace('Lluvia de ideas.', 'Lluvia de ideas con tarjetas y dibujos.')}\n\n${RESUMEN()}`, 'Agrega dibujos')
    verificar(ajustesDe(bd.t.conversaciones_chat[0].planeacion_activa).length === 1 && !!continuado && continuado.includes(ETIQUETA_AJUSTE),
      '9e. Un borrador ya publicado no hereda una identidad publicable al seguir corrigiéndolo')
  }
  {
    // 9f. Caso real de E2E: borrador publicado ANTES de existir la marca
    // (sin publicadoComo); se reconoce por la clave de la versión siguiente.
    const bd = crearBD()
    const texto = borradorAjuste()
    registrar(bd, texto, { id: 'm9' })
    bd.t.planeaciones[0].version = 4
    bd.t.planeacion_versiones.push({ id: 'v4', planeacion_id: PL, docente_id: DOCENTE, numero: 4, borrador_clave: `msg:${CONV}:m9`, contenido: 'v4' })
    const ajuste = ajustesDe(bd.t.conversaciones_chat[0].planeacion_activa)[0] as AjusteRegistrado
    const ciclo = await cicloDelAjuste(bd.sb, DOCENTE, ajuste)
    verificar(ciclo.estado === 'publicado' && ciclo.numero === 4 && ciclo.vigente === 4, '9f. Publicado sin marca (anterior a este cambio): se reconoce por la clave de la versión 4 y su huella')
    const r = await aprobar(bd, texto)
    verificar(r?.codigo === 'VERSION_YA_PUBLICADA' && ajustesDe(bd.t.conversaciones_chat[0].planeacion_activa)[0].publicadoComo === 4 && bd.llamadasRpc.length === 0,
      '9g. Recuperar su aprobación lo marca como publicado (sin publicar otra versión)')
  }
  {
    // 9h. Pendiente con base obsoleta: otra modificación publicó la versión 4.
    const bd = crearBD()
    const texto = borradorAjuste()
    registrar(bd, texto)
    bd.t.planeaciones[0].version = 4
    bd.t.mensajes_chat.push({ id: `${CONV}:m-otro`, conversacion_id: CONV, rol: 'asistente', texto: 'otro ajuste distinto' })
    bd.t.planeacion_versiones.push({ id: 'v4', planeacion_id: PL, docente_id: DOCENTE, numero: 4, borrador_clave: `msg:${CONV}:m-otro`, contenido: 'v4 de otro ajuste' })
    const ajuste = ajustesDe(bd.t.conversaciones_chat[0].planeacion_activa)[0]
    const ciclo = await cicloDelAjuste(bd.sb, DOCENTE, ajuste)
    verificar(ciclo.estado === 'obsoleto' && ciclo.vigente === 4, '9h. Pendiente cuya base (3) quedó atrás por otra versión (4): obsoleto, nunca publicado')
    const r = await aprobar(bd, texto)
    verificar(r?.codigo === 'CONFLICTO_VERSION' && bd.llamadasRpc.length === 0 && !ajustesDe(bd.t.conversaciones_chat[0].planeacion_activa)[0].publicadoComo, '9i. Aprobarlo sigue siendo conflicto: no se publica ni se marca')
    const sinClave = crearBD()
    registrar(sinClave, texto)
    sinClave.t.planeaciones[0].version = 4
    sinClave.t.planeacion_versiones.push({ id: 'v4', planeacion_id: PL, docente_id: DOCENTE, numero: 4, borrador_clave: null, contenido: 'v4' })
    verificar((await cicloDelAjuste(sinClave.sb, DOCENTE, ajustesDe(sinClave.t.conversaciones_chat[0].planeacion_activa)[0])).estado === 'obsoleto', '9j. Versión siguiente sin clave de mensaje: obsoleto (nunca se asume publicado)')
    const ajena = crearBD()
    registrar(ajena, texto)
    verificar((await cicloDelAjuste(ajena.sb, '99999999-9999-4999-8999-999999999999', ajustesDe(ajena.t.conversaciones_chat[0].planeacion_activa)[0])).estado === 'sin_planeacion', '9k. Planeación de otro docente: sin planeación')
  }

  // 10. Indicadores modificados visibles antes de aprobar (datos estructurados, sin IA).
  {
    const nuevo = 'Escribe un cuento con secuencia causal y trabajo en equipo'
    const texto = borradorAjuste(`${BASE_TEXTO}\n\n${RESUMEN({ Indicadores: `Identifica partes del cuento; ${nuevo}` })}`, 'Cambia el segundo indicador de evaluación')
    const cierre = texto.slice(texto.indexOf('Cambios respecto a la versión 3'))
    verificar(cierre.includes('Cambios respecto a la versión 3: Indicadores de evaluación.\n• Indicador 2: antes «Escribe con secuencia»; ahora «' + nuevo + '».\nVerifiqué que el resto es idéntico a la versión 3.')
      && !cierre.includes('Indicador 1') && cierre.endsWith('la guardo como versión 4.'),
      '10a. El cierre muestra solo el indicador que cambió, con antes y ahora')
    const sinIndicadores = borradorAjuste()
    verificar(!sinIndicadores.includes('• Indicador') && sinIndicadores.includes('Cambios respecto a la versión 3: Día 2. Verifiqué que el resto es idéntico a la versión 3. ¿Quieres corregir algo más?'), '10b. Sin cambios de indicadores, el cierre queda igual que antes')
    verificar(detalleIndicadores(['A', 'B'], ['A', 'B', 'C']) === '• Indicador 3 (nuevo): «C».' && detalleIndicadores(['A', 'B'], ['A']) === '• Indicador 2 (se quitó): «B».' && detalleIndicadores(['Uno  dos'], [' Uno dos ']) === '', '10c. Indicadores nuevos o quitados se nombran; diferencias solo de espacios no cuentan')
    const bd = crearBD({ evaluacion: 'protegida' })
    registrar(bd, texto)
    const r = await aprobar(bd, texto)
    const v4 = bd.t.planeacion_versiones.find((v) => v.numero === 4)!
    verificar(r?.codigo === 'VERSION_PUBLICADA' && !String(v4.contenido).includes('• Indicador') && (v4.estructura as typeof ESTRUCTURA).proyecto.indicadores[1] === nuevo, '10d. El detalle no entra al texto de la versión; el indicador nuevo sí, en su estructura')
  }

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
