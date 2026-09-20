// scripts/verificar-clasificador-programa-analitico.ts
//
// Prueba REAL (llamadas reales a Anthropic vía clasificarNivel0 — mismo
// patrón ya usado en scripts/verificar-clasificador-crear-vs-consultar-documentos.ts
// y scripts/verificar-aprobar-borrador-planeacion.ts) de la nueva
// regla 26 de Nivel 0 (programa_analitico) — PA-4D §19, casos 1, 3, 9,
// y no-regresión de planeacion_generar/consultar_documentos.
//
// Requiere ANTHROPIC_API_KEY real. Ejecutar con:
// node --env-file=.env.local --import tsx scripts/verificar-clasificador-programa-analitico.ts

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

const sesion: SesionContexto = {
  grupo_activo_id: 'grupo-test',
  ciclo_escolar_id: 'ciclo-test',
  alumnos_del_grupo_activo: [],
} as unknown as SesionContexto

async function main() {
  // --- 1. "ayúdame con mi Programa Analítico" → capacidad correcta ---
  {
    const r = await clasificarNivel0('Ayúdame a hacer mi Programa Analítico.', sesion, [])
    verificar(r.intencion_principal === 'programa_analitico', `1. "ayúdame a hacer mi Programa Analítico" → programa_analitico (obtenido: ${r.intencion_principal})`)
  }
  {
    const r = await clasificarNivel0('Quiero armar el Programa Analítico de mi grupo.', sesion, [])
    verificar(r.intencion_principal === 'programa_analitico', `1b. "quiero armar el Programa Analítico" → programa_analitico (obtenido: ${r.intencion_principal})`)
  }

  // --- 3. siguiente turno contextual → se reconoce como continuación ---
  {
    const historial = [
      { role: 'user' as const, content: 'Ayúdame a hacer mi Programa Analítico.' },
      { role: 'assistant' as const, content: 'Ya tengo identificado tu grupo de 4.° de primaria y el currículo correspondiente. Para contextualizar tu Programa Analítico, cuéntame brevemente qué características, necesidades o situaciones de tu grupo o comunidad quieres que tome en cuenta.' },
    ]
    const r = await clasificarNivel0('En mi grupo hay dificultades de comprensión lectora y quiero reforzar la lectura.', sesion, historial)
    verificar(r.intencion_principal === 'programa_analitico', `3. respuesta de contexto sin mencionar "Programa Analítico" tras la pregunta → sigue siendo programa_analitico (obtenido: ${r.intencion_principal})`)
    verificar(r.accion_programa_analitico === 'gestionar', `3b. accion_programa_analitico="gestionar" (obtenido: ${r.accion_programa_analitico})`)
  }

  // --- 9. "sí" con borrador pendiente e inmediatez válida → confirmar ---
  {
    const historial = [
      { role: 'user' as const, content: 'Ayúdame a hacer mi Programa Analítico, en mi grupo hay dificultades de lectura.' },
      {
        role: 'assistant' as const,
        content:
          'He preparado una propuesta para tu Programa Analítico.\n\nSe conservaron 82 contenidos oficiales sin cambios y contextualicé 3 para las necesidades que me comentaste. No agregué contenidos locales nuevos.\n\nSi quieres, puedo ajustar algo antes de dejarlo como versión vigente. Cuando estés de acuerdo, dime que lo confirme.',
      },
    ]
    const r = await clasificarNivel0('Sí, confírmalo.', sesion, historial)
    verificar(r.intencion_principal === 'programa_analitico', `9. "sí, confírmalo" tras un resumen de propuesta → programa_analitico (obtenido: ${r.intencion_principal})`)
    verificar(r.accion_programa_analitico === 'confirmar', `9b. accion_programa_analitico="confirmar" (obtenido: ${r.accion_programa_analitico})`)
  }
  // "sí" SIN ningún resumen previo nunca debe leerse como confirmación de PA.
  {
    const r = await clasificarNivel0('Sí, está bien.', sesion, [{ role: 'user' as const, content: 'Hola' }, { role: 'assistant' as const, content: '¿En qué te ayudo hoy?' }])
    verificar(r.intencion_principal !== 'programa_analitico' || r.accion_programa_analitico !== 'confirmar', '9c. "sí" sin ningún resumen de PA previo nunca se clasifica como confirmar programa_analitico')
  }

  // --- distinción con planeacion_generar (no debe degradarse) ---
  {
    const r = await clasificarNivel0('Hazme una planeación de leyendas para dos semanas.', sesion, [])
    verificar(r.intencion_principal === 'planeacion_generar', `21. "hazme una planeación de leyendas" sigue siendo planeacion_generar (obtenido: ${r.intencion_principal})`)
  }
  {
    const r = await clasificarNivel0('¿Qué PDA del Programa Analítico corresponden a leyendas?', sesion, [])
    verificar(r.intencion_principal === 'programa_analitico', `1c. consulta de PDA del Programa Analítico → programa_analitico (obtenido: ${r.intencion_principal})`)
    verificar(r.accion_programa_analitico === 'consultar', `1d. accion_programa_analitico="consultar" (obtenido: ${r.accion_programa_analitico})`)
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
