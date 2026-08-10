// lib/documentGen/perfilNivelEducativo.ts
//
// Ver "Ilustraciones por nivel educativo, Fase 1". Perfil
// pedagógico-visual estático por nivel — puro, sin red, sin IA. Reusa
// EstiloVisual de lib/imageGen/reglasVisuales.ts (ya existía, ya lo
// entiende construirPromptFinal) en vez de crear un enum paralelo.
//
// `maxIlustracionesSugeridas` es INFORMATIVO en esta fase — todavía
// NO sustituye a MAX_IMAGENES_POR_DOCUMENTO (herramientas.ts), que
// sigue fijo en 4 para todos los niveles a propósito (ver riesgos del
// diseño aprobado: ajustar el tope real es una fase posterior).

import type { EstiloVisual } from '../imageGen/reglasVisuales'
import type { NivelEducativo } from './nivelEducativo'

export type PerfilNivelEducativo = {
  nivel: NivelEducativo
  etiqueta: string
  tono: string
  densidadTexto: 'muy_baja' | 'baja' | 'media' | 'media_alta' | 'alta'
  tiposActividadSugeridos: string[]
  estiloVisual: EstiloVisual
  maxIlustracionesSugeridas: number
  instruccionRedaccion: string
}

const PERFILES: Record<NivelEducativo, PerfilNivelEducativo> = {
  preescolar: {
    nivel: 'preescolar',
    etiqueta: 'Preescolar',
    tono: 'muy simple, cálido, una sola instrucción a la vez',
    densidadTexto: 'muy_baja',
    tiposActividadSugeridos: ['colorear', 'unir con línea', 'observar', 'señalar', 'rodear', 'contar', 'identificar'],
    estiloVisual: 'infantil',
    maxIlustracionesSugeridas: 4,
    instruccionRedaccion:
      'Usa frases muy cortas (máximo 8-10 palabras), una sola instrucción por actividad, vocabulario cotidiano y concreto. Mucho espacio visual entre elementos. Nunca texto denso ni párrafos largos.',
  },
  primaria_baja: {
    nivel: 'primaria_baja',
    etiqueta: 'Primaria baja (1° y 2°)',
    tono: 'sencillo, claro, cercano',
    densidadTexto: 'baja',
    tiposActividadSugeridos: ['completar', 'relacionar', 'dibujar', 'responder corto', 'opción múltiple simple'],
    estiloVisual: 'ilustrado-amigable',
    maxIlustracionesSugeridas: 4,
    instruccionRedaccion:
      'Instrucciones muy claras y breves, oraciones simples, apoyo visual en cada sección importante. Diseño limpio, atractivo e infantil sin ser excesivo.',
  },
  primaria_media: {
    nivel: 'primaria_media',
    etiqueta: 'Primaria media (3° y 4°)',
    tono: 'claro y estructurado',
    densidadTexto: 'media',
    tiposActividadSugeridos: ['opción múltiple', 'verdadero/falso', 'relaciona columnas', 'completar', 'respuesta corta'],
    estiloVisual: 'didactico',
    maxIlustracionesSugeridas: 3,
    instruccionRedaccion:
      'Balance entre texto e ilustración. Reactivos y ejercicios ya estructurados formalmente. Diseño atractivo pero más académico que primaria baja.',
  },
  primaria_alta: {
    nivel: 'primaria_alta',
    etiqueta: 'Primaria alta (5° y 6°)',
    tono: 'más formal, orientado al contenido',
    densidadTexto: 'media_alta',
    tiposActividadSugeridos: ['opción múltiple', 'verdadero/falso', 'relaciona columnas', 'respuesta corta', 'desarrollo breve'],
    estiloVisual: 'didactico',
    maxIlustracionesSugeridas: 2,
    instruccionRedaccion:
      'Menos infantil, mayor peso al contenido. Cuando haga falta una ilustración, que sea informativa (diagrama o esquema simple), nunca decorativa. Diseño visual ordenado y moderno.',
  },
  secundaria: {
    nivel: 'secundaria',
    etiqueta: 'Secundaria',
    tono: 'maduro, académico, directo',
    densidadTexto: 'alta',
    tiposActividadSugeridos: ['opción múltiple', 'verdadero/falso', 'desarrollo', 'análisis', 'relaciona columnas'],
    estiloVisual: 'profesional-docente',
    maxIlustracionesSugeridas: 2,
    instruccionRedaccion:
      'Estilo visual más maduro. Ilustraciones sobrias: esquemas, diagramas, íconos o apoyos visuales discretos — nada infantil. Diseño académico, limpio y confiable.',
  },
}

export function obtenerPerfilNivel(nivel: NivelEducativo): PerfilNivelEducativo {
  return PERFILES[nivel]
}
