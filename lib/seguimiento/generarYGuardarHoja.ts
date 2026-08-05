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
import { generarHojaSeguimientoPdfBuffer, nombreArchivoHoja } from '../documentGen/generarHojaSeguimientoPdf'
import { subirBuffer, crearUrlFirmada, eliminarArchivo, rutaArchivo, BUCKET_HOJAS_SEGUIMIENTO } from '../documentGen/almacenamiento'
import type { IndicadorProyecto } from './tipos'

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
  | { ok: false; error: string }

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
    .select('id, identificador_visible, storage_path')
    .eq('proyecto_id', datos.proyectoId)
    .maybeSingle()

  let hojaId: string
  let identificadorVisible: string

  if (hojaExistente && hojaExistente.storage_path) {
    // Ya estaba completamente lista de un intento anterior — nunca se
    // regenera ni se vuelve a subir, solo se confirma el vínculo.
    const url = await crearUrlFirmada(sb, hojaExistente.storage_path, nombreArchivoHoja(hojaExistente.identificador_visible), BUCKET_HOJAS_SEGUIMIENTO)
    const urlVer = await crearUrlFirmada(sb, hojaExistente.storage_path, undefined, BUCKET_HOJAS_SEGUIMIENTO)
    await sb.from('proyectos_seguimiento').update({ hoja_id: hojaExistente.id, estado: 'hoja_generada', actualizado_en: new Date().toISOString() }).eq('id', datos.proyectoId)
    return { ok: true, hojaId: hojaExistente.id, identificadorVisible: hojaExistente.identificador_visible, url, urlVer }
  }

  if (hojaExistente) {
    hojaId = hojaExistente.id
    identificadorVisible = hojaExistente.identificador_visible
  } else {
    let insertada: { id: string; identificador_visible: string } | null = null
    for (let intento = 0; intento < MAX_INTENTOS_IDENTIFICADOR && !insertada; intento++) {
      const candidato = generarCodigoHoja()
      const { data: hoja, error: errorHoja } = await sb
        .from('hojas_evaluacion')
        .insert({ proyecto_id: datos.proyectoId, identificador_visible: candidato, indicadores: datos.indicadores })
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
  }

  const bufferPdf = await generarHojaSeguimientoPdfBuffer(
    {
      nombreProyecto: datos.nombreProyecto,
      camposFormativos: datos.camposFormativos,
      trimestreNombre: datos.trimestreNombre,
      fechaInicio: datos.fechaInicio,
      fechaFin: datos.fechaFin,
      identificadorVisible,
      indicadores: datos.indicadores,
      alumnos: (roster || []).map((a) => ({ nombre: a.nombre, posicion: a.posicion })),
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

  await sb.from('proyectos_seguimiento').update({ hoja_id: hojaId, estado: 'hoja_generada', actualizado_en: new Date().toISOString() }).eq('id', datos.proyectoId)

  const url = await crearUrlFirmada(sb, ruta, nombreArchivoHoja(identificadorVisible), BUCKET_HOJAS_SEGUIMIENTO)
  const urlVer = await crearUrlFirmada(sb, ruta, undefined, BUCKET_HOJAS_SEGUIMIENTO)
  return { ok: true, hojaId, identificadorVisible, url, urlVer }
}
