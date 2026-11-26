// Hito 2, etapa 5c — «Continuar en el Chat IA» desde Planeación.
// Sin red, sin IA: la lógica de la ruta con un cliente de Supabase falso
// con RLS por docente, y las funciones reales del Chat que reconocen el
// documento activo y la versión consultada.
//   npx tsx scripts/verificar-continuar-chat.tsx

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { atenderContinuarEnChat, estadoHttpContinuar, referenciaReutilizable, type DependenciasContinuarEnChat } from '../lib/planeacion/continuarEnChat'
import { contieneContenidoConsultado, versionConsultada } from '../lib/planeacion/consultaPlaneaciones'
import { esDocumentoFormal } from '../lib/asistente/documentos'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'sin-clave-pruebas'

let fallos = 0
let total = 0
function verificar(ok: boolean, nombre: string) {
  total++
  if (!ok) fallos++
  console.log(`${ok ? '✓' : '✗'} ${nombre}`)
}
const leer = (r: string) => readFileSync(join(__dirname, '..', r), 'utf-8')
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const G1 = 'a1000000-0000-4000-8000-000000000001'
const G2 = 'a2000000-0000-4000-8000-000000000002'
const P = 'd1000000-0000-4000-8000-000000000001'
const V = (n: number) => `e${n}000000-0000-4000-8000-00000000000${n}`
const C = (n: number) => `c${n}000000-0000-4000-8000-00000000000${n}`
const CONTENIDO = (n: number) => `📋 PLANEACIÓN DIDÁCTICA\nCampo Formativo: Lenguajes\n\n🎯 PROPÓSITO GENERAL\nQue escriban cuentos propios (versión ${n}).\n\n📅 DÍA 1 — Entramos al mundo\n🔷 Inicio (15 min)\nLa docente lee un cuento.`
type Fila = Record<string, unknown>

function base() {
  return {
    planeaciones: [
      { id: P, docente_id: A, grupo_id: G1, nombre: '¡A contar historias!', fecha_inicio: '2026-11-24', fecha_fin: '2026-11-30', estado: 'publicada', version: 4 },
      { id: 'pb', docente_id: B, grupo_id: G2, nombre: 'Ajena', estado: 'publicada', version: 1 },
    ] as Fila[],
    planeacion_versiones: [1, 2, 3, 4].map((n) => ({ id: V(n), docente_id: A, planeacion_id: P, grupo_id: G1, numero: n, origen: n === 1 ? 'aprobacion' : 'modificacion', contenido: CONTENIDO(n), documento_word_archivo_id: n === 4 ? 'w4' : null, documento_pdf_archivo_id: n === 4 ? 'f4' : null, creada_en: `2026-11-2${n}T18:00:00Z` }))
      .concat([{ id: V(9), docente_id: B, planeacion_id: 'pb', grupo_id: G2, numero: 1, origen: 'aprobacion', contenido: 'ajena', documento_word_archivo_id: null, documento_pdf_archivo_id: null, creada_en: '2026-11-20T18:00:00Z' }]) as Fila[],
    conversaciones_chat: [
      { id: C(1), docente_id: A, grupo_id: G1, grupo_contexto_version: 1, eliminada_en: null, planeacion_activa: null },
      { id: C(2), docente_id: A, grupo_id: G1, grupo_contexto_version: 1, eliminada_en: null, planeacion_activa: null },
      { id: C(3), docente_id: A, grupo_id: G2, grupo_contexto_version: 1, eliminada_en: null, planeacion_activa: null },
      { id: C(4), docente_id: B, grupo_id: G1, grupo_contexto_version: 1, eliminada_en: null, planeacion_activa: null },
      { id: C(5), docente_id: A, grupo_id: G1, grupo_contexto_version: 1, eliminada_en: '2026-11-25T00:00:00Z', planeacion_activa: null },
    ] as Fila[],
    mensajes_chat: [{ id: `${C(2)}:msg-1`, conversacion_id: C(2), docente_id: A, rol: 'usuario', texto: 'Hola', contenido: {} }] as Fila[],
    hojas_evaluacion: [] as Fila[],
    seguimiento_resultados: [] as Fila[],
  }
}
type Bd = ReturnType<typeof base>

function cliente(bd: Bd, docente: string) {
  const escrituras: string[] = []
  const from = (tabla: keyof Bd) => {
    let filas = bd[tabla].filter((f) => f.docente_id === docente)
    let cabeza = false
    let orden: string | null = null
    const q = {
      select: (_c?: string, o?: { head?: boolean }) => { cabeza = !!o?.head; return q },
      eq: (c: string, v: unknown) => { filas = filas.filter((f) => f[c] === v); return q },
      order: (c: string) => { orden = c; return q },
      maybeSingle: async () => ({ data: filas[0] ?? null, error: null }),
      insert: async (fila: Fila) => {
        escrituras.push(`insert:${tabla}`)
        if (bd[tabla].some((f) => f.id === fila.id)) return { error: { code: '23505', message: 'duplicada' } }
        bd[tabla].push(fila)
        return { error: null }
      },
      update: (cambios: Fila) => ({
        eq: async (c: string, v: unknown) => {
          escrituras.push(`update:${tabla}`)
          for (const f of bd[tabla]) if (f.docente_id === docente && f[c] === v) Object.assign(f, cambios)
          return { error: null }
        },
      }),
      then: (r: (x: unknown) => unknown) => {
        const datos = orden ? [...filas].sort((a, b) => (a[orden!] as number) - (b[orden!] as number)) : filas
        return Promise.resolve(cabeza ? { count: filas.length, error: null } : { data: datos, error: null }).then(r)
      },
    }
    return q
  }
  return { sb: { from } as unknown as SupabaseClient, escrituras }
}

function escenario() {
  const bd = base()
  const { sb, escrituras } = cliente(bd, A)
  const deps: DependenciasContinuarEnChat = {
    autenticar: async (token) => (token === 'tkn' ? { ok: true, docenteId: A, sb } : { ok: false }),
    firmar: () => async (archivoId) => ({ nombre: `PLANEACION_${archivoId}`, url: `https://firmada/${archivoId}`, urlVer: `https://ver/${archivoId}` }),
  }
  const pedir = (versionId: string, cuerpo: Fila, token: string | null = 'tkn') => atenderContinuarEnChat(deps, { token, versionId, cuerpo })
  return { bd, sb, escrituras, pedir }
}

async function main() {
  console.log('== 1. Validación en el servidor')
  {
    const e = escenario()
    const invalidos = [await e.pedir('x', { conversacionId: C(1), modo: 'abrir' }), await e.pedir(V(4), { conversacionId: 'x', modo: 'abrir' }), await e.pedir(V(4), { conversacionId: C(1), modo: 'enviar' })]
    verificar(invalidos.every((r) => r.estado === 'invalido' && estadoHttpContinuar(r) === 400) && (await e.pedir(V(4), { conversacionId: C(1), modo: 'abrir' }, null)).estado === 'sesion', '1a. Entradas inválidas: 400; sin sesión: 401')
    verificar((await e.pedir(V(9), { conversacionId: C(1), modo: 'abrir' })).estado === 'no_disponible', '1b. Versión de otro docente (RLS): no disponible')
    const otroGrupo = await e.pedir(V(4), { conversacionId: C(3), modo: 'abrir' })
    verificar(otroGrupo.estado === 'otro_grupo' && estadoHttpContinuar(otroGrupo) === 409, '1c. Conversación fijada a otro grupo: rechazada (409)')
    verificar((await e.pedir(V(4), { conversacionId: C(4), modo: 'abrir' })).estado === 'no_disponible' && (await e.pedir(V(4), { conversacionId: C(5), modo: 'abrir' })).estado === 'no_disponible',
      '1d. Conversación de otro docente o eliminada: no disponible')
    verificar(e.escrituras.length === 0, '1e. Nada se escribe cuando la validación falla')
  }
  {
    const e = escenario()
    e.bd.planeaciones[0].estado = 'borrador'
    verificar((await e.pedir(V(4), { conversacionId: C(1), modo: 'abrir' })).estado === 'no_disponible', '1f. Planeación no publicada: no disponible')
  }

  console.log('== 2. Abrir: contexto canónico en una conversación vacía')
  {
    const e = escenario()
    const r = await e.pedir(V(4), { conversacionId: C(1), modo: 'abrir', zonaHoraria: 'America/Hermosillo' })
    const conv = e.bd.conversaciones_chat[0]
    const msg = e.bd.mensajes_chat.find((m) => m.conversacion_id === C(1))!
    verificar(r.estado === 'listo' && r.mensajeId === `${C(1)}:contexto-${V(4)}`, '2a. Listo, con el identificador del mensaje de contexto')
    verificar(JSON.stringify(conv.planeacion_activa) === JSON.stringify({ esquema: 'referencia-planeacion-v1', planeacionId: P, numero: 4, opciones: [] }), '2b. Referencia exacta de la conversación: planeación y versión')
    verificar(msg.rol === 'asistente' && String(msg.texto).startsWith('📋 PLANEACIÓN DIDÁCTICA') && String(msg.texto).includes('(versión 4)') && String(msg.texto).includes('Versión 4 de 4 (vigente)'),
      '2c. Mensaje del asistente con la vista determinista de la versión (la misma de una consulta)')
    const contenido = msg.contenido as Fila
    verificar((contenido.archivos as Fila[]).map((a) => a.archivoId).join() === 'w4,f4' && !String(msg.texto).includes('[[') && !('texto' in contenido), '2d. Sus originales como tarjetas (Word y PDF), sin marcadores en el texto')
    verificar(e.escrituras.sort().join() === 'insert:mensajes_chat,update:conversaciones_chat', '2e. Solo escribe la referencia y el mensaje de contexto (nada en versiones, hojas ni resultados)')
    // El Chat lo reconoce como documento activo y como la versión consultada.
    verificar(esDocumentoFormal(String(msg.texto)), '2f. El Chat lo toma como documento activo (documento formal)')
    const consultada = await versionConsultada(e.sb, C(1))
    verificar(consultada?.id === V(4) && contieneContenidoConsultado(String(msg.texto), consultada), '2g. …y como la versión consultada: «cambia la sesión 2» y «dame el PDF» siguen los flujos ya validados')
    const repetida = await e.pedir(V(4), { conversacionId: C(1), modo: 'abrir' })
    verificar(repetida.estado === 'listo' && e.bd.mensajes_chat.filter((m) => m.conversacion_id === C(1)).length === 1, '2h. Repetir el toque no duplica el contexto')
  }
  {
    const e = escenario()
    const r = await e.pedir(V(4), { conversacionId: C(2), modo: 'abrir' })
    verificar(r.estado === 'requiere_nueva' && e.escrituras.length === 0 && e.bd.conversaciones_chat[1].planeacion_activa === null, '2i. Conversación con mensajes: nunca la toca (requiere una nueva)')
  }
  {
    const e = escenario()
    await e.pedir(V(2), { conversacionId: C(1), modo: 'abrir' })
    const msg = e.bd.mensajes_chat.find((m) => m.conversacion_id === C(1))!
    const consultada = await versionConsultada(e.sb, C(1))
    verificar(consultada?.numero === 2 && String(msg.texto).includes('(versión 2)') && String(msg.texto).includes('Versión 2 de 4') && !String(msg.texto).includes('(vigente)'),
      '2j. Versión histórica: conserva su identidad (versión 2, no vigente)')
    verificar(e.bd.planeaciones[0].version === 4 && e.bd.planeacion_versiones.every((v) => !('planeacion_activa' in v)), '2k. Consultarla no la vuelve vigente ni modifica versiones')
  }

  console.log('== 3. Reutilizar la conversación actual')
  const ref = (extra: Fila = {}) => ({ esquema: 'referencia-planeacion-v1' as const, planeacionId: P, numero: 4, opciones: [], ...extra })
  const p = { id: P, version: 4 }
  verificar(referenciaReutilizable(ref(), p, 4) && referenciaReutilizable(ref({ ajustes: [{ planeacionId: P, versionBase: 3 }] }), p, 4), '3a. Misma planeación y versión, sin ajustes pendientes: se reutiliza')
  verificar(!referenciaReutilizable(ref(), p, 2) && !referenciaReutilizable(ref({ planeacionId: 'otra' }), p, 4) && !referenciaReutilizable(null, p, 4), '3b. Otra versión u otra planeación: conversación nueva')
  verificar(!referenciaReutilizable(ref({ ajustes: [{ planeacionId: P, versionBase: 4 }] }), p, 4) && !referenciaReutilizable(ref({ instruccionPendiente: 'x' }), p, 4) && !referenciaReutilizable(ref({ ajustes: [{ planeacionId: 'otra', versionBase: 1 }] }), p, 4),
    '3c. Ajuste pendiente o borrador de otra planeación: conversación nueva (nunca se sobrescribe)')
  {
    const e = escenario()
    e.bd.conversaciones_chat[1].planeacion_activa = ref()
    const reutilizar = await e.pedir(V(4), { conversacionId: C(2), modo: 'evaluar' })
    const otra = await e.pedir(V(3), { conversacionId: C(2), modo: 'evaluar' })
    verificar(reutilizar.estado === 'reutilizar' && otra.estado === 'requiere_nueva' && e.escrituras.length === 0, '3d. Evaluar no escribe nada')
  }

  console.log('== 4. Cliente y pantalla')
  const servicio = leer('lib/asistente/AsistenteService.ts')
  const metodo = servicio.slice(servicio.indexOf('async continuarPlaneacion('), servicio.indexOf('\n  abrirPanel() {'))
  verificar(/if \(this\.generando \|\| this\.reservaEnvio\) return 'ocupado'/.test(metodo) && metodo.indexOf("pedir(actual, 'evaluar')") < metodo.indexOf('this.nuevaConversacion()') && metodo.indexOf('this.nuevaConversacion()') < metodo.indexOf("pedir(remota, 'abrir')"),
    '4a. Con una respuesta en curso no hace nada; evalúa la conversación actual antes de abrir una nueva')
  verificar(/await this\.traerMensajeCanonico\(local, apertura\.mensajeId\)/.test(metodo) && /this\.abrirPanel\(\)/.test(metodo), '4b. Incorpora el contexto por el mismo camino de los mensajes del servidor y abre el único Chat')
  verificar(!/enviarMensaje|enviarComoEdicion|motor|\/api\/chat'/.test(metodo), '4c. No envía mensajes ni llama al motor de IA')
  const codigo = (leer('lib/planeacion/continuarEnChat.ts') + leer('app/api/planeaciones/versiones/[id]/chat/route.ts')).replace(/^\s*\/\/.*$/gm, '')
  verificar(!/anthropic|motorTexto|generateText|streamText|openai|clasificar/i.test(codigo) && !/SERVICE_ROLE|clienteServidor/.test(codigo), '4d. Ruta sin IA y con la RLS del docente (sin service role)')
  const { default: DetallePlaneacion } = await import('../components/Planeacion/DetallePlaneacion')
  const detalle = { id: P, nombre: 'X', fechaInicio: null, fechaFin: null, versionVigente: 4, versiones: [{ id: V(2), numero: 2, origen: 'modificacion', contenido: null, estructura: null, hoja: null, tieneWord: false, tienePdf: false, creadaEn: '2026-11-25T00:00:00Z' }] }
  const html = renderToStaticMarkup(<DetallePlaneacion detalle={detalle} version={detalle.versiones[0]} onSeleccionarVersion={() => {}} estadosHoja={{}} evaluacionDistinta={null} onArchivoGenerado={() => {}} onContinuarEnChat={async () => null} />)
  verificar(html.includes('Continuar en el Chat IA') && html.includes('Versión histórica'), '4e. Acción discreta en el detalle, también en una versión histórica')

  console.log(`\n${total - fallos}/${total} pruebas pasaron.`)
  if (fallos) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
