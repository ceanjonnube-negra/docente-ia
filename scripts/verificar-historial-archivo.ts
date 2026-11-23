// scripts/verificar-historial-archivo.ts
//
// B2 — documentos_generados guarda el archivo ORIGINAL con el que nació cada
// documento nuevo (archivo_id, archivo_formato) y Historial lo abre o
// descarga con la recuperación segura de B1, sin regenerarlo. Los registros
// anteriores conservan la alternativa de generar un Word desde el texto,
// identificada como tal. La integridad del vínculo (mismo docente) la
// impone la migración; aquí se comprueba su contenido.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-historial-archivo.ts`.

import { readFileSync } from 'node:fs'
import { AVISO_ARCHIVO_GENERADO, documentoParaHistorial } from '../lib/asistente/documentos'

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://proyecto.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'clave-ficticia'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

const AVISO = '📢 AVISO PARA FAMILIAS\n\nEstimadas familias: lean cada día en casa.'
const ID = '0f9c2a44-1b2c-4d3e-8f00-123456789abc'
const archivo = (extra: Record<string, unknown>) => ({ nombre: 'Aviso.docx', url: 'https://ejemplo.invalid', ...extra })

async function main() {
  // 1. Guardado del vínculo.
  const word = documentoParaHistorial(AVISO_ARCHIVO_GENERADO, { contenidoOriginal: AVISO, archivos: [archivo({ tipo: 'word', archivoId: ID })] })
  verificar(word?.origen === 'archivo' && word.archivo?.id === ID && word.archivo.formato === 'word', '1a. Documento nuevo con archivo registrado → archivo_id y archivo_formato (word)')
  const pdf = documentoParaHistorial(AVISO_ARCHIVO_GENERADO, { contenidoOriginal: AVISO, archivos: [archivo({ tipo: 'pdf', archivoId: ID }), archivo({ tipo: 'word', archivoId: '11111111-1111-4111-8111-111111111111' })] })
  verificar(pdf?.archivo?.id === ID && pdf.archivo.formato === 'pdf', '1b. Con varios archivos, el vínculo es el archivo principal (el primero entregado)')
  verificar(documentoParaHistorial(AVISO_ARCHIVO_GENERADO, { contenidoOriginal: AVISO, archivos: [archivo({ tipo: 'word' })] })?.archivo === null,
    '1c. Archivo sin registro (sin archivoId) → sin vínculo; el documento se guarda igual')
  verificar(documentoParaHistorial(AVISO_ARCHIVO_GENERADO, { contenidoOriginal: AVISO, archivos: [archivo({ tipo: 'word', archivoId: 'no-es-uuid' })] })?.archivo === null
    && documentoParaHistorial(AVISO_ARCHIVO_GENERADO, { contenidoOriginal: AVISO, archivos: [archivo({ tipo: 'imagen', archivoId: ID })] })?.archivo === null,
    '1d. archivoId inválido o formato no soportado → sin vínculo (nunca se inventa)')
  const textual = documentoParaHistorial('📨 CITATORIO\n\nEstimados padres de familia: reunión el viernes.')
  verificar(textual?.origen === 'texto' && textual.archivo === null, '1e. Documento textual sin archivo → sin vínculo')
  verificar(documentoParaHistorial(AVISO_ARCHIVO_GENERADO, { archivos: [archivo({ tipo: 'pdf', archivoId: ID })] }) === null,
    '1f. Conversión (archivo sin contenido nuevo) → ningún registro adicional')

  const motor = readFileSync('lib/asistente/motores/motorTextoClaude.ts', 'utf8')
  const guardar = motor.slice(motor.indexOf('private async guardarEnHistorial'), motor.indexOf('private async guardarEnHistorial') + 1200)
  verificar((guardar.match(/\.insert\(\{/g) ?? []).length === 1 && guardar.includes('archivo_id: documento.archivo?.id ?? null,') && guardar.includes('archivo_formato: documento.archivo?.formato ?? null,')
    && !/\.update\(|\.upsert\(|\.delete\(/.test(guardar),
    '1g. El vínculo va en el MISMO insert de siempre; sin updates ni registros extra')

  // 2. Migración aditiva (validada además en un PostgreSQL 17 local desechable).
  const migracion = readFileSync('supabase/migrations/20261124000000_documentos_generados_archivo.sql', 'utf8').replace(/--.*$/gm, '')
  verificar(/add constraint archivos_generados_id_docente_unico unique \(id, docente_id\)/.test(migracion)
    && /foreign key \(archivo_id, user_id\) references public\.archivos_generados \(id, docente_id\)\s*on delete no action;/.test(migracion),
    '2a. FK compuesta (archivo_id, user_id) → (id, docente_id): no se puede vincular el archivo de otro docente; ON DELETE NO ACTION')
  verificar(/archivo_formato in \('word', 'pdf', 'powerpoint', 'excel'\)/.test(migracion) && /check \(\(archivo_id is null\) = \(archivo_formato is null\)\)/.test(migracion),
    '2b. Formato acotado; archivo_id y archivo_formato van juntos (los dos o ninguno)')
  verificar(!/\b(update|delete|insert|grant|revoke|truncate)\b/i.test(migracion.replace(/has_table_privilege\([^)]*\)/g, '').replace(/on delete no action/gi, '').replace(/privilege_type/g, '')),
    '2c. La migración no modifica datos ni permisos')

  // 3. Historial: acciones del original con la recuperación de B1.
  const { accionesArchivoOriginal, modosRecuperacion } = await import('../lib/asistente/recuperacionArchivo')
  verificar(JSON.stringify(accionesArchivoOriginal('pdf')) === JSON.stringify([{ modo: 'ver', etiqueta: '👁️ Ver PDF' }, { modo: 'descargar', etiqueta: '⬇️ Descargar PDF' }]), '3a. PDF → Ver PDF y Descargar PDF')
  verificar(['word', 'powerpoint', 'excel'].every((f) => JSON.stringify(accionesArchivoOriginal(f)) === JSON.stringify([{ modo: 'descargar', etiqueta: '⬇️ Descargar original' }])),
    '3b. Word y demás formatos → solo Descargar original')
  verificar(accionesArchivoOriginal(null).length === 0 && accionesArchivoOriginal('docx').length === 0, '3c. Sin formato conocido → ninguna acción de original')
  verificar(modosRecuperacion('pdf').join() === 'ver,descargar' && modosRecuperacion('word').join() === 'descargar', '3d. Misma regla de modos que las tarjetas del Chat')
  const historial = readFileSync('app/dashboard/historial/page.tsx', 'utf8')
  verificar(historial.includes("import { accionesArchivoOriginal, accionesArchivosOriginales, pdfOriginalDePlaneacion, recuperarArchivo, type ArchivoOriginalDocumento } from '@/lib/asistente/recuperacionArchivo'") && !historial.includes('AsistentePanel'),
    '3e. Historial usa la utilidad compartida, no importa AsistentePanel')
  verificar(historial.includes('seleccionado.archivo_id && accionesArchivoOriginal(seleccionado.archivo_formato).length > 0 ? (')
    && historial.includes('recuperarArchivo({ archivoId: a.archivoId }, a.modo, avisarFallaArchivo)'),
    '3f. Con archivo original: el endpoint autenticado de B1 por archivoId')
  const conOriginal = historial.slice(historial.indexOf('seleccionado.archivo_id && accionesArchivoOriginal'), historial.indexOf(') : (', historial.indexOf('seleccionado.archivo_id && accionesArchivoOriginal')))
  verificar(!conOriginal.includes('generarWord'), '3g. Con archivo original no se usa el generador antiguo')
  verificar(historial.includes('Generar Word desde el texto') && historial.includes('No es el archivo original') && !historial.includes('>\n              Descargar Word\n'),
    '3h. Sin archivo original: la alternativa se identifica como Word generado desde el texto')

  // 4. Utilidad compartida y recuperación de B1 intactas.
  const panel = readFileSync('components/Asistente/AsistentePanel.tsx', 'utf8')
  verificar(panel.includes("from '@/lib/asistente/recuperacionArchivo'") && !/async function tokenSesionVigente|function enviarFormularioRecuperacion|export function recuperarArchivo/.test(panel),
    '4a. El panel usa la misma utilidad: sin mecanismos duplicados')
  const ruta = readFileSync('app/api/archivos/descargar/route.ts', 'utf8')
  verificar(ruta.includes('recuperarArchivoPropio(auth.user.id, referencia)') && ruta.includes("if (datos.has('token')) return recuperarAutenticado(datos)"),
    '4b. El endpoint autenticado de B1 no cambia (propiedad, estado, bucket y carpeta del docente)')

  // 5. Hito 1, Parte 3 — ambos originales de una planeación aprobada
  //    desde su ÚNICO registro (vinculado al Word), sin registros extra.
  const { pdfOriginalDePlaneacion, accionesArchivosOriginales } = await import('../lib/asistente/recuperacionArchivo')
  const WORD = '0f9c2a44-1b2c-4d3e-8f00-000000000001', PDF = '0f9c2a44-1b2c-4d3e-8f00-000000000002'
  type FilaPP = { docente: string; evaluacion: unknown }
  // Doble con RLS: solo las filas del docente de la sesión; filtro JSON por documento_word.archivo_id.
  const conRls = (filas: FilaPP[], docente: string, fallar = false) => ({
    from: (tabla: string) => ({
      select: () => ({
        eq: (col: string, val: string) => ({
          limit: async () => {
            if (fallar) throw new Error('red caída')
            if (tabla !== 'planeacion_proyectos' || col !== 'evaluacion->documento_word->>archivo_id') return { data: [], error: null }
            return { data: filas.filter((f) => f.docente === docente && (f.evaluacion as { documento_word?: { archivo_id?: string } })?.documento_word?.archivo_id === val).map((f) => ({ evaluacion: f.evaluacion })), error: null }
          },
        }),
      }),
    }),
  }) as unknown as Parameters<typeof pdfOriginalDePlaneacion>[0]
  const filas: FilaPP[] = [{ docente: 'docente-1', evaluacion: { documento_word: { archivo_id: WORD }, documento_pdf: { archivo_id: PDF } } }]
  const pdfOriginal = await pdfOriginalDePlaneacion(conRls(filas, 'docente-1'), WORD)
  verificar(pdfOriginal?.archivoId === PDF && pdfOriginal.formato === 'pdf', '5a. Desde el registro del Word se ubica el PDF original de la misma planeación')
  verificar(await pdfOriginalDePlaneacion(conRls(filas, 'docente-2'), WORD) === null, '5b. Otro docente: RLS no devuelve la planeación → ningún PDF')
  verificar(await pdfOriginalDePlaneacion(conRls(filas, 'docente-1'), 'no-es-uuid') === null && await pdfOriginalDePlaneacion(conRls(filas, 'docente-1', true), WORD) === null,
    '5c. Id inválido o error de red → ningún PDF (nunca se inventa)')
  const raros: FilaPP[] = [{ docente: 'docente-1', evaluacion: { documento_word: { archivo_id: WORD }, documento_pdf: { archivo_id: 'x' } } }, { docente: 'docente-1', evaluacion: { documento_word: { archivo_id: WORD }, documento_pdf: { archivo_id: WORD } } }]
  verificar(await pdfOriginalDePlaneacion(conRls([raros[0]], 'docente-1'), WORD) === null && await pdfOriginalDePlaneacion(conRls([raros[1]], 'docente-1'), WORD) === null,
    '5d. Metadatos sin PDF válido o con el mismo archivo → ningún PDF')
  const dos = accionesArchivosOriginales([{ archivoId: WORD, formato: 'word' }, { archivoId: PDF, formato: 'pdf' }])
  verificar(JSON.stringify(dos.map((a) => [a.etiqueta, a.modo, a.archivoId])) === JSON.stringify([['👁️ Ver PDF', 'ver', PDF], ['⬇️ Descargar PDF', 'descargar', PDF], ['⬇️ Descargar Word', 'descargar', WORD]]),
    '5e. Word y PDF: Ver y Descargar PDF, y Descargar Word, cada acción con SU archivo')
  verificar(JSON.stringify(accionesArchivosOriginales([{ archivoId: WORD, formato: 'word' }]).map((a) => a.etiqueta)) === JSON.stringify(['⬇️ Descargar original'])
    && accionesArchivosOriginales([{ archivoId: WORD, formato: 'word' }, { archivoId: WORD, formato: 'word' }]).length === 1
    && accionesArchivosOriginales([{ archivoId: 'x', formato: 'pdf' }]).length === 0,
    '5f. Un solo archivo: las acciones de siempre; duplicados o ids inválidos no añaden acciones')
  const fuente = readFileSync('lib/asistente/recuperacionArchivo.ts', 'utf8')
  const bloque = fuente.slice(fuente.indexOf('export async function pdfOriginalDePlaneacion'), fuente.indexOf('export function accionesArchivosOriginales'))
  verificar(!/\.insert\(|\.update\(|\.upsert\(|\.delete\(|generar/i.test(bloque) && !/\.insert\(|\.update\(/.test(historial.slice(historial.indexOf('pdfOriginalDePlaneacion(supabase'))),
    '5g. Sin registros adicionales ni regeneración: solo una lectura bajo RLS')
  verificar(historial.includes("seleccionado.archivo_formato !== 'word'") && historial.includes('complementario.de === seleccionado?.archivo_id'),
    '5h. Solo se busca el PDF de un registro con Word original, y nunca se muestra el de otro documento')

  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} verificación(es) fallaron`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
