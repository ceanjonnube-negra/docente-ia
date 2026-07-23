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

// Único origen de verdad para los 4 estados oficiales de asistencia
// (ver "Unificar los estados de asistencia — único origen de verdad").
// Un alumno sin fila en asistencia_registro para la fecha consultada
// es "sin_registrar" — NUNCA se cuenta como presente por default, en
// NINGÚN lugar de la aplicación. Tanto app/dashboard/lista/page.tsx
// (los contadores y el estado editable de cada fila) como
// asistenciaGrupoResumen (lo que consulta el Chat IA) llaman
// exactamente a esta misma función — nunca reimplementan su propia
// clasificación por separado, para que ambos lados no puedan divergir.
export type EstadoAsistenciaOficial = 'presente' | 'falta' | 'retardo' | 'sin_registrar';

export function clasificarEstadoAsistencia(estatus: string | null | undefined): EstadoAsistenciaOficial {
  if (estatus === 'presente') return 'presente';
  if (estatus === 'falta') return 'falta';
  if (estatus === 'retardo') return 'retardo';
  return 'sin_registrar';
}

export type ConteoAsistencia = { presentes: number; faltas: number; retardos: number; sinRegistrar: number; total: number };

// Única función que convierte una lista de estados oficiales (uno por
// alumno) en los 4 totales que se muestran tanto en
// app/dashboard/lista/page.tsx (tarjeta de resumen) como en la
// respuesta del Chat IA (asistenciaGrupoResumen más abajo). Con el
// mismo conjunto de alumnos y los mismos estados de entrada, esta
// función GARANTIZA el mismo resultado en ambos lados — si alguna vez
// difieren, la causa nunca puede estar aquí, solo en qué alumnos o qué
// estatus se leyeron antes de llegar a esta función (ver "Corregir
// inconsistencia entre Lista y Chat IA en el resumen de asistencia").
export function contarEstadosAsistencia(estados: EstadoAsistenciaOficial[]): ConteoAsistencia {
  const conteo: ConteoAsistencia = { presentes: 0, faltas: 0, retardos: 0, sinRegistrar: 0, total: estados.length };
  for (const estado of estados) {
    if (estado === 'presente') conteo.presentes++;
    else if (estado === 'falta') conteo.faltas++;
    else if (estado === 'retardo') conteo.retardos++;
    else conteo.sinRegistrar++;
  }
  return conteo;
}

// Única función de todo el proyecto que calcula el % de asistencia
// diaria de un grupo — un retardo cuenta como asistencia (el alumno
// llegó, solo tarde), nunca resta del porcentaje. Fórmula:
// (presentes + retardos) / total. "sin registrar" cuenta para el
// total de alumnos pero no suma ni resta del porcentaje. Cualquier
// pantalla o consulta que muestre este porcentaje (resumen del Chat
// IA, estadísticas, indicadores, reportes, exportaciones) debe pasar
// por aquí — nunca recalcularlo con su propia fórmula (ver "Corregir
// el cálculo de asistencia utilizado por el Chat IA": antes
// asistenciaGrupoResumen usaba presentes/total, sin contar los
// retardos como asistencia).
export function calcularPorcentajeAsistencia(conteo: ConteoAsistencia): number {
  if (conteo.total === 0) return 0;
  return ((conteo.presentes + conteo.retardos) / conteo.total) * 100;
}

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
  // Marca temporal de ESTA consulta (no del renglón guardado en la
  // base — asistencia_registro no tiene columna de auditoría propia).
  // Sirve para probar en los logs que cada llamada vuelve a golpear la
  // base de datos en el momento real de la pregunta, nunca reutiliza
  // un resultado de un turno anterior (ver "Corregir inconsistencia
  // entre Lista y Chat IA en el resumen de asistencia").
  const timestampConsulta = new Date().toISOString();
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
  if (!inscripciones || inscripciones.length === 0) {
    console.log(`[ASISTENCIA][chat] ts=${timestampConsulta} fecha=${fecha} grupo=${grupoId} presentes=0 faltas=0 retardos=0 sinRegistrar=0 origen=asistenciaGrupoResumen — sin inscripciones activas`);
    return vacio;
  }

  type FilaInscripcion = { id: string; alumno_id: string; alumnos: { nombre: string | null } | { nombre: string | null }[] | null };
  // Mismo criterio que obtenerRosterConPosicion (lib/rosterGrupo.ts —
  // lo que usa Lista para su roster): una inscripción activa cuyo
  // alumno ya no existe (fila huérfana) se descarta por completo,
  // nunca se cuenta con un nombre de repuesto ("Alumno"). Antes esta
  // función SÍ la contaba — causa real confirmada de que el Chat IA
  // reportara más alumnos en total que Lista para el mismo grupo y la
  // misma fecha.
  const nombrePorInscripcion = new Map<string, string>();
  let huerfanas = 0;
  for (const i of inscripciones as FilaInscripcion[]) {
    const rel = Array.isArray(i.alumnos) ? i.alumnos[0] : i.alumnos;
    if (!rel?.nombre) { huerfanas++; continue; }
    nombrePorInscripcion.set(i.id, rel.nombre);
  }
  if (huerfanas > 0) {
    console.warn(`[ASISTENCIA] asistenciaGrupoResumen: ${huerfanas} inscripción(es) activa(s) sin alumno enlazado, excluida(s) del conteo (grupo ${grupoId})`);
  }
  const inscripcionIds = Array.from(nombrePorInscripcion.keys());
  if (inscripcionIds.length === 0) {
    console.log(`[ASISTENCIA][chat] ts=${timestampConsulta} fecha=${fecha} grupo=${grupoId} presentes=0 faltas=0 retardos=0 sinRegistrar=0 origen=asistenciaGrupoResumen — todas las inscripciones eran huérfanas`);
    return vacio;
  }

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
    const estadoOficial = clasificarEstadoAsistencia(estatusHoyPorInscripcion.get(inscripcionId));
    if (estadoOficial === 'presente') vacio.presentes.push(nombre);
    else if (estadoOficial === 'falta') vacio.faltas.push(nombre);
    else if (estadoOficial === 'retardo') vacio.retardos.push(nombre);
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
  if (totalClasificados !== inscripcionIds.length) {
    console.error(
      `[VALIDACION] asistenciaGrupoResumen: inconsistencia — ${totalClasificados} alumnos clasificados vs ${inscripcionIds.length} inscripciones activas válidas (grupo ${grupoId}, fecha ${fecha})`
    );
  }

  // Log temporal de diagnóstico (ver "Corregir inconsistencia entre
  // Lista y Chat IA en el resumen de asistencia") — comparar esta
  // línea contra el log equivalente de app/dashboard/lista/page.tsx
  // (mismo grupo, misma fecha) es la forma directa de confirmar que
  // ambos lados están leyendo exactamente el mismo registro. Quitar
  // una vez confirmado en producción.
  console.log(
    `[ASISTENCIA][chat] ts=${timestampConsulta} fecha=${fecha} grupo=${grupoId} presentes=${vacio.presentes.length} faltas=${vacio.faltas.length} retardos=${vacio.retardos.length} sinRegistrar=${vacio.sinRegistrarHoy.length} total=${totalClasificados} origen=asistenciaGrupoResumen`
  );

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

// Único origen de verdad para el grado/grupo que usa TODO el pipeline
// de documentos (encabezados, PDA/contenidos vía MARCO_CURRICULAR_
// VIGENTE, planeaciones) — ver lib/documentGen/encabezadoDocumento.ts
// y lib/asistente/perfilDocente.ts. Deliberadamente escribe SOLO en
// perfiles_docentes, nunca en la tabla grupos (grupos de Lista/
// asistencia): un docente puede tener varias filas en grupos a la vez
// (una por grado/grupo distinto en el mismo ciclo escolar), así que no
// hay forma segura de adivinar cuál de ellas "actualizar" desde una
// frase de chat sin arriesgar corromper la asistencia/roster de un
// grupo equivocado — ver "Correcciones del módulo Chat IA".
// grado/grupo en perfiles_docentes son texto libre validado solo por
// el selector de onboarding (app/onboarding/page.tsx): grado incluye
// el símbolo ("4°"), grupo es una letra sola ("B").
export type CambiosPerfilDocente = { grado?: string; grupo?: string };
export type ResultadoActualizarPerfil = { exito: boolean; error?: string; anterior: { grado: string | null; grupo: string | null } };

export async function actualizarPerfilDocente(
  sb: SupabaseClient,
  userId: string,
  cambios: CambiosPerfilDocente
): Promise<ResultadoActualizarPerfil> {
  const { data: perfilAnterior } = await sb.from('perfiles_docentes').select('grado, grupo').eq('id', userId).single();
  const anterior = { grado: perfilAnterior?.grado ?? null, grupo: perfilAnterior?.grupo ?? null };

  if (!cambios.grado && !cambios.grupo) return { exito: true, anterior };

  const { error } = await sb.from('perfiles_docentes').update(cambios).eq('id', userId);
  if (error) return { exito: false, error: error.message, anterior };

  return { exito: true, anterior };
}

export type RegistroAsistencia = { alumno_id: string; estado: 'presente' | 'falta' | 'retardo' };
export type ResultadoEscrituraAsistencia = { exito: boolean; error?: string; guardados: number };

// Fuente única de verdad para ESCRIBIR asistencia — un alumno o varios
// a la vez, misma función. app/api/asistencia-guardar/route.ts (Lista,
// guardado por lote) y la Herramienta de voz/chat (lib/asistente/
// herramientas/asistencia.ts, mismo endpoint) llaman aquí, en vez de
// cada uno reimplementar el upsert por su cuenta. Nunca reporta éxito
// sin que Supabase confirme la escritura real — devuelve
// { exito:false, error } ante cualquier falla, para que quien llama
// pueda responder con honestidad en vez de asumir que ya quedó
// guardado (ver CORRECCIÓN — nunca confirmar una operación antes de
// verificarla).
//
// CAUSA RAÍZ corregida (ver "Sprint LISTA DE ALUMNOS — Guardado de
// asistencia"): antes, esta función escribía PRIMERO en la tabla
// legada `asistencias` (esa escritura determinaba `exito`), y
// `asistencia_registro` — la tabla que la propia aplicación declaró
// "único origen de verdad" para los contadores de Lista y todo lo que
// reporta el Chat IA (ver "Unificar los 4 estados oficiales de
// asistencia") — se escribía DESPUÉS, "de mejor esfuerzo": si fallaba,
// solo se registraba en consola, sin afectar el resultado. Un docente
// podía ver "✅ Asistencia guardada" mientras la tabla que de verdad
// se lee para reportar asistencia se quedaba sin ese registro, en
// silencio. Ahora el orden y la prioridad se invierten: la escritura a
// asistencia_registro es la que determina éxito/error; la tabla legada
// se sincroniza DESPUÉS, de mejor esfuerzo, mientras siga existiendo.
//
// DEPENDENCIAS REALES DE LA TABLA LEGADA `asistencias` (documentadas
// aquí, no se elimina la tabla en este sprint — ver instrucción
// explícita "no eliminar todavía la tabla antigua"):
//   1. app/dashboard/lista/[alumnoId]/page.tsx (pestaña "Asistencia" y
//      tarjetas del resumen) — SÍ la lee y la muestra al docente; es
//      la única lectura real que depende de ella hoy.
//   2. app/dashboard/lista/page.tsx — todavía la consulta (línea ~133)
//      pero su resultado ya NO se muestra desde la corrección anterior
//      de este mismo sprint ("Historial del alumno" se movió a la
//      ficha individual) — consulta viva, dato sin usar. Limpieza
//      pendiente, fuera de alcance de esta corrección puntual.
//   3. app/api/chat/route.ts (intención registrar_asistencia, "pasa
//      lista" masivo) — ya sincroniza esta misma tabla legada por su
//      cuenta, de mejor esfuerzo, DESPUÉS de la escritura oficial vía
//      la RPC registrar_asistencia_masiva — mismo criterio que se
//      aplica aquí ahora, ya era consistente. No se tocó (fuera del
//      Sprint Lista de Alumnos).
// Mientras el punto 1 exista, la tabla legada no se puede eliminar sin
// antes migrar esa pestaña a leer asistencia_registro.
export async function escribirAsistencia(
  sb: SupabaseClient,
  registros: RegistroAsistencia[],
  fecha: string,
  grupoId?: string | null
): Promise<ResultadoEscrituraAsistencia> {
  if (registros.length === 0) return { exito: true, guardados: 0 };

  // 1. Resolver la inscripción activa de cada alumno — necesaria para
  // escribir en asistencia_registro (vía inscripcion_id, no alumno_id).
  // Acotar por grupoId cuando se conoce evita que un alumno con más de
  // una inscripción activa (excepcional, pero posible entre ciclos)
  // reciba el registro en el grupo equivocado — la misma clase de
  // divergencia que causaba que Lista y el Chat IA mostraran totales
  // distintos para "el mismo grupo" (ver "Corregir inconsistencia
  // entre Lista y Chat IA en el resumen de asistencia").
  const alumnoIds = registros.map((r) => r.alumno_id);
  let consultaInscripciones = sb.from('inscripciones').select('id, alumno_id').in('alumno_id', alumnoIds).eq('estatus', 'activo');
  if (grupoId) consultaInscripciones = consultaInscripciones.eq('grupo_id', grupoId);
  const { data: inscripcionesActivas, error: errorInscripciones } = await consultaInscripciones;

  if (errorInscripciones) {
    return { exito: false, error: errorInscripciones.message, guardados: 0 };
  }

  const inscripcionPorAlumno = new Map(
    ((inscripcionesActivas || []) as { id: string; alumno_id: string }[]).map((i) => [i.alumno_id, i.id])
  );
  const registrosConInscripcion = registros.filter((r) => inscripcionPorAlumno.has(r.alumno_id));
  const registrosSinInscripcion = registros.filter((r) => !inscripcionPorAlumno.has(r.alumno_id));

  if (registrosSinInscripcion.length > 0) {
    // No es un error fatal (mismo criterio que antes: un alumno sin
    // inscripción activa resoluble simplemente no puede tener un
    // registro oficial), pero ya no queda en silencio — antes esto se
    // descartaba sin ningún rastro.
    console.error(
      `escribirAsistencia: ${registrosSinInscripcion.length} alumno(s) sin inscripción activa resoluble — sin registro oficial en asistencia_registro:`,
      registrosSinInscripcion.map((r) => r.alumno_id)
    );
  }

  // 2. Escritura OFICIAL — asistencia_registro. Esto es lo que ahora
  // determina si se reporta éxito real al docente.
  let guardados = 0
  if (registrosConInscripcion.length > 0) {
    const filasRegistro = registrosConInscripcion.map((r) => ({
      inscripcion_id: inscripcionPorAlumno.get(r.alumno_id) as string,
      fecha,
      estatus: r.estado,
    }));
    const { data: dataRegistro, error: errorRegistro } = await sb
      .from('asistencia_registro')
      .upsert(filasRegistro, { onConflict: 'inscripcion_id,fecha' })
      .select();
    if (errorRegistro) return { exito: false, error: errorRegistro.message, guardados: 0 };
    guardados = dataRegistro?.length ?? 0
  }

  // 3. Sincronización de la tabla LEGADA `asistencias` — de mejor
  // esfuerzo mientras siga existiendo (ver dependencias documentadas
  // arriba). Si falla, NO cambia el resultado: la escritura oficial de
  // arriba ya tuvo éxito confirmado.
  const filasLegado = registros.map((r) => ({
    alumno_id: r.alumno_id,
    fecha,
    presente: r.estado !== 'falta',
    ...(grupoId ? { grupo_id: grupoId } : {}),
  }));
  const { error: errorLegado } = await sb.from('asistencias').upsert(filasLegado, { onConflict: 'alumno_id,fecha' });
  if (errorLegado) {
    console.error('Error al sincronizar la tabla legada asistencias (de mejor esfuerzo, no afecta el resultado ya confirmado):', errorLegado);
  }

  return { exito: true, guardados };
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
