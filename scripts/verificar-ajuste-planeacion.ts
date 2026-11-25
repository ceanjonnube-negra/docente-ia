// Hito 2, etapa 3a — borrador de AJUSTE de una planeación guardada.
// Sin red ni IA: la salida del modelo se simula.
//   npx tsx scripts/verificar-ajuste-planeacion.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ETIQUETA_AJUSTE,
  ajusteDelBorrador,
  alcanceDeInstruccion,
  baseVigente,
  construirBorradorAjustado,
  contextoParaAjuste,
  heredarAjuste,
  ajustePublicable,
  continuarAjuste,
  huellaBorrador,
  registrarAjuste,
  seccionesDe,
  type BaseAjuste,
} from '../lib/planeacion/modificarPlaneacion'
import { esRespuestaDeCambio, guardarReferenciaPlaneacion } from '../lib/planeacion/consultaPlaneaciones'
import { construirPromptEdicion, documentoDeEdicion } from '../lib/asistente/documentos'
import { aprobarBorradorPlaneacion } from '../lib/planeacion/aprobarBorrador'
import type { SesionContexto } from '../lib/sesionContexto'
import type { Planeacion } from '../lib/planeacion/tipos'

let fallos = 0
function verificar(condicion: boolean, nombre: string) {
  if (condicion) console.log(`✓ ${nombre}`)
  else { fallos++; console.log(`✗ ${nombre}`) }
}

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
const ESTRUCTURA = {
  planeacion: { nombre: 'Cuentos propios', proposito: 'Que el grupo escriba cuentos propios.', fecha_inicio: '2026-11-24', fecha_fin: '2026-11-26', campo_formativo: 'Lenguajes' },
  proyecto: { nombre: 'Cuentos propios', campos_formativos: ['Lenguajes'], contenidos: ['Comprensión y producción de cuentos.'], pda: ['Escribe cuentos con secuencia causal.'], ejes_articuladores: ['Apropiación de las culturas'],
    metodologia: 'Proyectos', duracion_dias: 3, actividades: [{ dia: 1, resumen: 'Leemos' }, { dia: 2, resumen: 'Planeamos' }, { dia: 3, resumen: 'Escribimos' }], recursos: ['Hojas', 'Colores'],
    indicadores: ['Identifica partes del cuento', 'Escribe con secuencia'], producto_final: 'Cuento ilustrado.', evidencias: ['Plan', 'Borrador'] },
}
const PLANEACION = { id: 'pl-1', nombre: 'Cuentos propios', version: 3, grupo_id: 'g-1', fecha_inicio: '2026-11-24', fecha_fin: '2026-11-26' } as Planeacion
const BASE: BaseAjuste = { planeacion: PLANEACION, numero: 3, contenido: BASE_TEXTO, estructura: ESTRUCTURA, trazabilidad: { esquema: 'planeacion-curricular-v1' } }
const RESUMEN = (cambios: Record<string, string> = {}) => ['📎 RESUMEN PARA GUARDAR', 'Nombre: Cuentos propios', 'Fecha de inicio: 2026-11-24', 'Fecha de fin: 2026-11-26', 'Duración: 3 días',
  `Propósito: ${cambios['Propósito'] ?? 'Que el grupo escriba cuentos propios.'}`, 'Campos formativos: Lenguajes',
  `Contenidos: ${cambios.Contenidos ?? 'Comprensión y producción de cuentos.'}`, `PDA: ${cambios.PDA ?? 'Escribe cuentos con secuencia causal.'}`, 'Ejes articuladores: Apropiación de las culturas',
  'Metodología: Proyectos', 'Producto final: Cuento ilustrado.', 'Secuencia didáctica: Día 1: Leemos; Día 2: Planeamos; Día 3: Escribimos', `Recursos: ${cambios.Recursos ?? 'Hojas; Colores'}`,
  'Evidencias: Plan; Borrador', `Indicadores de evaluación: ${cambios.Indicadores ?? 'Identifica partes del cuento; Escribe con secuencia'}`].join('\n')
const cuerpoCon = (reemplazos: Record<string, string>, quitarCurricular = false) =>
  BASE_TEXTO.split('\n\n').filter((s) => !(quitarCurricular && s.startsWith('📌'))).map((s) => { for (const [desde, hacia] of Object.entries(reemplazos)) s = s.replace(desde, hacia); return s }).join('\n\n')

async function main() {
  // 1. Alcance de la instrucción
  const a = (t: string) => { const r = alcanceDeInstruccion(t); return r === 'global' ? 'global' : [...r].sort().join(',') }
  verificar(a('Cámbiale la sesión 2: agrega una dinámica') === 'dia:2' && a('cambia la segunda sesión') === 'dia:2' && a('agrega materiales reciclados') === 'materiales' && a('cambia el propósito') === 'proposito' && a('ajusta los indicadores de evaluación') === 'evaluacion'
    && a('cambia los contenidos') === 'curricular,encabezado' && a('hazla de 8 días') === 'global' && a('mejora todo') === 'global' && a('cambia las fechas') === 'global' && a('hazla más divertida') === 'global',
    '1. Alcance: día, materiales, propósito, evaluación y curricular se acotan; duración, fechas o algo general es global')

  // 2. Ajuste acotado: se restaura lo que el modelo cambió sin que se pidiera; resumen de cambios real.
  {
    const modelo = `${cuerpoCon({ 'Lluvia de ideas.': 'Lluvia de ideas con tarjetas y una dinámica de roles.', 'Escritura del borrador.': 'Escritura libre.', '- Colores': '- Colores\n- Plastilina', 'cuentos propios.': 'cuentos propios y compartirlos.' }, true)}\n\n${RESUMEN({ Contenidos: 'Otro contenido inventado', PDA: 'Otro PDA', Indicadores: 'Indicador nuevo', Recursos: 'Hojas; Colores; Plastilina', 'Propósito': 'Otro propósito' })}`
    const r = construirBorradorAjustado({ textoModelo: modelo, base: BASE, instruccion: 'Cámbiale la sesión 2: agrega una dinámica' })!
    const sec = seccionesDe(r.textoFinal.slice(0, r.textoFinal.indexOf('📎')))!
    const base = seccionesDe(BASE_TEXTO)!
    verificar(sec.find((s) => s.clave === 'dia:2')!.texto.includes('dinámica de roles') && ['dia:1', 'dia:3', 'materiales', 'proposito', 'curricular', 'encabezado', 'producto'].every((k) => sec.find((s) => s.clave === k)!.texto === base.find((s) => s.clave === k)!.texto),
      '2a. Solo cambia el Día 2; Día 3, materiales y propósito alterados por el modelo se restauran desde la base')
    verificar(r.textoFinal.includes('Contenidos: Comprensión y producción de cuentos.') && r.textoFinal.includes('PDA: Escribe cuentos con secuencia causal.') && r.textoFinal.includes('Indicadores de evaluación: Identifica partes del cuento; Escribe con secuencia') && r.textoFinal.includes('Recursos: Hojas; Colores') && r.textoFinal.includes('Propósito: Que el grupo escriba cuentos propios.'),
      '2b. Contenidos, PDA, indicadores, recursos y propósito del resumen se conservan de la versión confirmada')
    verificar(sec.findIndex((s) => s.clave === 'curricular') === 2 && r.restauradas.includes('Contenidos y PDA'), '2c. La sección curricular (omitida por el modelo) vuelve a ser la de la base: la selección original no se altera')
    verificar(JSON.stringify(r.cambios) === JSON.stringify(['Día 2']) && r.verificado && r.textoFinal.includes('Cambios respecto a la versión 3: Día 2. Verifiqué que el resto es idéntico a la versión 3.') && r.textoFinal.trim().endsWith('¿Quieres corregir algo más o guardarlo como versión 4?'),
      '2d. Resumen de cambios real (solo Día 2) y la verificación del resto es cierta; se propone la versión 4')
    verificar(new RegExp(`^${ETIQUETA_AJUSTE}: «Cuentos propios», versión 3$`, 'm').test(r.textoFinal) && r.textoFinal.indexOf(ETIQUETA_AJUSTE) > r.textoFinal.indexOf('📎 RESUMEN PARA GUARDAR'), '2e. El resumen lleva la línea de ajuste (respaldo de la identidad)')
  }

  // 3. Ajuste global con cambio de estructura: nada se restaura y se listan todas las diferencias.
  {
    const modelo = `${cuerpoCon({ 'Duración: 3 días': 'Duración: 4 días' })}\n\n📅 DÍA 4 — Compartimos\nLectura en voz alta.\n\n${RESUMEN()}`
    const r = construirBorradorAjustado({ textoModelo: modelo, base: BASE, instruccion: 'hazla de 4 días' })!
    verificar(r.restauradas.length === 0 && r.cambios.includes('Encabezado') && r.cambios.includes('Día 4 (nueva)') && !r.cambios.includes('Día 1'),
      '3. Global con estructura nueva: no se restaura nada; cambios = encabezado y Día 4 (nueva)')
  }

  // 4. Sin diferencias reales: lo dice (no inventa cambios).
  {
    const r = construirBorradorAjustado({ textoModelo: `${BASE_TEXTO}\n\n${RESUMEN()}`, base: BASE, instruccion: 'Cámbiale la sesión 2' })!
    verificar(r.cambios.length === 0 && r.textoFinal.includes('No encontré diferencias con la versión 3'), '4. Si el ajuste no cambió nada, lo dice')
  }

  // 5. Estructura irreconocible: no afirma haber verificado el resto.
  {
    const r = construirBorradorAjustado({ textoModelo: `Texto libre sin secciones.\n\n${RESUMEN()}`, base: BASE, instruccion: 'Cámbiale la sesión 2' })!
    verificar(!r.verificado && !r.textoFinal.includes('Verifiqué'), '5. Sin poder comparar sección por sección, nunca afirma que el resto se conservó')
  }

  // 6. Pedir cambiar contenidos/PDA o evaluación sí permite cambiarlos.
  {
    const curricularNuevo = CURRICULAR.replace('Comprensión y producción de cuentos.', 'Leyendas de la comunidad.')
    const modelo = `${cuerpoCon({ [CURRICULAR]: curricularNuevo })}\n\n${RESUMEN({ Contenidos: 'Leyendas de la comunidad.' })}`
    const r = construirBorradorAjustado({ textoModelo: modelo, base: BASE, instruccion: 'cambia los contenidos por leyendas de la comunidad' })!
    verificar(r.textoFinal.includes('Contenidos: Leyendas de la comunidad.') && r.cambios.includes('Contenidos y PDA') && r.cambios.includes('Contenidos'), '6a. Con contenidos pedidos, el cambio curricular se conserva y se reporta')
    const modeloEval = `${cuerpoCon({ 'Evaluación: plan escrito.': 'Evaluación: rúbrica del plan.' })}\n\n${RESUMEN({ Indicadores: 'Planea con rúbrica; Escribe con secuencia' })}`
    const re = construirBorradorAjustado({ textoModelo: modeloEval, base: BASE, instruccion: 'ajusta la evaluación del plan' })!
    verificar(re.textoFinal.includes('Indicadores de evaluación: Planea con rúbrica; Escribe con secuencia') && re.textoFinal.includes('rúbrica del plan') && re.cambios.includes('Día 2'), '6b. Con evaluación pedida, sus líneas en los días y los indicadores pueden cambiar')
  }

  // 7. Contexto de la única llamada: base canónica completa + instrucción; nunca texto del cliente.
  {
    const c = contextoParaAjuste(BASE, 'Cámbiale la sesión 2')
    verificar(c.includes('versión 3 de «Cuentos propios»') && c.includes('📅 DÍA 3 — Escribimos') && c.includes('Indicadores de evaluación: Identifica partes del cuento; Escribe con secuencia') && c.includes('Contenidos: Comprensión y producción de cuentos.') && c.includes('«Cámbiale la sesión 2»') && c.includes('Copia LITERALMENTE'),
      '7. El contexto lleva el snapshot completo (cuerpo + resumen estructurado) y la instrucción')
    const sbSinTexto = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { numero: 3, contenido: null, estructura: {} } }) }) }) }) }) } as unknown as SupabaseClient
    verificar(await baseVigente(sbSinTexto, PLANEACION) === null, '7b. Sin texto canónico (planeación anterior) no hay base: no se inventa')
  }

  // 8. Identidad del ajuste: metadata del servidor (huella) y respaldo textual; se conserva al reescribir la referencia.
  {
    const conv: Record<string, unknown> = { planeacion_activa: { esquema: 'referencia-planeacion-v1', planeacionId: 'pl-1', numero: 3, opciones: [] } }
    const escrituras: string[] = []
    const sb = { from: () => {
      let cambios: Record<string, unknown> | null = null
      const q = { select: () => q, eq: () => q, update: (d: Record<string, unknown>) => { cambios = d; return q },
        maybeSingle: async () => ({ data: conv, error: null }),
        then: (ok: (r: unknown) => unknown) => { if (cambios) { Object.assign(conv, cambios); escrituras.push('conversaciones_chat') } return Promise.resolve({ error: null }).then(ok) } }
      return q
    } } as unknown as SupabaseClient
    const borrador = construirBorradorAjustado({ textoModelo: `${BASE_TEXTO.replace('Lluvia de ideas.', 'Dinámica.')}\n\n${RESUMEN()}`, base: BASE, instruccion: 'Cámbiale la sesión 2' })!.textoFinal
    await registrarAjuste(sb, 'conv-1', { planeacionId: 'pl-1', versionBase: 3, grupoId: 'g-1', huella: huellaBorrador(borrador) })
    const ref = conv.planeacion_activa as { planeacionId: string; ajustes: { huella: string; versionBase: number }[] }
    verificar(ref.planeacionId === 'pl-1' && ref.ajustes.length === 1 && ref.ajustes[0].versionBase === 3, '8a. Se registra planeación, versión base, grupo y huella del borrador, conservando la referencia')
    const id = ajusteDelBorrador(borrador, conv.planeacion_activa)
    verificar(!!id && id.planeacionId === 'pl-1' && id.versionBase === 3, '8b. El borrador se identifica por su huella (metadata del servidor)')
    const alterado = borrador.replace('Dinámica.', 'Dinámica distinta.')
    verificar(ajusteDelBorrador(alterado, conv.planeacion_activa)?.planeacionId === null && ajusteDelBorrador(alterado.replace(new RegExp(`^${ETIQUETA_AJUSTE}:.*$`, 'm'), ''), conv.planeacion_activa) === null,
      '8c. Si el texto cambia, la huella ya no coincide: solo la línea del resumen lo identifica (y sin ella, no es un ajuste registrado)')
    verificar(ajusteDelBorrador(borrador, null)?.planeacionId === null && ajusteDelBorrador(`${BASE_TEXTO}\n\n${RESUMEN()}`, conv.planeacion_activa) === null, '8d. Sin metadata, la línea del resumen lo identifica como ajuste; un borrador normal no lo es')
    await guardarReferenciaPlaneacion(sb, 'conv-1', { planeacionId: 'pl-2', numero: 1, opciones: [] })
    verificar((conv.planeacion_activa as { planeacionId: string; ajustes?: unknown[] }).planeacionId === 'pl-2' && (conv.planeacion_activa as { ajustes?: unknown[] }).ajustes?.length === 1, '8e. Consultar otra planeación conserva los ajustes registrados')
    const siguiente = heredarAjuste(`${BASE_TEXTO.replace('Lluvia de ideas.', 'Otra dinámica.')}\n\n${RESUMEN()}\n\nYa preparé la planeación. ¿Deseas corregir algo o aprobarla para guardarla?`, borrador)!
    verificar(new RegExp(`^${ETIQUETA_AJUSTE}: «Cuentos propios», versión 3$`, 'm').test(siguiente) && siguiente.includes('¿Deseas corregir algo'), '8f. Seguir corrigiendo un borrador de ajuste hereda su identidad')
  }

  // 9. Un borrador de ajuste NUNCA se aprueba como planeación nueva.
  {
    const borrador = construirBorradorAjustado({ textoModelo: `${BASE_TEXTO.replace('Lluvia de ideas.', 'Dinámica.')}\n\n${RESUMEN()}`, base: BASE, instruccion: 'Cámbiale la sesión 2' })!.textoFinal
    const escrituras: string[] = []
    const refConHuella = { ajustes: [{ planeacionId: 'pl-1', versionBase: 3, grupoId: 'g-1', huella: '', creadoEn: '' }] }
    const sbFalso = (planeacionActiva: unknown) => ({
      from: (tabla: string) => {
        const q = { select: () => q, eq: () => q, insert: () => { escrituras.push(tabla); return q }, update: () => { escrituras.push(tabla); return q }, maybeSingle: async () => ({ data: tabla === 'conversaciones_chat' ? { planeacion_activa: planeacionActiva } : null, error: null }), then: (ok: (r: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok) }
        return q
      },
      rpc: async () => { escrituras.push('rpc'); return { data: null, error: null } },
      auth: { getUser: async () => ({ data: { user: { id: 'd-1' } }, error: null }) },
    }) as unknown as SupabaseClient
    const sesion = { docente_id: 'd-1', grupo_activo_id: 'g-1', ciclo_escolar_id: 'c-1', fecha_actual: '2026-11-25' } as unknown as SesionContexto
    const r1 = await aprobarBorradorPlaneacion(sbFalso(null), sesion, [{ role: 'assistant', content: borrador }], 'Apruébala', 'conv-1')
    const sinLinea = borrador.replace(new RegExp(`^${ETIQUETA_AJUSTE}:.*\\n?`, 'm'), '')
    refConHuella.ajustes[0].huella = huellaBorrador(sinLinea)
    const r2 = await aprobarBorradorPlaneacion(sbFalso(refConHuella), sesion, [{ role: 'assistant', content: sinLinea }], 'Apruébala', 'conv-1')
    verificar(!r1.ok && r1.codigo === 'AJUSTE_PENDIENTE' && !r2.ok && r2.codigo === 'AJUSTE_PENDIENTE' && escrituras.length === 0,
      '9. Aprobar un borrador de ajuste (por su línea o solo por la huella del servidor) no crea ni escribe nada: AJUSTE_PENDIENTE')
  }

  // 10. Ruta del Chat (estático): una sola llamada, base canónica, sin publicar nada todavía.
  {
    const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
    verificar(ruta.includes('mensajeConDocumento = resolucion.instruccion') && ruta.includes('contextoParaAjuste(ajusteDelTurno.base, ajusteDelTurno.instruccion, ajusteDelTurno.referencia)') && /ajusteDelTurno\s*\n?\s*\? clasificacionAjustePlaneacion\(\)/.test(ruta),
      '10a. El modelo recibe solo la instrucción; la base canónica va en el contexto; sin clasificador')
    verificar(ruta.includes('mencionaCurricular(ajusteDelTurno.instruccion) && curricularDelTurno') && ruta.includes('registrarAjuste(supabaseUser!, ajusteDelTurno.conversacionId'),
      '10b. La sección curricular solo se recalcula si se pidió; la identidad del ajuste se registra en el servidor')
    verificar(!ruta.includes("rpc('publicar_version_planeacion'") && !ruta.includes('publicarVersionPlaneacion('), '10c. La subetapa 3a no publica versiones: la planeación aprobada no cambia')
  }

  // 11. Respuestas naturales a "¿Qué cambio quieres hacer en «X»?" (sin verbo; sin IA).
  {
    const hoy = '2026-11-25'
    const si = ['Que dure 3 días', 'Más dinámicas', 'Para trabajar en equipos', 'Con menos materiales', 'Solo la segunda sesión', 'Nada más la segunda sesión', 'Agrégale una salida al patio']
    const no = ['Muéstrame la planeación de fracciones', '¿Qué día es hoy?', 'Pasa lista', 'Registra una incidencia de Ana', 'Elabora una planeación de leyendas', 'No, gracias', 'nada', '¿Cuántos alumnos faltaron ayer?', 'Olvídalo']
    const aceptadas = si.filter((m) => esRespuestaDeCambio(m, hoy))
    const rechazadas = no.filter((m) => !esRespuestaDeCambio(m, hoy))
    verificar(aceptadas.length === si.length && rechazadas.length === no.length,
      `11. Respuestas naturales aceptadas (${aceptadas.length}/${si.length}); consultas, otros temas y negativas rechazadas (${rechazadas.length}/${no.length})`)
  }

  // 12. Alcance no reconocido: sin cambios curriculares ni de evaluación injustificados.
  {
    const curricularAlterado = CURRICULAR.replace('Comprensión y producción de cuentos.', 'Contenido que el modelo cambió.')
    const modelo = `${cuerpoCon({ [CURRICULAR]: curricularAlterado, 'Lluvia de ideas.': 'Juego de roles con títeres.', 'Evaluación: plan escrito.': 'Evaluación: rúbrica inventada.', 'Evaluación: participación oral.': 'Evaluación: lista de cotejo.' })}\n\n${RESUMEN({ Contenidos: 'Otro', PDA: 'Otro PDA', Indicadores: 'Indicador inventado' })}`
    for (const instruccion of ['hazla más divertida', 'Más dinámicas', 'Para trabajar en equipos']) {
      const r = construirBorradorAjustado({ textoModelo: modelo, base: BASE, instruccion })!
      const sec = seccionesDe(r.textoFinal.slice(0, r.textoFinal.indexOf('📎')))!
      const base = seccionesDe(BASE_TEXTO)!
      const ok = sec.find((s) => s.clave === 'curricular')!.texto === base.find((s) => s.clave === 'curricular')!.texto
        && r.textoFinal.includes('Contenidos: Comprensión y producción de cuentos.') && r.textoFinal.includes('PDA: Escribe cuentos con secuencia causal.')
        && r.textoFinal.includes('Indicadores de evaluación: Identifica partes del cuento; Escribe con secuencia')
        && r.textoFinal.includes('📌 Evaluación: plan escrito.') && r.textoFinal.includes('📌 Evaluación: participación oral.') && !r.textoFinal.includes('rúbrica inventada') && !r.textoFinal.includes('lista de cotejo')
        && r.textoFinal.includes('Juego de roles con títeres.') && !r.cambios.includes('Contenidos') && !r.cambios.includes('Indicadores de evaluación')
      verificar(ok, `12. «${instruccion}»: la actividad cambia; contenidos, PDA, indicadores y evaluación de cada día se conservan de la versión base`)
    }
  }

  // 13. Identidad persistente al seguir editando (documento activo, varias rondas, consultas intermedias).
  {
    const conv: Record<string, unknown> = { planeacion_activa: { esquema: 'referencia-planeacion-v1', planeacionId: 'pl-1', numero: 3, opciones: [] } }
    // Versión base exacta (planeación del grupo y su versión 3), para verificar la conservación.
    const filas: Record<string, unknown> = { planeaciones: { id: 'pl-1', nombre: 'Cuentos propios', version: 3, grupo_id: 'g-1' }, planeacion_versiones: { numero: 3, contenido: BASE_TEXTO, estructura: ESTRUCTURA, trazabilidad_curricular: null } }
    const sb = { from: (tabla: string) => {
      let cambios: Record<string, unknown> | null = null
      const q = { select: () => q, eq: () => q, update: (d: Record<string, unknown>) => { cambios = d; return q },
        maybeSingle: async () => ({ data: JSON.parse(JSON.stringify(filas[tabla] ?? conv)), error: null }),
        then: (ok: (r: unknown) => unknown) => { if (cambios) Object.assign(conv, cambios); return Promise.resolve({ error: null }).then(ok) } }
      return q
    } } as unknown as SupabaseClient
    const v1 = construirBorradorAjustado({ textoModelo: `${BASE_TEXTO.replace('Lluvia de ideas.', 'Dinámica.')}\n\n${RESUMEN()}`, base: BASE, instruccion: 'Cámbiale la sesión 2' })!.textoFinal
    await registrarAjuste(sb, 'conv-1', { planeacionId: 'pl-1', versionBase: 3, grupoId: 'g-1', huella: huellaBorrador(v1) })
    // El cliente reenvía el documento (sin el mensaje de cierre) dentro del prompt de edición.
    const documentoActivo = v1.slice(0, v1.indexOf('\n\nCambios respecto'))
    const reenviado = documentoDeEdicion(construirPromptEdicion(documentoActivo, 'agrega una lectura al día 3'))
    verificar(reenviado === documentoActivo && ajustePublicable(reenviado!, conv.planeacion_activa)?.planeacionId === 'pl-1', '13a. El documento activo reenviado se reconoce por su huella (sin depender del mensaje de cierre)')
    const v2 = await continuarAjuste(sb, 'conv-1', reenviado!, `${BASE_TEXTO.replace('Escritura del borrador.', 'Lectura y escritura.')}\n\n${RESUMEN()}\n\nYa preparé la planeación.`)
    await guardarReferenciaPlaneacion(sb, 'conv-1', { planeacionId: 'pl-9', numero: 1, opciones: [] }) // consulta intermedia
    const v3 = await continuarAjuste(sb, 'conv-1', v2!, `${BASE_TEXTO.replace('Hojas', 'Hojas recicladas')}\n\n${RESUMEN()}`)
    const id3 = ajustePublicable(v3!, JSON.parse(JSON.stringify(conv.planeacion_activa)))
    verificar(!!id3 && id3.planeacionId === 'pl-1' && id3.versionBase === 3 && id3.grupoId === 'g-1' && ajustePublicable(v2!, conv.planeacion_activa)?.planeacionId === 'pl-1',
      '13b. Tras varias ediciones y una consulta intermedia, cada borrador conserva planeación, versión base y grupo (metadata persistida, sobrevive a recargas)')
    const ajustesAntes = (conv.planeacion_activa as { ajustes: unknown[] }).ajustes.length
    const soloLinea = v1.replace('Dinámica.', 'Texto alterado por el cliente.')
    const v4 = await continuarAjuste(sb, 'conv-1', soloLinea, `${BASE_TEXTO}\n\n${RESUMEN()}`)
    verificar(!!v4 && new RegExp(`^${ETIQUETA_AJUSTE}:`, 'm').test(v4) && ajustePublicable(v4, conv.planeacion_activa) === null && ajustePublicable(soloLinea, conv.planeacion_activa) === null
      && (conv.planeacion_activa as { ajustes: unknown[] }).ajustes.length === ajustesAntes,
      '13c. Sin metadata confiable (solo la línea del resumen): no se registra nada y no es publicable; la línea sigue bloqueando la aprobación como nueva')
  }

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
