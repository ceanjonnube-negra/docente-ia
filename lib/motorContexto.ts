// lib/motorContexto.ts
// CAMBIO respecto a la versión anterior: ahora recibe el cliente de
// Supabase como parámetro en vez de importar el singleton directamente.
// Esto permite usarlo tanto desde componentes de cliente (pasando el
// singleton de lib/supabaseClient.ts) como desde rutas de servidor
// (pasando un cliente con el token de sesión del usuario, necesario
// para que auth.uid() funcione dentro de las RPC con SECURITY DEFINER).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DiferenciaCalendario } from './asistente/tipos';

export type ExcepcionAsistencia = {
  alumno_id: string;
  estatus: 'presente' | 'falta' | 'retardo' | 'justificada';
};

// --- Funciones agregadas a nivel de grupo (no hay RPC para esto — se
// arma con consultas directas a las tablas, respetando RLS vía el
// cliente de sesión del docente que se recibe como parámetro). Todas
// alimentan al Clasificador de Nivel 0 para que el Chat IA conteste con
// datos reales ("¿quién faltó hoy?", "¿quién tiene más faltas?", "¿qué
// alumnos requieren apoyo?", etc.) en vez de decir que no tiene acceso.

export type AsistenciaGrupoResumen = {
  fecha: string;
  presentes: string[];
  faltas: string[];
  retardos: string[];
  sinRegistrarHoy: string[];
  rankingFaltas: { nombre: string; faltas: number }[];
  ultimaFechaRegistrada: string | null;
};

export async function asistenciaGrupoResumen(
  sb: SupabaseClient,
  grupoId: string,
  fecha: string
): Promise<AsistenciaGrupoResumen> {
  const vacio: AsistenciaGrupoResumen = {
    fecha,
    presentes: [],
    faltas: [],
    retardos: [],
    sinRegistrarHoy: [],
    rankingFaltas: [],
    ultimaFechaRegistrada: null,
  };

  const { data: inscripciones } = await sb
    .from('inscripciones')
    .select('id, alumno_id, alumnos(nombre)')
    .eq('grupo_id', grupoId)
    .eq('estatus', 'activo');
  if (!inscripciones || inscripciones.length === 0) return vacio;

  type FilaInscripcion = { id: string; alumno_id: string; alumnos: { nombre: string | null } | { nombre: string | null }[] | null };
  const nombrePorInscripcion = new Map(
    (inscripciones as FilaInscripcion[]).map((i) => {
      const rel = Array.isArray(i.alumnos) ? i.alumnos[0] : i.alumnos;
      return [i.id, rel?.nombre || 'Alumno'];
    })
  );
  const inscripcionIds = Array.from(nombrePorInscripcion.keys());

  // Registros de HOY — quién está presente/falta/retardo, y quién de
  // plano no tiene registro todavía.
  const { data: registrosHoy } = await sb
    .from('asistencia_registro')
    .select('inscripcion_id, estatus')
    .eq('fecha', fecha)
    .in('inscripcion_id', inscripcionIds);

  const estatusHoyPorInscripcion = new Map(
    (registrosHoy || []).map((r: { inscripcion_id: string; estatus: string }) => [r.inscripcion_id, r.estatus])
  );
  for (const [inscripcionId, nombre] of nombrePorInscripcion) {
    const estatus = estatusHoyPorInscripcion.get(inscripcionId);
    if (estatus === 'presente') vacio.presentes.push(nombre);
    else if (estatus === 'falta') vacio.faltas.push(nombre);
    else if (estatus === 'retardo') vacio.retardos.push(nombre);
    else vacio.sinRegistrarHoy.push(nombre);
  }

  // Ranking de faltas en todo el ciclo (no solo hoy) — para "¿quién
  // tiene más faltas?". Se cuenta en memoria (grupos normalmente son
  // ~20-35 alumnos, no vale la pena una RPC nueva para esto).
  const { data: todosLosRegistros } = await sb
    .from('asistencia_registro')
    .select('inscripcion_id, estatus, fecha')
    .in('inscripcion_id', inscripcionIds);

  const faltasPorInscripcion = new Map<string, number>();
  let ultimaFecha: string | null = null;
  for (const r of (todosLosRegistros || []) as { inscripcion_id: string; estatus: string; fecha: string }[]) {
    if (r.estatus === 'falta') faltasPorInscripcion.set(r.inscripcion_id, (faltasPorInscripcion.get(r.inscripcion_id) || 0) + 1);
    if (!ultimaFecha || r.fecha > ultimaFecha) ultimaFecha = r.fecha;
  }
  vacio.ultimaFechaRegistrada = ultimaFecha;
  vacio.rankingFaltas = Array.from(faltasPorInscripcion.entries())
    .map(([inscripcionId, faltas]) => ({ nombre: nombrePorInscripcion.get(inscripcionId) || 'Alumno', faltas }))
    .filter((f) => f.faltas > 0)
    .sort((a, b) => b.faltas - a.faltas)
    .slice(0, 10);

  // Validación obligatoria (ver "Fuente única de verdad — motor de
  // datos"): cada inscripción activa cae en EXACTAMENTE uno de los 4
  // arreglos (línea 76-82, un único if/else-if/else por inscripción),
  // así que esta suma no debería poder fallar nunca hoy — es una red
  // de seguridad ante un futuro cambio en ese bloque que rompa esa
  // garantía por accidente, no un recálculo real (no hay nada que
  // "reconsultar": los datos ya están completos en memoria). Se
  // registra y se responde de todas formas — bloquear la respuesta del
  // docente por una alarma que no aporta ningún dato adicional sería
  // peor que mostrarle la cifra real con el problema ya registrado
  // para investigarlo aparte.
  const totalClasificados = vacio.presentes.length + vacio.faltas.length + vacio.retardos.length + vacio.sinRegistrarHoy.length;
  if (totalClasificados !== inscripciones.length) {
    console.error(
      `[VALIDACION] asistenciaGrupoResumen: inconsistencia — ${totalClasificados} alumnos clasificados vs ${inscripciones.length} inscripciones activas (grupo ${grupoId}, fecha ${fecha})`
    );
  }

  return vacio;
}

export type ApoyoAlumno = { nombre: string; tipo: string | null; descripcion: string | null };

export async function necesidadesApoyoGrupo(sb: SupabaseClient, grupoId: string): Promise<ApoyoAlumno[]> {
  const { data: inscripciones } = await sb
    .from('inscripciones')
    .select('alumno_id, alumnos(nombre)')
    .eq('grupo_id', grupoId)
    .eq('estatus', 'activo');
  if (!inscripciones || inscripciones.length === 0) return [];

  type FilaInscripcion = { alumno_id: string; alumnos: { nombre: string | null } | { nombre: string | null }[] | null };
  const nombrePorAlumno = new Map(
    (inscripciones as FilaInscripcion[]).map((i) => {
      const rel = Array.isArray(i.alumnos) ? i.alumnos[0] : i.alumnos;
      return [i.alumno_id, rel?.nombre || 'Alumno'];
    })
  );
  const alumnoIds = Array.from(nombrePorAlumno.keys());

  const { data: necesidades } = await sb
    .from('necesidades_apoyo')
    .select('alumno_id, tipo, descripcion')
    .in('alumno_id', alumnoIds)
    .eq('activa', true);

  return ((necesidades || []) as { alumno_id: string; tipo: string | null; descripcion: string | null }[]).map((n) => ({
    nombre: nombrePorAlumno.get(n.alumno_id) || 'Alumno',
    tipo: n.tipo,
    descripcion: n.descripcion,
  }));
}

export type DocumentoResumen = { titulo: string; tipo: string; fecha: string };

export async function documentosDelDocente(sb: SupabaseClient, userId: string, limite = 15): Promise<{ total: number; recientes: DocumentoResumen[] }> {
  const { data, count } = await sb
    .from('documentos_generados')
    .select('titulo, tipo, created_at', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limite);

  return {
    total: count ?? (data?.length || 0),
    recientes: ((data || []) as { titulo: string; tipo: string; created_at: string }[]).map((d) => ({
      titulo: d.titulo,
      tipo: d.tipo,
      fecha: d.created_at,
    })),
  };
}

export type EventoCalendario = { titulo: string; fecha: string; tipo: string };

export async function calendarioProximo(sb: SupabaseClient, userId: string, fechaDesde: string, limite = 10): Promise<EventoCalendario[]> {
  // user_id null = evento del calendario oficial SEP (compartido para
  // todos); user_id propio = actividad que el docente agregó.
  const { data } = await sb
    .from('calendario_eventos')
    .select('titulo, fecha, tipo, user_id')
    .gte('fecha', fechaDesde)
    .or(`user_id.eq.${userId},user_id.is.null`)
    .order('fecha', { ascending: true })
    .limit(limite);

  return ((data || []) as { titulo: string; fecha: string; tipo: string }[]).map((e) => ({
    titulo: e.titulo,
    fecha: e.fecha,
    tipo: e.tipo,
  }));
}

export async function contextoAlumno(sb: SupabaseClient, alumnoId: string, cicloEscolarId: string) {
  const { data, error } = await sb.rpc('contexto_alumno', {
    p_alumno_id: alumnoId,
    p_ciclo_escolar_id: cicloEscolarId,
  });
  if (error) throw error;
  return data;
}

export async function contextoGrupo(sb: SupabaseClient, grupoId: string) {
  const { data, error } = await sb.rpc('contexto_grupo', { p_grupo_id: grupoId });
  if (error) throw error;
  return data;
}

export async function contextoDocente(sb: SupabaseClient) {
  const { data, error } = await sb.rpc('contexto_docente');
  if (error) throw error;
  return data;
}

export async function registrarAsistenciaMasiva(
  sb: SupabaseClient,
  grupoId: string,
  fecha: string,
  excepciones: ExcepcionAsistencia[] = []
) {
  const { data, error } = await sb.rpc('registrar_asistencia_masiva', {
    p_grupo_id: grupoId,
    p_fecha: fecha,
    p_excepciones: excepciones,
  });
  if (error) throw error;
  return data;
}

export async function consultarAsistenciaAlumno(sb: SupabaseClient, alumnoId: string, cicloEscolarId: string) {
  const { data, error } = await sb.rpc('consultar_asistencia_alumno', {
    p_alumno_id: alumnoId,
    p_ciclo_escolar_id: cicloEscolarId,
  });
  if (error) throw error;
  return data as { faltas: number; retardos: number; justificadas: number; dias_registrados: number };
}

export type IncidenciaResumen = { fecha: string; tipo: string; descripcion: string };
export type IncidenciasAlumnoResumen = { total: number; incidencias: IncidenciaResumen[] };

// Consultas inteligentes entre módulos — "¿cuántas incidencias tiene
// [alumno]?" no tenía ninguna fuente real hasta ahora (la única lectura
// de incidencias en todo el proyecto era client-side, en
// app/dashboard/lista/page.tsx, para pintar el badge "Incidencias: N"
// de cada fila — invisible para el Chat IA). Misma tabla, mismas
// columnas, solo ahora también consultable desde el servidor.
export async function incidenciasAlumno(sb: SupabaseClient, alumnoId: string): Promise<IncidenciasAlumnoResumen> {
  const { data } = await sb
    .from('incidencias')
    .select('fecha, tipo, descripcion')
    .eq('alumno_id', alumnoId)
    .order('fecha', { ascending: false });
  const incidencias = (data || []) as IncidenciaResumen[];
  return { total: incidencias.length, incidencias };
}

export type RegistroAsistencia = { alumno_id: string; estado: 'presente' | 'falta' | 'retardo' };
export type ResultadoEscrituraAsistencia = { exito: boolean; error?: string; guardados: number };

// Fuente única de verdad para ESCRIBIR asistencia — un alumno o varios
// a la vez, misma función. app/api/asistencia-guardar/route.ts (Lista,
// guardado por lote) y app/api/chat/route.ts (Chat IA, un alumno a la
// vez por nombre) llaman aquí, en vez de cada uno reimplementar el
// upsert por su cuenta. Nunca reporta éxito sin que Supabase confirme
// la escritura real — devuelve { exito:false, error } ante cualquier
// falla, para que quien llama pueda responder con honestidad en vez de
// asumir que ya quedó guardado (ver CORRECCIÓN — nunca confirmar una
// operación antes de verificarla).
export async function escribirAsistencia(
  sb: SupabaseClient,
  registros: RegistroAsistencia[],
  fecha: string,
  grupoId?: string | null
): Promise<ResultadoEscrituraAsistencia> {
  if (registros.length === 0) return { exito: true, guardados: 0 };

  // Tabla legada `asistencias` — solo booleano `presente` (un retardo
  // cuenta como presente para ese modelo, igual que ya hacía Lista).
  const filas = registros.map((r) => ({
    alumno_id: r.alumno_id,
    fecha,
    presente: r.estado !== 'falta',
    ...(grupoId ? { grupo_id: grupoId } : {}),
  }));

  const { data, error } = await sb.from('asistencias').upsert(filas, { onConflict: 'alumno_id,fecha' }).select();
  if (error) return { exito: false, error: error.message, guardados: 0 };

  // Modelo nuevo del CORE (asistencia_registro, vía inscripcion_id,
  // guarda el estatus completo incluido retardo) — de mejor esfuerzo:
  // si falla, no cambia el resultado porque la tabla legada de arriba
  // ya quedó guardada correctamente (mismo criterio que ya usaba
  // app/api/asistencia-guardar/route.ts).
  const alumnoIds = registros.map((r) => r.alumno_id);
  const { data: inscripcionesActivas } = await sb
    .from('inscripciones')
    .select('id, alumno_id')
    .in('alumno_id', alumnoIds)
    .eq('estatus', 'activo');

  const inscripcionPorAlumno = new Map(
    ((inscripcionesActivas || []) as { id: string; alumno_id: string }[]).map((i) => [i.alumno_id, i.id])
  );
  const filasRegistro = registros
    .filter((r) => inscripcionPorAlumno.has(r.alumno_id))
    .map((r) => ({ inscripcion_id: inscripcionPorAlumno.get(r.alumno_id) as string, fecha, estatus: r.estado }));

  if (filasRegistro.length > 0) {
    const { error: errorRegistro } = await sb.from('asistencia_registro').upsert(filasRegistro, { onConflict: 'inscripcion_id,fecha' });
    if (errorRegistro) console.error('Error al guardar asistencia_registro (de mejor esfuerzo):', errorRegistro);
  }

  return { exito: true, guardados: data?.length ?? 0 };
}

export async function actualizarDatosAlumno(
  sb: SupabaseClient,
  alumnoId: string,
  cambios: Partial<{
    nombre_completo: string;
    curp: string;
    sexo: string;
    fecha_nacimiento: string;
  }>
) {
  const { data, error } = await sb.rpc('actualizar_datos_alumno', {
    p_alumno_id: alumnoId,
    p_nombre_completo: cambios.nombre_completo ?? null,
    p_curp: cambios.curp ?? null,
    p_sexo: cambios.sexo ?? null,
    p_fecha_nacimiento: cambios.fecha_nacimiento ?? null,
  });
  if (error) throw error;
  return data;
}

export async function eliminarAlumnoDefinitivamente(sb: SupabaseClient, alumnoId: string) {
  const { error } = await sb.rpc('eliminar_alumno_definitivamente', { p_alumno_id: alumnoId });
  if (error) throw error;
}

export async function compartirGrupoConDocente(
  sb: SupabaseClient,
  grupoId: string,
  docenteDestinoId: string,
  rol: 'titular' | 'apoyo' = 'apoyo'
) {
  const { data, error } = await sb.rpc('compartir_grupo_con_docente', {
    p_grupo_id: grupoId,
    p_docente_destino_id: docenteDestinoId,
    p_rol: rol,
  });
  if (error) throw error;
  return data;
}

// --- Documento oficial "Lista de Alumnos" — construido 100%
// determinista, directo desde los registros reales del grupo. NUNCA
// pasa por Claude: los nombres son el dato oficial más sensible de la
// aplicación, y un modelo de lenguaje, al redactar una lista, tiende a
// "ayudar" reordenando apellido/nombre como si fuera una referencia
// bibliográfica (ej. "Rojas, Audrey Abad" en vez del dato real, "Abad
// Rojas Audrey"). La única forma de garantizar que esto no vuelva a
// pasar es que la IA jamás escriba los nombres — este texto usa
// exactamente los mismos datos, mismo orden y mismo nombre (ver
// nombreOficialAlumno en lib/rosterGrupo.ts) que ya muestra el módulo
// Lista, y se entrega tal cual a los generadores de Word/PDF o a la
// vista previa del chat — ver SOLICITA_LISTA_ALUMNOS en
// app/api/chat/route.ts, el único lugar que la invoca.
export function construirTextoListaAlumnos(
  alumnos: { alumno_id: string; nombre_completo: string; numero_lista: number | null }[],
  grado: string | null | undefined,
  grupo: string | null | undefined
): string {
  // Orden alfabético REAL — primer apellido, segundo apellido, nombre —
  // sin dividir ni tocar el texto: nombre_completo YA está guardado en
  // ese orden institucional exacto ("Abad Rojas Audrey" = apellido
  // paterno + apellido materno + nombre, como una sola cadena), así que
  // comparar la cadena completa con localeCompare produce ese orden de
  // tres niveles de forma natural, sin heurísticas de split().
  //
  // A propósito NO se ordena por numero_lista: ese campo refleja el
  // orden en que llegaron los alumnos al importar (ver
  // app/api/importar-alumnos/route.ts, donde Claude le asigna
  // numero_lista=1,2,3... siguiendo el orden del documento fuente que
  // se fotografió o subió) — no hay garantía de que ese documento
  // fuente ya viniera alfabetizado por apellido. lib/rosterGrupo.ts
  // (el módulo Lista real) ya tenía este mismo criterio — ordenar por
  // el nombre completo, nunca confiar en numero_lista para esto — este
  // documento ahora usa exactamente el mismo.
  const ordenados = [...alumnos].sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo, 'es'));

  // Debajo del título, únicamente "3° B" — nunca "Grado: 3° | Grupo: B"
  // (el encabezado institucional del documento, ver
  // lib/documentGen/encabezadoDocumento.ts, ya muestra Grado/Grupo por
  // separado; repetirlo aquí era la duplicación reportada). `grado` ya
  // incluye el símbolo real cuando aplica (el selector de onboarding
  // guarda "3°", no "3"), así que nunca se le concatena un "°" extra.
  const subtitulo = [grado, grupo].filter(Boolean).join(' ');

  // El número de cada renglón es la posición en ESTE orden alfabético
  // recién calculado (1, 2, 3...), nunca el numero_lista guardado —
  // mostrar un numero_lista que no corresponde al orden real de la
  // fila se vería inconsistente (ver razón del ordenamiento arriba).
  const filas = ordenados.map((a, i) => `${i + 1}. ${a.nombre_completo}`).join('\n');

  // Resumen final — dato real, contado aquí mismo, nunca reportado por
  // la IA (no hay IA involucrada en este documento en absoluto).
  const resumen = `RESUMEN\nTotal de alumnos: ${ordenados.length}`;

  return `📋 LISTA OFICIAL DE ALUMNOS\n${subtitulo}\n\n${filas}\n\n${resumen}`;
}

// --- Corrección de calendario desde una foto del calendario oficial
// (ver lib/calendario/analisisCalendario.ts y
// app/api/calendario/aplicar/route.ts) ---

export type EventoCalendarioCompleto = {
  id: string;
  titulo: string;
  fecha: string;
  tipo: string;
  color: string;
  descripcion: string;
  es_sep: boolean;
};

// Todo el ciclo escolar (no solo "próximos", como calendarioProximo) —
// para comparar contra una foto del calendario oficial hace falta ver
// también lo que ya pasó, no solo lo que falta. Incluye eventos
// oficiales compartidos (user_id null) y propios del docente, igual
// que calendarioProximo — pero aplicarCorreccionesCalendario, más
// abajo, SOLO escribe sobre filas propias del docente (ver esa nota).
export async function calendarioCicloCompleto(
  sb: SupabaseClient,
  userId: string,
  inicioCiclo: string,
  finCiclo: string
): Promise<EventoCalendarioCompleto[]> {
  const { data } = await sb
    .from('calendario_eventos')
    .select('id, titulo, fecha, tipo, color, descripcion, es_sep')
    .gte('fecha', inicioCiclo)
    .lte('fecha', finCiclo)
    .or(`user_id.eq.${userId},user_id.is.null`)
    .order('fecha', { ascending: true });

  return (data || []) as EventoCalendarioCompleto[];
}

// Misma clasificación por etiqueta que ya usa categoriaDe() en
// app/dashboard/calendario/page.tsx (color del punto en el
// calendario) — reimplementada aquí en texto porque esta función
// alimenta el prompt del Chat IA, no la UI, y un componente de página
// no se debe importar dentro de la ruta de la API. Mantener ambas en
// sincronía si cambia la forma de clasificar un tipo de evento.
export function categoriaEventoCalendario(e: Pick<EventoCalendarioCompleto, 'tipo' | 'es_sep'>): string {
  const t = (e.tipo || '').toLowerCase();
  if (!e.es_sep) return 'actividad propia del maestro';
  if (t.includes('inicio') || t.includes('fin')) return 'inicio/fin de ciclo (oficial SEP)';
  if (t.includes('festiv')) return 'festivo (oficial SEP)';
  if (t.includes('cte')) return 'CTE (oficial SEP)';
  if (t.includes('vacacion')) return 'vacaciones (oficial SEP)';
  if (t.includes('consejo')) return 'consejo técnico (oficial SEP)';
  if (t.includes('suspension') || t.includes('suspensión')) return 'suspensión de labores (oficial SEP)';
  return 'evento oficial (SEP)';
}

export type ResultadoCorreccionesCalendario = {
  exito: boolean;
  error?: string;
  agregados: number;
  corregidos: number;
  eliminados: number;
  // Subconjunto de `diferencias` que SÍ se escribió de verdad — nunca
  // lo que Claude propuso, siempre lo que Supabase confirmó. Sirve
  // para construir un resumen final por categoría real (ver
  // construirResumenExito en lib/calendario/analisisCalendario.ts) sin
  // volver a inventar ninguna cifra.
  aplicadas: DiferenciaCalendario[];
};

// Escribe las diferencias ya mostradas y confirmadas por el docente.
// SIEMPRE con user_id=userId y es_sep=false, nunca sobre un evento
// oficial compartido (user_id null) — un solo docente jamás debe poder
// alterar el calendario oficial de toda la plataforma desde su propio
// chat. Cada UPDATE/DELETE lleva .eq('user_id', userId) Y usa
// .select() para contar únicamente las filas que de verdad se vieron
// afectadas — si Claude propuso "corregir"/"eliminar" sobre un id que
// no le pertenece al docente (por ejemplo, un evento oficial
// compartido), la operación no toca nada y NO se cuenta como éxito,
// en vez de reportar un cambio que nunca ocurrió (mismo criterio que
// escribirAsistencia: nunca confirmar sin verificar).
export async function aplicarCorreccionesCalendario(
  sb: SupabaseClient,
  userId: string,
  diferencias: DiferenciaCalendario[]
): Promise<ResultadoCorreccionesCalendario> {
  if (diferencias.length === 0) return { exito: true, agregados: 0, corregidos: 0, eliminados: 0, aplicadas: [] };

  const aAgregar = diferencias.filter((d) => d.accion === 'agregar');
  const aCorregir = diferencias.filter((d) => d.accion === 'corregir' && d.id);
  const aEliminar = diferencias.filter((d) => d.accion === 'eliminar' && d.id);

  let agregados = 0;
  let corregidos = 0;
  let eliminados = 0;
  const aplicadas: DiferenciaCalendario[] = [];

  if (aAgregar.length > 0) {
    const filas = aAgregar.map((d) => ({
      user_id: userId,
      titulo: d.evento.titulo,
      fecha: d.evento.fecha,
      tipo: d.evento.tipo,
      color: d.evento.color,
      descripcion: d.evento.descripcion,
      es_sep: false,
    }));
    const { data, error } = await sb.from('calendario_eventos').insert(filas).select();
    if (error) return { exito: false, error: error.message, agregados: 0, corregidos: 0, eliminados: 0, aplicadas: [] };
    agregados = data?.length ?? 0;
    // insert() de un solo array es atómico (todo o nada) salvo el error
    // ya manejado arriba — si no hubo error, las filas SÍ se guardaron.
    aplicadas.push(...aAgregar);
  }

  for (const d of aCorregir) {
    const { data, error } = await sb
      .from('calendario_eventos')
      .update({
        titulo: d.evento.titulo,
        fecha: d.evento.fecha,
        tipo: d.evento.tipo,
        color: d.evento.color,
        descripcion: d.evento.descripcion,
      })
      .eq('id', d.id as string)
      .eq('user_id', userId)
      .select();
    if (error) return { exito: false, error: error.message, agregados, corregidos, eliminados, aplicadas };
    const filasAfectadas = data?.length ?? 0;
    corregidos += filasAfectadas;
    if (filasAfectadas > 0) aplicadas.push(d);
  }

  if (aEliminar.length > 0) {
    const ids = aEliminar.map((d) => d.id as string);
    const { data, error } = await sb
      .from('calendario_eventos')
      .delete()
      .in('id', ids)
      .eq('user_id', userId)
      .select('id');
    if (error) return { exito: false, error: error.message, agregados, corregidos, eliminados, aplicadas };
    const idsEliminados = new Set(((data || []) as { id: string }[]).map((f) => f.id));
    eliminados = idsEliminados.size;
    aplicadas.push(...aEliminar.filter((d) => idsEliminados.has(d.id as string)));
  }

  return { exito: true, agregados, corregidos, eliminados, aplicadas };
}
