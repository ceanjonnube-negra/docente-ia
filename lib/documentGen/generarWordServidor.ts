// lib/documentGen/generarWordServidor.ts
//
// Genera el .docx REAL en el servidor (Node) — a diferencia de
// utils/generarWord.ts (navegador), esto corre dentro de la ejecución de
// la herramienta generar_documento_word (ver app/api/chat/route.ts) y
// nunca depende de que el docente toque un botón: el archivo ya existe
// en Storage antes de que la respuesta llegue al chat.

import { Packer } from 'docx'
import { construirDocumentoWord } from './construirDocumentoWord'
import { prepararEncabezado, quitarDuplicadosInstitucionales } from './encabezadoDocumento'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generarWordBuffer(texto: string, perfil: any, zonaHoraria: string | null): Promise<Buffer> {
  // El encabezado institucional lo agrega el documento: se quitan sus
  // duplicados inequívocos del texto (ver encabezadoDocumento.ts).
  const limpio = quitarDuplicadosInstitucionales(texto, prepararEncabezado(perfil, zonaHoraria))
  const doc = construirDocumentoWord(limpio, perfil, zonaHoraria)
  return Packer.toBuffer(doc)
}

export function nombreArchivoWordServidor(titulo: string): string {
  const slug = titulo
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Documento'
  return `${slug}.docx`
}
