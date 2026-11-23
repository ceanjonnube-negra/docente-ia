// scripts/verificar-grupo-historial-documentos.ts
//
// documentos_generados registra el grado y grupo con los que se generó el
// archivo —el grupo de la conversación, resuelto con perfilConGrupoAcademico,
// el mismo del encabezado institucional—, no el grupo por defecto del perfil.
// Sin grupo confirmado (o sin archivo), no se inventa ninguno. Caso real:
// docente con 3.º B y 4.º B y perfil 4.º B, trabajando en 3.º B.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-grupo-historial-documentos.ts`.

import { readFileSync } from 'node:fs'
import { documentoParaHistorial, AVISO_ARCHIVO_GENERADO } from '../lib/asistente/documentos'
import { perfilConGrupoAcademico, prepararEncabezado } from '../lib/documentGen/encabezadoDocumento'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

const AVISO = '📢 AVISO PARA FAMILIAS\n\nEstimadas familias: lean cada día en casa.'
const perfil4B = { escuela: 'Escuela Primaria Ficticia', nombre: 'Docente Prueba', grado: '4°', grupo: 'B' }
// Lo que hace herramientas.ts con el perfil que recibe (el mismo del encabezado).
const grupoDelArchivo = (perfil: { grado?: string; grupo?: string }) => ({ grado: String(perfil?.grado ?? '').trim(), grupo: String(perfil?.grupo ?? '').trim() })
const entregar = (perfilResuelto: { grado?: string; grupo?: string }) =>
  documentoParaHistorial(AVISO_ARCHIVO_GENERADO, { contenidoOriginal: AVISO, archivos: [{ tipo: 'word', nombre: 'Aviso.docx', url: 'https://ejemplo.invalid', grupoAcademico: grupoDelArchivo(perfilResuelto) }] })

// 1. Multigrupo: conversación de 3.º B con perfil 4.º B.
const perfil3B = perfilConGrupoAcademico(perfil4B, { grado: '3', grupo: 'B' })
const doc3B = entregar(perfil3B)
verificar(doc3B?.grupo.grado === '3°' && doc3B.grupo.grupo === 'B', '1a. Conversación de 3.º B → el historial registra 3° B, no el 4° B del perfil')
const enc3B = prepararEncabezado(perfil3B, 'America/Mazatlan')
verificar(enc3B.grado === doc3B?.grupo.grado && enc3B.grupo === doc3B?.grupo.grupo, '1b. Mismo grado y grupo que el encabezado institucional del archivo')
const doc4B = entregar(perfilConGrupoAcademico(perfil4B, { grado: '4', grupo: 'B' }))
verificar(doc4B?.grupo.grado === '4°' && doc4B.grupo.grupo === 'B', '1c. Conversación de 4.º B → 4° B')

// 2. Sin grupo confirmado: no se inventa.
const sinGrupo = entregar(perfilConGrupoAcademico(perfil4B, { grado: null, grupo: null }))
verificar(sinGrupo?.grupo.grado === null && sinGrupo.grupo.grupo === null, '2a. Sin grupo confirmado → grado y grupo vacíos (null), nunca los del perfil')
const sinArchivoNuevo = documentoParaHistorial(AVISO_ARCHIVO_GENERADO, { contenidoOriginal: AVISO, archivos: [{ tipo: 'word', nombre: 'Aviso.docx', url: 'https://ejemplo.invalid' }] })
verificar(sinArchivoNuevo?.grupo.grado === null && sinArchivoNuevo.grupo.grupo === null, '2b. Archivo sin grupoAcademico (anterior a este cambio) → null')
const textual = documentoParaHistorial('📨 CITATORIO\n\nEstimados padres de familia: reunión el viernes.')
verificar(textual?.origen === 'texto' && textual.grupo.grado === null && textual.grupo.grupo === null, '2c. Documento textual sin archivo (sin grupo confirmado por el servidor) → null')

// 3. Código: una sola resolución de grupo, reutilizada.
const herramientas = readFileSync('lib/documentGen/herramientas.ts', 'utf8')
verificar(herramientas.includes("const grupoAcademico = { grado: String(perfil?.grado ?? '').trim(), grupo: String(perfil?.grupo ?? '').trim() }")
  && herramientas.includes('return { tipo, nombre, url, tamanoBytes: buffer.length, urlVer, archivoId, grupoAcademico }'),
  '3a. El archivo devuelve el grupo del mismo perfil con el que se armó su encabezado')
const ruta = readFileSync('app/api/chat/route.ts', 'utf8')
const llamadas = ruta.match(/ejecutarHerramientaDocumento\([^\n]*/g) ?? []
verificar(llamadas.length === 3 && (ruta.match(/perfilConGrupoAcademico\(/g) ?? []).length >= 3
  && llamadas.every((l) => /, (perfil|perfilConGrupoAcademico\(perfilLista[^)]*\)), zonaHoraria,/.test(l)),
  '3b. Todas las generaciones del Chat pasan el perfil ya resuelto con perfilConGrupoAcademico')
const motor = readFileSync('lib/asistente/motores/motorTextoClaude.ts', 'utf8')
const guardar = motor.slice(motor.indexOf('private async guardarEnHistorial'), motor.indexOf('private async guardarEnHistorial') + 900)
verificar(guardar.includes('grado: documento.grupo.grado,') && guardar.includes('grupo: documento.grupo.grupo,') && !/grado: perfil\?\.grado|grupo: perfil\?\.grupo/.test(guardar),
  '3c. guardarEnHistorial ya no toma grado y grupo del perfil')
verificar(/\.insert\(\{/.test(guardar) && !/\.update\(|\.delete\(|\.upsert\(/.test(guardar), '3d. Solo inserta el documento nuevo: los registros históricos no se tocan')

console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} verificación(es) fallaron`)
process.exit(fallos === 0 ? 0 : 1)
