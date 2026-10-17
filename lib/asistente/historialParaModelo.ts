// lib/asistente/historialParaModelo.ts
//
// P0-B — minimización de datos personales en el HISTORIAL que se envía
// a los modelos (clasificador Nivel 0 y Sonnet principal). Server-only,
// puro: recibe el historial de texto que manda el cliente y devuelve
// una COPIA proyectada; nunca modifica el original, los mensajes
// persistidos ni lo que ve el docente. Los procesos deterministas
// internos (identidad C1, reuso de documentos, aprobación de
// planeación) siguen usando el historial original.
//
// Qué se protege (identificación estructural, nunca regex general):
// - Las respuestas que el propio servidor genera con datos personales
//   (plantillas de consultar_dato_alumno / corregir_dato_alumno en
//   lib/asistente/herramientasModulo.ts y de /api/alumnos/aplicar-
//   correccion): solo se sustituye la parte del VALOR; nombre,
//   etiquetas y estructura se conservan.
// - CURP en cualquier turno ANTERIOR (asistente o docente), validada
//   con la misma validación estructural de toda la app
//   (validarEstructuraCurp).
// Qué NO se toca: el mensaje actual (no forma parte del historial),
// fechas en texto libre (fechas de proyectos, calendario, etc.).
//
// Excepción controlada SOLO para Nivel 0: la regla 22.1 del
// clasificador lee Alumno/Campo/Nuevo del turno anterior del asistente
// y la herramienta compara ese valor contra la propuesta firmada (C4).
// Esas tres líneas se conservan únicamente si el ÚLTIMO turno del
// historial es una propuesta cuyo texto coincide EXACTAMENTE con la
// propuesta pendiente ya verificada (firma, docente, conversación,
// vigencia y alumno en el grupo activo). "Actual" se enmascara siempre.
// Sin esa verificación, todo queda enmascarado (fail-closed).

import { ETIQUETA_CAMPO_ALUMNO_CORREGIR } from './herramientasModulo'
import { validarEstructuraCurp } from '../motorContexto'
import { verificarPropuestaCorreccion } from './propuestaCorreccionFirmada'
import { alumnoDelGrupoActivo } from './identidadAlumno'
import type { AlumnoLigero } from '../sesionContexto'
import type { CampoAlumnoCorregible } from './tipos'

export type TurnoHistorialModelo = { role: 'user' | 'assistant'; content: string }

// Ningún marcador es un valor válido para validarValorCampoAlumno (ni
// CURP, ni H/M, ni AAAA-MM-DD): copiarlo como valor siempre se rechaza.
export const MARCADOR_OMISION = {
  curp: '⟦CURP omitida⟧',
  sexo: '⟦sexo omitido⟧',
  fecha_nacimiento: '⟦fecha de nacimiento omitida⟧',
  valor: '⟦valor omitido⟧',
} as const

export function contieneMarcadorOmision(texto: string | null | undefined): boolean {
  return typeof texto === 'string' && /⟦[^⟧]*omitid[ao]⟧/.test(texto)
}

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Mismas etiquetas que usan las plantillas (fuente única).
const ETIQUETAS = Object.values(ETIQUETA_CAMPO_ALUMNO_CORREGIR).map(escapar).join('|')

// Plantillas de UNA línea (anclas de inicio y fin): [patrón, grupos del valor → marcador].
const PLANTILLAS_LINEA: [RegExp, Record<number, string>][] = [
  [/^(La CURP registrada de .+ es )(.+)(\.)$/, { 2: MARCADOR_OMISION.curp }],
  [/^(El sexo registrado de .+ es )(.+)(\.)$/, { 2: MARCADOR_OMISION.sexo }],
  [/^(La fecha de nacimiento registrada de .+ es )(.+)(\.)$/, { 2: MARCADOR_OMISION.fecha_nacimiento }],
  [new RegExp(`^(Ese valor ya coincide con el registrado — .+ ya tiene (?:${ETIQUETAS}) = )(.+)(\\. No hice ningún cambio\\.)$`), { 2: MARCADOR_OMISION.valor }],
  [new RegExp(`^(Listo\\. Corregí (?:${ETIQUETAS}) de .+: ahora es )(.+)(\\.)$`), { 2: MARCADOR_OMISION.valor }],
  [/^(Listo\. Corregí el dato: ahora es )(.+)(\.)$/, { 2: MARCADOR_OMISION.valor }],
  [new RegExp(`^(Comparé la (?:${ETIQUETAS}) de .+: el valor que me diste \\()(.+)(\\) coincide exactamente con el registrado \\()(.+)(\\)\\. No hice ningún cambio\\.)$`), { 2: MARCADOR_OMISION.valor, 4: MARCADOR_OMISION.valor }],
]
const RE_COMPARACION_INICIO = new RegExp(`^Comparé la (?:${ETIQUETAS}) de .+:$`)
const RE_COMPARACION_REGISTRADA = new RegExp(`^((?:${ETIQUETAS}) registrada: )(.+)$`)
const RE_COMPARACION_PROPORCIONADO = /^(Valor proporcionado: )(.+)$/
const RE_COMPARACION_SUGERENCIA = new RegExp(`^(Difieren\\. No hice ningún cambio — si quieres que corrija el dato, dímelo explícitamente \\(por ejemplo: "corrige la (?:${ETIQUETAS}) de .+ a )(.+)("\\)\\.)$`)
const RE_CAMPO_PROPUESTA = new RegExp(`^Campo: (${ETIQUETAS})$`)

function sustituirGrupos(linea: string, re: RegExp, grupos: Record<number, string>): string | null {
  const m = linea.match(re)
  if (!m) return null
  return m.slice(1).map((g, i) => grupos[i + 1] ?? g).join('')
}

// CURP con estructura reconocible con seguridad (validación oficial de
// la app, no solo la forma) en cualquier punto del texto.
const RE_CANDIDATO_CURP = /\b[A-Za-z]{4}\d{6}[HMhm][A-Za-z]{5}[A-Za-z0-9]\d\b/g
function enmascararCurps(texto: string): string {
  return texto.replace(RE_CANDIDATO_CURP, (t) => (validarEstructuraCurp(t.toUpperCase()).valido ? MARCADOR_OMISION.curp : t))
}

// Índices de las líneas Alumno/Campo/Actual/Nuevo/Fuente si el texto
// contiene el bloque de propuesta en ese orden exacto y consecutivo.
function bloquePropuesta(lineas: string[]): { alumno: number; campo: number; actual: number; nuevo: number } | null {
  for (let i = 0; i + 4 < lineas.length; i++) {
    if (lineas[i].startsWith('Alumno: ') && RE_CAMPO_PROPUESTA.test(lineas[i + 1]) && lineas[i + 2].startsWith('Actual: ') &&
        lineas[i + 3].startsWith('Nuevo: ') && lineas[i + 4].startsWith('Fuente: ')) {
      return { alumno: i, campo: i + 1, actual: i + 2, nuevo: i + 3 }
    }
  }
  return null
}

export type PropuestaVigenteNivel0 = { alumnoNombre: string; campo: CampoAlumnoCorregible; valorNuevo: string }

// Verifica la propuesta pendiente con las MISMAS piezas de C4/C3 (firma,
// docente, conversación autorizada, vigencia, alumno en el grupo activo
// con el mismo nombre). Cualquier duda → null (sin excepción).
export function propuestaVigenteParaNivel0(
  propuesta: { mensajeId: string; sobre: unknown } | null | undefined,
  ctx: { docenteId: string | null | undefined; conversacionId: string | null | undefined; roster: AlumnoLigero[] | null | undefined }
): PropuestaVigenteNivel0 | null {
  if (!propuesta || !propuesta.sobre || !ctx.docenteId || !ctx.conversacionId) return null
  const v = verificarPropuestaCorreccion(propuesta.sobre, { docenteId: ctx.docenteId, conversacionId: ctx.conversacionId })
  if (!v.ok) return null
  const alumno = alumnoDelGrupoActivo(ctx.roster ?? [], v.payload.alumnoId)
  if (!alumno || alumno.nombre_completo !== v.payload.alumnoNombre) return null
  return { alumnoNombre: v.payload.alumnoNombre, campo: v.payload.campo, valorNuevo: v.payload.valorNuevo }
}

export type ProyeccionHistorial = {
  historial: TurnoHistorialModelo[]
  turnosEnmascarados: number
  // true solo si se conservó el "Nuevo" de la propuesta del último turno.
  excepcionPropuesta: boolean
}

export function proyectarHistorialParaModelo(
  historial: TurnoHistorialModelo[],
  opciones: { propuestaVigente?: PropuestaVigenteNivel0 | null } = {}
): ProyeccionHistorial {
  let turnosEnmascarados = 0
  let excepcionPropuesta = false
  const ultimo = historial.length - 1
  const salida = historial.map((turno, indice) => {
    const lineas = turno.content.split('\n')
    let lineaExcepcion = -1
    if (turno.role === 'assistant') {
      const bloque = bloquePropuesta(lineas)
      if (bloque) {
        const p = opciones.propuestaVigente
        if (indice === ultimo && p &&
            lineas[bloque.alumno] === `Alumno: ${p.alumnoNombre}` &&
            lineas[bloque.campo] === `Campo: ${ETIQUETA_CAMPO_ALUMNO_CORREGIR[p.campo]}` &&
            lineas[bloque.nuevo] === `Nuevo: ${p.valorNuevo}`) {
          lineaExcepcion = bloque.nuevo
          excepcionPropuesta = true
        } else {
          lineas[bloque.nuevo] = `Nuevo: ${MARCADOR_OMISION.valor}`
        }
        lineas[bloque.actual] = `Actual: ${MARCADOR_OMISION.valor}`
      }
      const esComparacion = lineas.some((l) => RE_COMPARACION_INICIO.test(l))
      for (let i = 0; i < lineas.length; i++) {
        if (i === lineaExcepcion) continue
        for (const [re, grupos] of PLANTILLAS_LINEA) {
          const r = sustituirGrupos(lineas[i], re, grupos)
          if (r !== null) { lineas[i] = r; break }
        }
        if (esComparacion) {
          lineas[i] = sustituirGrupos(lineas[i], RE_COMPARACION_REGISTRADA, { 2: MARCADOR_OMISION.valor })
            ?? sustituirGrupos(lineas[i], RE_COMPARACION_PROPORCIONADO, { 2: MARCADOR_OMISION.valor })
            ?? sustituirGrupos(lineas[i], RE_COMPARACION_SUGERENCIA, { 2: MARCADOR_OMISION.valor })
            ?? lineas[i]
        }
      }
    }
    for (let i = 0; i < lineas.length; i++) {
      if (i !== lineaExcepcion) lineas[i] = enmascararCurps(lineas[i])
    }
    const content = lineas.join('\n')
    if (content !== turno.content) turnosEnmascarados++
    return { role: turno.role, content }
  })
  return { historial: salida, turnosEnmascarados, excepcionPropuesta }
}
