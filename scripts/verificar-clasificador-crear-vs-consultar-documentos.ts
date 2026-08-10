// scripts/verificar-clasificador-crear-vs-consultar-documentos.ts
//
// Prueba aislada de "fallo reproducible: pedir un examen nuevo
// respondió con el listado de documentos generados" — causa raíz real
// (no un regex, ver diagnóstico entregado): el Clasificador de Nivel 0
// (lib/clasificadorNivel0.ts, una llamada aparte a Claude que corre
// SIEMPRE antes de MODO DOCUMENTO) no tenía ninguna regla explícita
// para "crear un examen/citatorio/rúbrica/cuento" — la única mención
// de la palabra "examen" en todo su prompt vivía dentro de la regla 7
// (consultar_documentos), así que un mensaje como "Hazme un examen
// completo de..." terminaba clasificado como consultar_documentos en
// vez de caer al fallback conversacion_general (que sí deja pasar el
// mensaje al generador de documentos real, ya corregido en la ronda
// anterior). El dispatcher (lib/asistente/herramientasModulo.ts,
// REGISTRO['consultar_documentos']) ejecuta la Herramienta y regresa
// su texto de inmediato — Claude/MODO DOCUMENTO nunca llegan a correr
// ese turno.
//
// Corrección: excepción explícita en la regla 7, mismo patrón ya
// usado por la regla 8 (consultar_calendario) para no competir con
// planeacion_generar — un verbo de creación (Hazme/Crea/Genera/
// Prepara/Necesito/Redacta) pidiendo un documento NUEVO nunca cae en
// consultar_documentos.
//
// EJECUCIÓN REAL contra el modelo (es un prompt de clasificación por
// LLM — un chequeo estático del texto del prompt no demuestra que el
// modelo de verdad clasifica distinto; hace falta la llamada real,
// mismo criterio de rigor ya establecido en esta sesión para
// arquitecturas/decisiones que dependen de IA).
// Se ejecuta con
// `npx tsx scripts/verificar-clasificador-crear-vs-consultar-documentos.ts`.
// Requiere ANTHROPIC_API_KEY real (hace llamadas de verdad a Claude).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clasificarNivel0 } from '../lib/clasificadorNivel0'
import type { SesionContexto } from '../lib/sesionContexto'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const RAIZ = join(__dirname, '..')
const cuerpoClasificador = readFileSync(join(RAIZ, 'lib/clasificadorNivel0.ts'), 'utf-8')

const sesion: SesionContexto = {
  grupo_activo_id: 'grupo-test',
  ciclo_escolar_id: 'ciclo-test',
  alumnos_del_grupo_activo: [],
} as unknown as SesionContexto

// El mensaje EXACTO reportado en el fallo real de iPhone.
const MENSAJE_REPORTADO =
  'Hazme un examen completo de Ciencias sobre el ciclo del agua para 4° de primaria, con 10 reactivos variados, instrucciones claras, nombre del alumno, fecha y espacio suficiente para responder. Genera únicamente Word.'

const CASOS_CREACION = [
  MENSAJE_REPORTADO,
  'Hazme un examen completo de matemáticas sobre multiplicaciones y divisiones para 4° de primaria.',
  'Genera un citatorio para los padres de familia.',
  'Necesito una rúbrica de evaluación para un proyecto de ciencias.',
]

const CASOS_CONSULTA = [
  '¿Qué documentos tengo generados?',
  'Muéstrame mis exámenes generados.',
  '¿Cuáles documentos he generado hasta ahora?',
  'Lista mis documentos.',
]

async function main() {
  // ============================================================
  // 1. Verificación estructural — la excepción existe en el prompt
  //    real, con el mismo patrón que la regla 8 ya usaba.
  // ============================================================
  verificar(cuerpoClasificador.includes('Excepción — NUNCA uses esta regla si el mensaje usa un verbo de creación'), 'La regla 7 tiene la excepción explícita para verbos de creación')
  verificar(cuerpoClasificador.includes('eso es una solicitud de CREACIÓN, no una consulta'), 'La excepción distingue creación de consulta explícitamente')

  // ============================================================
  // 2. Ejecución REAL contra el modelo — el mensaje exacto reportado,
  //    y variantes de creación, NUNCA deben clasificarse como
  //    consultar_documentos.
  // ============================================================
  for (const caso of CASOS_CREACION) {
    const r = await clasificarNivel0(caso, sesion, [])
    verificar(r.intencion_principal !== 'consultar_documentos', `"${caso.slice(0, 70)}..." NO se clasifica como consultar_documentos (obtenido: ${r.intencion_principal})`)
  }

  // ============================================================
  // 3. Sin regresión — las consultas reales sobre documentos ya
  //    generados siguen funcionando exactamente igual.
  // ============================================================
  for (const caso of CASOS_CONSULTA) {
    const r = await clasificarNivel0(caso, sesion, [])
    verificar(r.intencion_principal === 'consultar_documentos', `"${caso}" sigue siendo consultar_documentos (obtenido: ${r.intencion_principal})`)
  }

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
