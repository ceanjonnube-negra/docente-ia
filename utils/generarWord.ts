// utils/generarWord.ts
//
// Generación de Word EN EL NAVEGADOR — usada por el botón "Word" de la
// tarjeta de documento para el texto ya visible en el chat (documentos
// creados antes de la herramienta real de servidor, o cualquier mensaje
// con formato MODO DOCUMENTO). La construcción del documento vive en
// lib/documentGen/construirDocumentoWord.ts, compartida con el generador
// de servidor (lib/documentGen/generarWordServidor.ts) — aquí solo se
// empaqueta a Blob y se dispara la descarga, que es lo único que de
// verdad es específico del navegador.

import { Packer } from 'docx'
import { saveAs } from 'file-saver'
import { construirDocumentoWord, nombreArchivoWord } from '@/lib/documentGen/construirDocumentoWord'
import { obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const generarWord = async (texto: string, perfil?: any) => {
  const doc = construirDocumentoWord(texto, perfil, obtenerZonaHorariaDispositivo())
  const blob = await Packer.toBlob(doc)
  saveAs(blob, nombreArchivoWord(perfil))
}
