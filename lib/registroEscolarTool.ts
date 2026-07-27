// Chat IA — Registro escolar desde imagen (ver lib/motorContexto.ts:
// ejecutarRegistroEscolar). A diferencia de construirHerramientaConsultaOficial
// (server-side, Anthropic ejecuta web_search sola), esta es una tool
// client-side: cuando Claude la invoca, nuestro backend tiene que
// ejecutar el guardado real en Supabase y devolver un tool_result antes
// de que la conversación pueda continuar (ver el manejo de
// content_block_start/delta/stop en app/api/chat/route.ts). Solo se
// agrega a `tools` cuando hay imagen adjunta este turno
// (requiereRegistroEscolar) — en texto plano ya lo cubre el
// Clasificador de Nivel 0 (registrar_incidencia, etc.), sin gastar la
// tool en cada turno.
export function construirHerramientaRegistroEscolar() {
  return {
    name: 'registrar_dato_escolar',
    description:
      'Registra en la base de datos información escolar real extraída de una imagen o mensaje del maestro: calificaciones, asistencia, incidencias, evidencias o notas de perfil. Úsala solo cuando el maestro pida explícitamente guardar/registrar los datos que aparecen en la imagen — nunca para solo responder preguntas sobre ellos. No inventes valores para campos que no puedas leer con certeza en la imagen.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tipo: {
          type: 'string' as const,
          enum: ['calificacion', 'asistencia', 'incidencia', 'evidencia', 'nota_perfil'],
          description: 'Clasificación del dato según su naturaleza',
        },
        registros: {
          type: 'array' as const,
          description: 'Uno o más registros a guardar. Cada registro DEBE incluir "nombre_alumno" (el nombre tal como aparece escrito en la imagen o mensaje — nunca inventes un ID, el sistema resuelve el alumno real por nombre) más los demás campos según el tipo (ej. campo_formativo y calificacion para calificaciones; presente para asistencia).',
          items: {
            type: 'object' as const,
            properties: {
              nombre_alumno: {
                type: 'string' as const,
                description: 'Nombre del alumno tal como aparece escrito en la imagen o mensaje, sin modificarlo',
              },
            },
            required: ['nombre_alumno'],
          },
        },
        resumen: {
          type: 'string' as const,
          description: "Resumen breve en español para confirmarle al maestro qué se guardó, ej. '28 calificaciones de Lenguajes para 3°B'",
        },
      },
      required: ['tipo', 'registros', 'resumen'],
    },
  }
}
