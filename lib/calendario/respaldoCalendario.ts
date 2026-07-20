// lib/calendario/respaldoCalendario.ts
//
// Respaldo automático antes de corregir el calendario — sin acceso a
// migraciones SQL en este proyecto no es posible crear una tabla de
// respaldos, así que el respaldo es un archivo JSON real y descargable
// que reutiliza el mismo almacenamiento que ya usan los documentos
// generados por el Chat IA (ver lib/documentGen/almacenamiento.ts).
// Solo incluye las filas propias del docente (user_id=userId) — son
// las únicas que aplicarCorreccionesCalendario (lib/motorContexto.ts)
// puede llegar a modificar; los eventos oficiales compartidos nunca se
// tocan, así que no hace falta respaldarlos.

import type { SupabaseClient } from '@supabase/supabase-js'
import { subirBuffer, crearUrlFirmada, rutaArchivo } from '@/lib/documentGen/almacenamiento'
import type { ArchivoGeneradoInfo } from '@/lib/asistente/tipos'

export async function generarRespaldoCalendario(sb: SupabaseClient, userId: string): Promise<ArchivoGeneradoInfo> {
  const { data, error } = await sb
    .from('calendario_eventos')
    .select('id, titulo, fecha, tipo, color, descripcion, es_sep')
    .eq('user_id', userId)
    .order('fecha', { ascending: true })

  if (error) throw new Error(`Error leyendo el calendario para el respaldo: ${error.message}`)

  const respaldo = {
    generadoEn: new Date().toISOString(),
    totalEventos: data?.length ?? 0,
    eventos: data || [],
  }

  const buffer = Buffer.from(JSON.stringify(respaldo, null, 2), 'utf-8')
  const nombreArchivo = `respaldo-calendario-${new Date().toISOString().slice(0, 10)}.json`
  const ruta = rutaArchivo(userId, nombreArchivo)

  await subirBuffer(sb, ruta, buffer, 'application/json')
  const url = await crearUrlFirmada(sb, ruta, nombreArchivo)

  return { tipo: 'json', nombre: nombreArchivo, url }
}
