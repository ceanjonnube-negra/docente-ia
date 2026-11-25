// scripts/verificar-historial-documentos.ts
//
// Historial de documentos (documentos_generados):
//   - Al guardar, mandan los metadatos de entrega del servidor
//     ([[DOCUMENTO_ARCHIVO]] / [[DOCUMENTO_CONTENIDO]]) → origen 'archivo';
//     un documento formal textual → origen 'texto'; una conversación no se
//     guarda.
//   - Al leer, una sola regla para Chat e Historial: origen válido, o
//     registro histórico (origen NULL) con prefijo canónico.
//   - Los registros antiguos se conservan intactos; la migración solo
//     agrega la columna.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-historial-documentos.ts`.

import { readFileSync } from 'node:fs'
import {
  documentoParaHistorial,
  documentosDelHistorial,
  esDocumentoDelHistorial,
  esDocumentoFormal,
  FILTRO_DOCUMENTOS_HISTORIAL,
  ORIGENES_DOCUMENTO,
  PATRON_TITULO_DOCUMENTO_SQL,
} from '../lib/asistente/documentos'
import { documentosDelDocente } from '../lib/motorContexto'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

const SALUDO = '¡Hola, maestra! ¿En qué te ayudo hoy?'
const CONSULTA_ALUMNOS = 'El grupo 4.º B tiene 28 alumnos. Hoy faltaron 3: Ana, Luis y Sofía.'
const CITATORIO = '📨 CITATORIO\n\nEstimados padres de familia:\n- Fecha: 12 de noviembre\n- Hora: 8:00'
const PLANEACION = '📋 PLANEACIÓN DIDÁCTICA\n\nCampo Formativo: Lenguajes\nGrado: 4.º'
const SIN_PREFIJO = 'Aviso para padres de familia\n\nReunión el viernes a las 8:00 en el aula de 4.º B.'
const AVISO_ARCHIVO = 'Documento generado correctamente.'
const ARCHIVO = { tipo: 'pdf', nombre: 'aviso.pdf', url: 'https://ejemplo.invalid/a.pdf' }
// Registro antiguo largo y ambiguo (sin prefijo canónico): debe conservarse en la base.
const AMBIGUO_LARGO = '📢 Aviso para padres de familia\n\n' + 'Les informamos sobre la próxima reunión. '.repeat(60)

// Emulación independiente del filtro SQL (misma semántica que PostgREST).
const comoJs = new RegExp(PATRON_TITULO_DOCUMENTO_SQL.replaceAll('[[:space:]]', '\\s'))
const filtroSql = (f: { origen?: string | null; contenido?: string | null }) =>
  f.origen != null ? ['archivo', 'texto'].includes(f.origen) : comoJs.test(f.contenido ?? '')

// Cliente de Supabase simulado: guarda inserts y responde consultas.
function clienteSimulado(tabla: Record<string, unknown>[]) {
  const llamadas: unknown[][][] = []
  return {
    llamadas,
    from: () => {
      const ops: unknown[][] = []
      llamadas.push(ops)
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'or', 'filter', 'order', 'limit']) c[m] = (...a: unknown[]) => { ops.push([m, ...a]); return c }
      c.then = (r: (v: unknown) => void) => {
        const usaRegla = ops.some((o) => o[0] === 'or' && o[1] === FILTRO_DOCUMENTOS_HISTORIAL)
        const filas = (tabla as { origen?: string | null; contenido?: string | null }[]).filter((f) => !usaRegla || filtroSql(f))
        r({ data: filas, count: filas.length, error: null })
      }
      return c
    },
  }
}

async function main() {
  // 1. Qué se guarda (y con qué origen).
  verificar(documentoParaHistorial(SALUDO) === null, '1a. Un saludo no se guarda como documento')
  verificar(documentoParaHistorial(CONSULTA_ALUMNOS) === null, '1b. Una consulta sobre alumnos no se guarda como documento')
  verificar(documentoParaHistorial(SALUDO, { archivos: [] }) === null && documentoParaHistorial(CONSULTA_ALUMNOS, { contenidoOriginal: undefined }) === null,
    '1c. Sin archivo, ni un saludo ni una consulta se guardan aunque lleguen metadatos vacíos')
  const textual = documentoParaHistorial(CITATORIO)
  verificar(textual?.contenido === CITATORIO && textual.origen === 'texto', "1d. Documento formal textual → se guarda su texto con origen 'texto'")
  const conArchivo = documentoParaHistorial(AVISO_ARCHIVO, { archivos: [ARCHIVO], contenidoOriginal: PLANEACION })
  verificar(conArchivo?.contenido === PLANEACION && conArchivo.origen === 'archivo', "1e. Documento entregado como archivo → su texto real (no el aviso), origen 'archivo'")
  verificar(documentoParaHistorial(AVISO_ARCHIVO, { archivos: [ARCHIVO] }) === null && documentoParaHistorial(CITATORIO, { archivos: [ARCHIVO] }) === null,
    '1f. Archivo de un documento ya existente (conversión, planeación aprobada) → no se duplica')

  // 2. Caso específico: documento nuevo SIN prefijo, con archivo y contenido válido.
  const nuevo = documentoParaHistorial(AVISO_ARCHIVO, { archivos: [ARCHIVO], contenidoOriginal: SIN_PREFIJO })
  verificar(!esDocumentoFormal(SIN_PREFIJO) && nuevo?.origen === 'archivo' && nuevo.contenido === SIN_PREFIJO,
    "2a. Documento sin prefijo + archivo + contenido → se guarda con origen='archivo' y su contenido intacto")
  const historicos: Record<string, unknown>[] = [
    { id: 'h1', contenido: CITATORIO, tipo: 'citatorio', origen: null },
    { id: 'h2', contenido: SALUDO, tipo: 'documento', origen: null },
    { id: 'h3', contenido: AMBIGUO_LARGO, tipo: 'documento', origen: null },
    { id: 'h4', contenido: PLANEACION, tipo: 'planeacion', origen: null },
    { id: 'h5', contenido: CONSULTA_ALUMNOS, tipo: 'documento', origen: null },
  ]
  const copia = JSON.stringify(historicos)
  const tabla = [...historicos, { id: 'n1', contenido: nuevo!.contenido, tipo: 'documento', origen: nuevo!.origen, titulo: 'Aviso para padres de familia', created_at: '2026-11-23T10:00:00Z' }]
    .map((f) => ({ titulo: `Doc ${f.id}`, created_at: '2026-11-20T10:00:00Z', ...f }))
  const sb = clienteSimulado(tabla)
  const chat = await documentosDelDocente(sb as never, 'docente-1')
  const pantalla = documentosDelHistorial(tabla as unknown as { id: string; titulo: string; origen?: string | null; contenido?: string | null }[])
  verificar(chat.recientes.some((r) => r.titulo === 'Aviso para padres de familia'), '2b. El documento nuevo sin prefijo aparece en la consulta del Chat')
  verificar(pantalla.some((f) => f.id === 'n1'), '2c. El documento nuevo sin prefijo aparece en Historial')

  // 3. Una sola regla de lectura, igual en Chat e Historial.
  verificar(pantalla.map((f) => f.id).join() === 'h1,h4,n1', '3a. Historial: los 2 históricos con prefijo y el nuevo; ni saludos, ni consultas, ni el ambiguo')
  verificar(chat.total === pantalla.length && chat.recientes.map((r) => r.titulo).sort().join() === pantalla.map((f) => f.titulo).sort().join(),
    `3b. Chat e Historial coinciden: ${chat.total} documentos, los mismos`)
  verificar(sb.llamadas.length === 1 && sb.llamadas[0].some((o) => o[0] === 'or' && o[1] === FILTRO_DOCUMENTOS_HISTORIAL)
    && sb.llamadas[0].some((o) => o[0] === 'eq' && o[1] === 'user_id' && o[2] === 'docente-1'),
    '3c. La consulta del Chat hace una sola lectura del docente con FILTRO_DOCUMENTOS_HISTORIAL')
  verificar(FILTRO_DOCUMENTOS_HISTORIAL === `origen.in.(archivo,texto),and(origen.is.null,contenido.match."${PATRON_TITULO_DOCUMENTO_SQL}")`,
    '3d. El filtro SQL es exactamente: origen válido, u origen nulo con prefijo canónico')
  const casos = [
    { origen: 'archivo', contenido: SIN_PREFIJO }, { origen: 'texto', contenido: CITATORIO }, { origen: 'otro', contenido: CITATORIO },
    { origen: null, contenido: CITATORIO }, { origen: null, contenido: SALUDO }, { origen: null, contenido: AMBIGUO_LARGO }, { origen: undefined, contenido: null },
  ]
  verificar(casos.every((f) => esDocumentoDelHistorial(f) === filtroSql(f)), '3e. esDocumentoDelHistorial (Historial) y el filtro SQL (Chat) clasifican igual')
  verificar(casos.every((m) => comoJs.test(m.contenido ?? '') === esDocumentoFormal(m.contenido ?? '')), '3f. El patrón SQL del prefijo equivale a esDocumentoFormal')

  // 4. Registros históricos intactos y responsabilidades sin cambios.
  verificar(JSON.stringify(historicos) === copia, '4a. Clasificar no modifica ningún registro histórico (el ambiguo sigue en los datos)')
  const migracion = readFileSync('supabase/migrations/20261123000000_documentos_generados_origen.sql', 'utf8')
  const sentencias = migracion.replace(/--.*$/gm, '')
  verificar(/alter table public\.documentos_generados\s+add column origen text null\s+constraint documentos_generados_origen_check check \(origen in \('archivo', 'texto'\)\)/.test(sentencias),
    "4b. La migración solo agrega origen text NULL con CHECK ('archivo', 'texto')")
  verificar(!/\b(update|delete|insert|drop|grant|revoke|truncate)\b/i.test(sentencias.replace(/has_table_privilege\('[^']+', '[^']+', '[^']+'\)/g, '').replace(/on commit drop/g, '')),
    '4c. La migración no toca datos, permisos ni otras estructuras')
  verificar(ORIGENES_DOCUMENTO.join() === 'archivo,texto', '4d. Los orígenes del código coinciden con el CHECK de la migración')
  const motor = readFileSync('lib/asistente/motores/motorTextoClaude.ts', 'utf8')
  verificar(/const documento = documentoParaHistorial\(respuestaLimpia, \{ contenidoOriginal, archivos, recuperado \}\)\s*\n\s*if \(user && documento\) await this\.guardarEnHistorial\(documento, perfil, user\.id\)/.test(motor)
    && motor.includes('origen: documento.origen,') && (motor.match(/guardarEnHistorial\(/g) || []).length === 2,
    '4e. El motor guarda solo lo que devuelve documentoParaHistorial, con su origen, en un único punto')
  verificar(!motor.includes('archivos_generados'), '4f. El historial no escribe en archivos_generados (cada tabla conserva su responsabilidad)')
  const historial = readFileSync('app/dashboard/historial/page.tsx', 'utf8')
  verificar(historial.includes('documentosDelHistorial(documentos)') && !/sin_clasificar|Sin clasificar/.test(historial),
    '4g. Historial usa la regla única, sin pestaña de registros sin clasificar')
  const consulta = readFileSync('lib/motorContexto.ts', 'utf8').split('export async function documentosDelDocente')[1].split('\nexport ')[0]
  verificar(!/\.(insert|update|upsert|delete)\(/.test(consulta), '4h. La consulta del Chat no escribe ni borra')
  const persistencia = readFileSync('lib/asistente/persistencia.ts', 'utf8')
  verificar(persistencia.includes('texto.match."${PATRON_TITULO_DOCUMENTO_SQL}"'), '4i. El índice documental reutiliza el mismo patrón')

  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} verificación(es) fallaron`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
