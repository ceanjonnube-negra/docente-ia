// scripts/verificar-contexto-adjunto-programa-analitico.ts
//
// Prueba aislada (sin credenciales, sin red) de
// lib/programaAnalitico/contextoAdjuntoProgramaAnalitico.ts — PA-5B.
// Cubre la validación pura (fail-closed) y las barreras de guarda de
// extraerContextoPedagogicoAdjunto que nunca deben llegar a llamar a
// Anthropic (SIN_IMAGENES, DEMASIADAS_IMAGENES, FORMATO_NO_SOPORTADO).
// La integración completa (imagen real llega al prompt, se combina con
// el texto explícito, nunca se etiqueta como SEP) se prueba en
// scripts/verificar-manejar-turno-programa-analitico.ts (casos PA5B-*).
//
// Se ejecuta con `npx tsx scripts/verificar-contexto-adjunto-programa-analitico.ts`.

import type Anthropic from '@anthropic-ai/sdk'
import {
  extraerContextoPedagogicoAdjunto,
  validarContextoPedagogicoAdjunto,
  MAXIMO_IMAGENES_CONTEXTO_PA,
  type AdjuntoProgramaAnalitico,
} from '../lib/programaAnalitico/contextoAdjuntoProgramaAnalitico'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const anthropicNuncaLlamado = {
  messages: { stream: () => { throw new Error('anthropic.messages.stream NO debía invocarse.') } },
} as unknown as Anthropic

function anthropicConJson(json: object): Anthropic {
  return {
    messages: {
      stream: () => ({
        finalMessage: async () => ({
          content: [{ type: 'text', text: JSON.stringify(json) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 5 },
        }),
      }),
    },
  } as unknown as Anthropic
}

async function main() {
  // --- validarContextoPedagogicoAdjunto: fail-closed puro ---
  verificar(validarContextoPedagogicoAdjunto(null) === null, '1. null → inválido')
  verificar(validarContextoPedagogicoAdjunto('texto suelto') === null, '2. un string suelto (forma inesperada) → inválido')
  verificar(validarContextoPedagogicoAdjunto({}) === null, '3. objeto sin hayContextoPedagogico → inválido')

  {
    const r = validarContextoPedagogicoAdjunto({ hayContextoPedagogico: true, observaciones: [], lecturasDudosas: [] })
    verificar(r !== null && r.hayContextoPedagogico === false, '4. hayContextoPedagogico=true pero SIN observaciones → se degrada a false (nunca "hay contexto" sin nada concreto)')
  }
  {
    const r = validarContextoPedagogicoAdjunto({ hayContextoPedagogico: false, observaciones: ['algo'], lecturasDudosas: [] })
    verificar(r !== null && r.hayContextoPedagogico === false && r.observaciones.length === 0, '5. hayContextoPedagogico=false → observaciones se descartan aunque vengan, nunca se usan "de sobra"')
  }
  {
    const r = validarContextoPedagogicoAdjunto({ hayContextoPedagogico: true, observaciones: ['Dificultad de lectura.'], lecturasDudosas: ['un dato borroso'] })
    verificar(r !== null && r.hayContextoPedagogico === true && r.observaciones.length === 1 && r.lecturasDudosas.length === 1, '6. caso normal con observaciones y lecturas dudosas → ambas listas se conservan separadas')
  }
  {
    const observacionesLargas = Array.from({ length: 20 }, (_, i) => `observación ${i}`)
    const r = validarContextoPedagogicoAdjunto({ hayContextoPedagogico: true, observaciones: observacionesLargas, lecturasDudosas: [] })
    verificar(r !== null && r.observaciones.length <= 12, '7. más de 12 observaciones → se recorta al máximo, nunca se rechaza todo el objeto')
  }
  {
    const r = validarContextoPedagogicoAdjunto({ hayContextoPedagogico: true, observaciones: ['x'.repeat(500)], lecturasDudosas: [] })
    verificar(r !== null && r.observaciones[0].length <= 220, '8. una observación extremadamente larga se trunca, nunca se transporta completa')
  }
  {
    const r = validarContextoPedagogicoAdjunto({ hayContextoPedagogico: true, observaciones: [123, 'real', null], lecturasDudosas: [] })
    verificar(r !== null && r.observaciones.length === 1 && r.observaciones[0] === 'real', '9. entradas no-string dentro de observaciones se descartan silenciosamente, sin inventar nada')
  }

  // --- extraerContextoPedagogicoAdjunto: barreras de guarda (0 IA) ---
  {
    const adjunto: AdjuntoProgramaAnalitico = { origen: 'imagen', imagenes: [] }
    const r = await extraerContextoPedagogicoAdjunto(anthropicNuncaLlamado, adjunto)
    verificar(!r.ok && r.error.tipo === 'SIN_IMAGENES' && r.llamadaIa === false, '10. 0 imágenes → SIN_IMAGENES, nunca llama a Anthropic')
  }
  {
    const imagenes = Array.from({ length: MAXIMO_IMAGENES_CONTEXTO_PA + 1 }, () => ({ base64: 'x', mediaType: 'image/jpeg' as const }))
    const adjunto: AdjuntoProgramaAnalitico = { origen: 'imagen', imagenes }
    const r = await extraerContextoPedagogicoAdjunto(anthropicNuncaLlamado, adjunto)
    verificar(!r.ok && r.error.tipo === 'DEMASIADAS_IMAGENES' && r.llamadaIa === false, `11. más de ${MAXIMO_IMAGENES_CONTEXTO_PA} imágenes → DEMASIADAS_IMAGENES, nunca llama a Anthropic (nunca procesa un subconjunto silencioso)`)
  }
  {
    const adjunto = { origen: 'imagen', imagenes: [{ base64: 'x', mediaType: 'application/pdf' }] } as unknown as AdjuntoProgramaAnalitico
    const r = await extraerContextoPedagogicoAdjunto(anthropicNuncaLlamado, adjunto)
    verificar(!r.ok && r.error.tipo === 'FORMATO_NO_SOPORTADO' && r.llamadaIa === false, '12. mediaType fuera de la whitelist runtime → FORMATO_NO_SOPORTADO, nunca llama a Anthropic')
  }
  {
    // origen='documento' — contrato preparado (§11) pero NO implementado en PA-5B.
    const adjunto = { origen: 'documento', texto: 'x' } as unknown as AdjuntoProgramaAnalitico
    const r = await extraerContextoPedagogicoAdjunto(anthropicNuncaLlamado, adjunto)
    verificar(!r.ok && r.error.tipo === 'FORMATO_NO_SOPORTADO' && r.llamadaIa === false, "13. origen='documento' (futuro, no implementado) → falla de forma explícita y controlada, nunca llama a Anthropic ni finge soporte")
  }

  // --- extraerContextoPedagogicoAdjunto: camino real (1 llamada) ---
  {
    const anthropic = anthropicConJson({ hayContextoPedagogico: true, observaciones: ['Fortaleza en expresión oral.'], lecturasDudosas: [] })
    const adjunto: AdjuntoProgramaAnalitico = { origen: 'imagen', imagenes: [{ base64: 'x', mediaType: 'image/png' }] }
    const r = await extraerContextoPedagogicoAdjunto(anthropic, adjunto)
    verificar(r.ok === true && r.llamadaIa === true, '14. imagen válida → 1 llamada real, ok=true')
    verificar(r.ok === true && r.contexto.hayContextoPedagogico === true && r.contexto.observaciones[0] === 'Fortaleza en expresión oral.', '14b. observación real propagada tal cual (sin reescritura)')
    verificar(r.ok === true && typeof r.observabilidad.duracionMs === 'number' && r.observabilidad.tokensEntrada === 5 && r.observabilidad.tokensSalida === 5, '14c. observabilidad (duracionMs/tokens) se captura desde la respuesta real del SDK')
  }
  {
    const anthropic = anthropicConJson({ hayContextoPedagogico: false, observaciones: [], lecturasDudosas: [] })
    const adjunto: AdjuntoProgramaAnalitico = { origen: 'imagen', imagenes: [{ base64: 'x', mediaType: 'image/png' }] }
    const r = await extraerContextoPedagogicoAdjunto(anthropic, adjunto)
    verificar(r.ok === true && r.contexto.hayContextoPedagogico === false, '15. imagen sin contenido pedagógico → hayContextoPedagogico=false explícito, no se fuerza nada')
  }
  {
    const anthropicJsonInvalido = {
      messages: { stream: () => ({ finalMessage: async () => ({ content: [{ type: 'text', text: 'esto no es json' }], stop_reason: 'end_turn', usage: {} }) }) },
    } as unknown as Anthropic
    const adjunto: AdjuntoProgramaAnalitico = { origen: 'imagen', imagenes: [{ base64: 'x', mediaType: 'image/png' }] }
    const r = await extraerContextoPedagogicoAdjunto(anthropicJsonInvalido, adjunto)
    verificar(!r.ok && r.error.tipo === 'JSON_INVALIDO' && r.llamadaIa === true, '16. respuesta no-JSON del modelo → JSON_INVALIDO, fail-closed (nunca se intenta "rescatar" texto libre como observación)')
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
