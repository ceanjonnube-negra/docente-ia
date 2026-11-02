// lib/seguimiento/generarYGuardarHoja.ts
//
// Lógica compartida para crear la hoja de evaluación DEFINITIVA de un
// proyecto de Seguimiento — extraída de
// app/api/proyectos-seguimiento/[id]/hoja/route.ts (el endpoint sigue
// existiendo y ahora solo llama a esta función) para que
// lib/planeacion/aprobarBorrador.ts (C-005, integración con
// Planeación) pueda reutilizar EXACTAMENTE la misma generación, sin
// un segundo generador ni una segunda interpretación de los datos.
//
// Genera el PDF real (generarHojaSeguimientoPdfBuffer), reintenta el
// identificador visible ante colisión (nunca ante otro tipo de
// error), sube a Storage, y deja `proyectos_seguimiento` enlazado. Si
// la subida a Storage falla DESPUÉS de haber insertado la fila de
// hojas_evaluacion, esa fila queda con storage_path=null — estado
// claramente incompleto y recuperable en el siguiente intento (se
// reutiliza la misma fila por proyecto_id, nunca se inserta otra) —
// nunca se le miente al llamador con un éxito parcial.

import type { SupabaseClient } from '@supabase/supabase-js'
import { obtenerRosterConPosicion } from '../rosterGrupo'
import { generarCodigoHoja } from '../identificadorHoja'
import { generarHojaSeguimientoPdfBuffer, nombreArchivoHoja, type AlumnoHoja } from '../documentGen/generarHojaSeguimientoPdf'
import { subirBuffer, crearUrlFirmada, eliminarArchivo, rutaArchivo, BUCKET_HOJAS_SEGUIMIENTO } from '../documentGen/almacenamiento'
import type { IndicadorProyecto, IndicadorCongelado, AlumnoRosterCongelado } from './tipos'

const MAX_INTENTOS_IDENTIFICADOR = 3

export type DatosGenerarHoja = {
  proyectoId: string
  grupoId: string
  nombreProyecto: string
  camposFormativos: string[]
  trimestreNombre: string | null
  fechaInicio: string | null
  fechaFin: string | null
  indicadores: IndicadorProyecto[]
}

export type ResultadoGenerarHoja =
  // urlVer (CORRECCIÓN AISLADA — "separar 'Ver PDF' de 'Descargar
  // PDF'"): segunda URL firmada del MISMO pdf, sin `download` — usada
  // por el botón "Ver PDF" de la tarjeta. `url` sigue siendo,
  // exactamente igual que antes, la URL de descarga forzada.
  | { ok: true; hojaId: string; identificadorVisible: string; url: string; urlVer: string }
  // conflicto: los resultados del proyecto se confirmaron mientras se
  // generaba la hoja — el proyecto no se tocó (ver vincularHojaAlProyecto).
  | { ok: false; error: string; conflicto?: true }

export const MENSAJE_PROYECTO_CONFIRMADO = 'Los resultados de este proyecto ya fueron confirmados; la hoja no se puede volver a generar.'

// Mismo conjunto que foto-hoja/analizar-hoja/hoja: estados posteriores a
// la confirmación de resultados.
const ESTADOS_POST_CONFIRMACION = ['confirmado', 'corregido', 'sustituido', 'cerrado']

// Enlaza la hoja y deja el proyecto en 'hoja_generada' SOLO si sus
// resultados siguen sin confirmar. La condición viaja en el mismo UPDATE
// (PostgreSQL la evalúa de forma atómica sobre la fila, también frente a
// un confirmar-hoja concurrente) — una lectura previa no bastaría.
// 0 filas afectadas = conflicto: el proyecto queda exactamente como estaba.
async function vincularHojaAlProyecto(sb: SupabaseClient, proyectoId: string, hojaId: string): Promise<'ok' | 'conflicto' | 'error'> {
  const { data, error } = await sb
    .from('proyectos_seguimiento')
    .update({ hoja_id: hojaId, estado: 'hoja_generada', actualizado_en: new Date().toISOString() })
    .eq('id', proyectoId)
    .is('confirmado_en', null)
    .or(`estado.is.null,estado.not.in.(${ESTADOS_POST_CONFIRMACION.join(',')})`)
    .select('id')
  if (error) return 'error'
  return data && data.length > 0 ? 'ok' : 'conflicto'
}

export async function generarYGuardarHojaSeguimiento(
  sb: SupabaseClient,
  docenteId: string,
  datos: DatosGenerarHoja,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  perfil: any,
  zonaHoraria: string | null
): Promise<ResultadoGenerarHoja> {
  const { data: roster, error: errorRoster } = await obtenerRosterConPosicion(sb, datos.grupoId)
  if (errorRoster) return { ok: false, error: 'No se pudo leer la lista del grupo para generar la hoja.' }

  // Recuperación: si un intento previo ya insertó una fila de
  // hojas_evaluacion para este proyecto pero la subida a Storage
  // falló (storage_path aún null), se reutiliza esa misma fila en vez
  // de insertar otra — nunca dos hojas para el mismo proyecto.
  const { data: hojaExistente } = await sb
    .from('hojas_evaluacion')
    .select('id, identificador_visible, storage_path, roster_congelado, indicadores')
    .eq('proyecto_id', datos.proyectoId)
    .maybeSingle()

  let hojaId: string
  let identificadorVisible: string

  // EVAL-1B — alumnos/indicadores que efectivamente alimentan el PDF:
  // por defecto (retry sobre una hoja ya existente, rama de abajo) se
  // usan los valores EN VIVO ya recibidos/leídos arriba — exactamente
  // el comportamiento histórico, sin ningún cambio. Solo la rama de
  // creación nueva los sustituye por el roster/indicadores YA
  // CONGELADOS que se acaban de insertar — mismo array lógico para
  // Storage (PDF) y para DB (roster_congelado/indicadores), nunca dos
  // fuentes que puedan divergir entre sí.
  let alumnosParaPdf: AlumnoHoja[] = (roster || []).map((a) => ({ nombre: a.nombre, posicion: a.posicion }))
  let indicadoresParaPdf: IndicadorProyecto[] = datos.indicadores

  if (hojaExistente && hojaExistente.storage_path) {
    // Ya estaba completamente lista de un intento anterior — nunca se
    // regenera ni se vuelve a subir, solo se confirma el vínculo. Aquí no
    // hubo ningún efecto previo, así que un conflicto no deja nada que
    // revertir.
    const vinculo = await vincularHojaAlProyecto(sb, datos.proyectoId, hojaExistente.id)
    if (vinculo === 'conflicto') return { ok: false, conflicto: true, error: MENSAJE_PROYECTO_CONFIRMADO }
    if (vinculo === 'error') return { ok: false, error: 'No se pudo enlazar la hoja con el proyecto. Intenta de nuevo.' }
    const url = await crearUrlFirmada(sb, hojaExistente.storage_path, nombreArchivoHoja(hojaExistente.identificador_visible), BUCKET_HOJAS_SEGUIMIENTO)
    const urlVer = await crearUrlFirmada(sb, hojaExistente.storage_path, undefined, BUCKET_HOJAS_SEGUIMIENTO)
    return { ok: true, hojaId: hojaExistente.id, identificadorVisible: hojaExistente.identificador_visible, url, urlVer }
  }

  if (hojaExistente) {
    // Retry sobre una hoja que ya existe (la subida a Storage falló en
    // un intento previo): NUNCA se escribe ni se modifica
    // roster_congelado/indicadores — esos ya quedaron fijos (o
    // permanecen null, si la hoja es histórica) desde su creación
    // original. El PDF del retry se imprime con ESE roster/indicadores
    // congelados, nunca con la lista en vivo: si el grupo cambió entre
    // intentos, imprimir la lista actual haría que las posiciones del
    // PDF no correspondan a roster_congelado y los resultados de la foto
    // se asignarían a otros alumnos. Solo una hoja histórica sin roster
    // congelado (excluida del análisis automático) conserva la lista en
    // vivo, igual que siempre.
    hojaId = hojaExistente.id
    identificadorVisible = hojaExistente.identificador_visible
    const rosterYaCongelado = hojaExistente.roster_congelado as AlumnoRosterCongelado[] | null
    if (Array.isArray(rosterYaCongelado) && rosterYaCongelado.length > 0) {
      alumnosParaPdf = rosterYaCongelado.map((a) => ({ nombre: a.nombre, posicion: a.posicion }))
      const indicadoresYaCongelados = hojaExistente.indicadores as IndicadorCongelado[] | null
      if (Array.isArray(indicadoresYaCongelados) && indicadoresYaCongelados.length > 0) indicadoresParaPdf = indicadoresYaCongelados
    }
  } else {
    // EVAL-1B — se congela EXACTAMENTE UNA VEZ, en el mismo INSERT que
    // crea la hoja: `roster` (recién leído arriba, sin ninguna
    // recomputación posterior) y `datos.indicadores` (tal como llegó
    // el llamador) son la ÚNICA fuente, tanto para lo que se persiste
    // como para lo que se imprime.
    const rosterCongelado: AlumnoRosterCongelado[] = (roster || []).map((a) => ({
      alumno_id: a.id,
      inscripcion_id: a.inscripcion_id,
      nombre: a.nombre,
      posicion: a.posicion,
    }))
    const indicadoresCongelados: IndicadorCongelado[] = datos.indicadores.map((indicador, index) => ({
      ...indicador,
      numero_indicador: index + 1,
    }))

    let insertada: { id: string; identificador_visible: string } | null = null
    for (let intento = 0; intento < MAX_INTENTOS_IDENTIFICADOR && !insertada; intento++) {
      const candidato = generarCodigoHoja()
      const { data: hoja, error: errorHoja } = await sb
        .from('hojas_evaluacion')
        .insert({
          proyecto_id: datos.proyectoId,
          identificador_visible: candidato,
          indicadores: indicadoresCongelados,
          roster_congelado: rosterCongelado,
        })
        .select('id, identificador_visible')
        .single()
      if (!errorHoja && hoja) {
        insertada = hoja
      } else if (errorHoja?.code !== '23505') {
        return { ok: false, error: `No se pudo generar la hoja: ${errorHoja?.message}` }
      }
    }
    if (!insertada) return { ok: false, error: 'No se pudo generar un identificador único para la hoja. Intenta de nuevo.' }
    hojaId = insertada.id
    identificadorVisible = insertada.identificador_visible

    // El PDF se construye desde el MISMO array recién congelado y
    // persistido arriba — nunca se vuelve a leer `roster` ni
    // `datos.indicadores` sueltos para esto, eliminando de raíz
    // cualquier posibilidad de que Storage y DB queden desalineados.
    alumnosParaPdf = rosterCongelado.map((a) => ({ nombre: a.nombre, posicion: a.posicion }))
    indicadoresParaPdf = indicadoresCongelados
  }

  const bufferPdf = await generarHojaSeguimientoPdfBuffer(
    {
      nombreProyecto: datos.nombreProyecto,
      camposFormativos: datos.camposFormativos,
      trimestreNombre: datos.trimestreNombre,
      fechaInicio: datos.fechaInicio,
      fechaFin: datos.fechaFin,
      identificadorVisible,
      indicadores: indicadoresParaPdf,
      alumnos: alumnosParaPdf,
    },
    perfil,
    zonaHoraria
  )

  const ruta = rutaArchivo(docenteId, nombreArchivoHoja(identificadorVisible))
  try {
    await subirBuffer(sb, ruta, bufferPdf, 'application/pdf', BUCKET_HOJAS_SEGUIMIENTO)
  } catch (e) {
    // Nada que limpiar todavía — subirBuffer no dejó nada a medias si
    // ella misma lanzó. La fila de hojas_evaluacion queda sin
    // storage_path, recuperable en el siguiente intento.
    return { ok: false, error: e instanceof Error ? e.message : 'No se pudo subir el PDF de la hoja.' }
  }

  const { error: errorUpdateHoja } = await sb.from('hojas_evaluacion').update({ storage_path: ruta }).eq('id', hojaId)
  if (errorUpdateHoja) {
    // El archivo SÍ se subió pero no se pudo registrar su ruta — se
    // elimina el archivo huérfano en vez de dejarlo sin referencia.
    await eliminarArchivo(sb, ruta, BUCKET_HOJAS_SEGUIMIENTO)
    return { ok: false, error: 'No se pudo registrar el archivo de la hoja. Intenta de nuevo.' }
  }

  const vinculo = await vincularHojaAlProyecto(sb, datos.proyectoId, hojaId)
  if (vinculo !== 'ok') {
    // Se revierte lo que hizo ESTE intento, en el mismo orden seguro que
    // arriba: primero se quita la ruta (solo si sigue siendo la nuestra)
    // y después el archivo recién subido — la hoja vuelve a quedar sin
    // storage_path, el mismo estado incompleto y recuperable de siempre.
    // Nunca se tocan roster/indicadores congelados, resultados ni el
    // proyecto.
    await sb.from('hojas_evaluacion').update({ storage_path: null }).eq('id', hojaId).eq('storage_path', ruta)
    await eliminarArchivo(sb, ruta, BUCKET_HOJAS_SEGUIMIENTO)
    return vinculo === 'conflicto'
      ? { ok: false, conflicto: true, error: MENSAJE_PROYECTO_CONFIRMADO }
      : { ok: false, error: 'No se pudo enlazar la hoja con el proyecto. Intenta de nuevo.' }
  }

  const url = await crearUrlFirmada(sb, ruta, nombreArchivoHoja(identificadorVisible), BUCKET_HOJAS_SEGUIMIENTO)
  const urlVer = await crearUrlFirmada(sb, ruta, undefined, BUCKET_HOJAS_SEGUIMIENTO)
  return { ok: true, hojaId, identificadorVisible, url, urlVer }
}
