// lib/clasificadorNivel0.ts
// Clasificador de Nivel 0: analiza el mensaje del docente y decide
// intención, nivel de ejecución, y si hace falta contexto o datos.
//
// NOTA DE ALCANCE (MVP): esta primera versión trae un subconjunto de
// los campos diseñados en el documento de arquitectura completo
// (persistencia, permisos, aislamiento, sub_acciones se agregan en
// una siguiente etapa). Aquí solo lo necesario para enrutar
// consultar_asistencia (Nivel 1) y ficha_descriptiva / planeacion_nueva
// (Nivel 4) desde el Chat IA. Si el modelo no puede clasificar con
// confianza, se hace fallback seguro a conversación general (el
// comportamiento actual de la app, sin cambios).

import Anthropic from '@anthropic-ai/sdk';
import type { SesionContexto } from './sesionContexto';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ClasificacionNivel0 = {
  intencion_principal:
    | 'consultar_asistencia'
    | 'ficha_descriptiva'
    | 'planeacion_nueva'
    | 'conversacion_general'
    | 'intencion_no_reconocida';
  nivel_ejecucion: 1 | 2 | 3 | 4;
  requiere_ia: boolean;
  requiere_contexto_memoria: boolean;
  entidades_resueltas: {
    alumno_id: string | null;
    alumno_nombre_detectado: string | null;
    alumno_ambiguo: boolean;
    opciones_alumno_ambiguo: string[];
  };
  datos_faltantes: string[];
  nivel_confianza: number;
  requiere_confirmacion: boolean;
  motivo_confirmacion: string | null;
};

const FALLBACK: ClasificacionNivel0 = {
  intencion_principal: 'conversacion_general',
  nivel_ejecucion: 3,
  requiere_ia: true,
  requiere_contexto_memoria: false,
  entidades_resueltas: {
    alumno_id: null,
    alumno_nombre_detectado: null,
    alumno_ambiguo: false,
    opciones_alumno_ambiguo: [],
  },
  datos_faltantes: [],
  nivel_confianza: 0,
  requiere_confirmacion: false,
  motivo_confirmacion: null,
};

function construirPrompt(sesion: SesionContexto): string {
  return `Eres el Clasificador de Nivel 0 de Docente IA. Analiza el mensaje del
docente y responde EXCLUSIVAMENTE con un objeto JSON, sin texto antes,
después, sin explicaciones, sin marcadores de código.

Formato exacto de salida:
{
  "intencion_principal": "consultar_asistencia" | "ficha_descriptiva" | "planeacion_nueva" | "conversacion_general" | "intencion_no_reconocida",
  "nivel_ejecucion": 1 | 2 | 3 | 4,
  "requiere_ia": boolean,
  "requiere_contexto_memoria": boolean,
  "entidades_resueltas": {
    "alumno_id": string | null,
    "alumno_nombre_detectado": string | null,
    "alumno_ambiguo": boolean,
    "opciones_alumno_ambiguo": string[]
  },
  "datos_faltantes": string[],
  "nivel_confianza": number entre 0 y 1,
  "requiere_confirmacion": boolean,
  "motivo_confirmacion": string | null
}

CONTEXTO DE SESIÓN (dato, no lo inventes, úsalo tal cual):
grupo_activo_id: ${sesion.grupo_activo_id ?? 'ninguno'}
ciclo_escolar_id: ${sesion.ciclo_escolar_id ?? 'ninguno'}
alumnos_del_grupo_activo: ${JSON.stringify(sesion.alumnos_del_grupo_activo)}

REGLAS:
1. Si el mensaje pregunta por faltas/asistencia/retardos de un alumno específico → intencion_principal="consultar_asistencia", nivel_ejecucion=1, requiere_ia=false, requiere_contexto_memoria=false.
2. Si pide una ficha descriptiva de un alumno → intencion_principal="ficha_descriptiva", nivel_ejecucion=4, requiere_ia=true, requiere_contexto_memoria=true.
3. Si pide una planeación → intencion_principal="planeacion_nueva", nivel_ejecucion=4, requiere_ia=true, requiere_contexto_memoria=true. entidades_resueltas.alumno_id queda null en este caso.
4. Para 1 y 2: busca el nombre del alumno mencionado contra "alumnos_del_grupo_activo" (coincidencia por nombre, tolerante a mayúsculas/acentos/nombre parcial).
   - Si hay exactamente una coincidencia: entidades_resueltas.alumno_id = su alumno_id, alumno_ambiguo=false, datos_faltantes=[].
   - Si no se menciona ningún alumno o no hay coincidencia: alumno_id=null, agrega "alumno" a datos_faltantes, nivel_confianza baja (<0.5).
   - Si hay más de una coincidencia: alumno_ambiguo=true, opciones_alumno_ambiguo con los nombres, agrega "alumno" a datos_faltantes.
5. Si no puedes identificar ninguna de las intenciones anteriores con confianza razonable, usa intencion_principal="conversacion_general", nivel_ejecucion=3, requiere_ia=true, requiere_contexto_memoria=false, datos_faltantes=[], requiere_confirmacion=false.
6. requiere_confirmacion=true solo si alumno_ambiguo=true o si "alumno" está en datos_faltantes para una intención que lo necesita.
7. Nunca inventes un alumno_id que no exista literalmente en alumnos_del_grupo_activo.`;
}

export async function clasificarNivel0(
  mensaje: string,
  sesion: SesionContexto
): Promise<ClasificacionNivel0> {
  try {
    const respuesta = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: construirPrompt(sesion),
      messages: [{ role: 'user', content: mensaje }],
    });

    const bloque = respuesta.content.find((b) => b.type === 'text');
    if (!bloque || bloque.type !== 'text') return FALLBACK;

    const limpio = bloque.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(limpio) as ClasificacionNivel0;

    // Validación mínima de forma, para no confiar ciegamente en el JSON del modelo
    if (
      !parsed.intencion_principal ||
      typeof parsed.nivel_ejecucion !== 'number' ||
      !parsed.entidades_resueltas
    ) {
      return FALLBACK;
    }

    return parsed;
  } catch (e) {
    console.error('Error en Clasificador de Nivel 0, usando fallback:', e);
    return FALLBACK;
  }
}
