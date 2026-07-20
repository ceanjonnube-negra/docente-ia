// lib/documentGen/encabezadoDocumento.ts
//
// Fuente única de los datos del encabezado y pie institucional —
// escuela, docente, grado, grupo, lugar, fecha, ciclo escolar — para
// CUALQUIER documento oficial (lista, planeación, oficio, reporte,
// ficha...). generarWordServidor.ts y generarPdfServidor.ts llaman
// aquí en vez de armar cada uno su propio texto: son librerías
// distintas (docx vs pdf-lib) que no pueden compartir un componente de
// render literal, pero SÍ comparten esta misma preparación de datos —
// así el encabezado nunca puede divergir entre Word y PDF, ni
// duplicarse (antes también lo escribía Claude en el cuerpo del
// documento — ver regla 9 de MODO DOCUMENTO en app/api/chat/route.ts,
// ahora se lo prohíbe explícitamente).

import { obtenerFechaHora } from '../tiempo/TimeService'

export type EncabezadoDocumento = {
  escuela: string
  docente: string
  // Ya incluyen el símbolo real cuando aplica (el selector de
  // onboarding guarda "3°", no "3" — ver app/onboarding/page.tsx) así
  // que nunca se le debe concatenar un "°" extra al usarlos.
  grado: string
  grupo: string
  lugar: string
  fecha: string
  cicloEscolar: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function prepararEncabezado(perfil: any, zonaHoraria: string | null | undefined): EncabezadoDocumento {
  const { fechaLegible, cicloEscolar } = obtenerFechaHora(zonaHoraria)
  const lugar = [perfil?.municipio, perfil?.estado].filter(Boolean).join(', ')

  return {
    escuela: perfil?.escuela || 'Escuela',
    docente: perfil?.nombre || 'Docente',
    grado: perfil?.grado || '',
    grupo: perfil?.grupo || '',
    lugar,
    fecha: fechaLegible,
    cicloEscolar,
  }
}
