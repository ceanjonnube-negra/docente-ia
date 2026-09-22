// scripts/verificar-oficial-primero-programa-analitico.ts
//
// PA-5J — regla permanente del generador: "OFICIAL PRIMERO, LOCAL SOLO
// CUANDO SEA NECESARIO". Nunca se confía en que el prompt por sí solo
// evite un contenido local redundante (ver PA-5I: dos contenidos
// locales del primer borrador real solapaban cobertura oficial ya
// contextualizada) — el servidor exige que toda decisión "nuevo"
// declare una justificación real de por qué la cobertura oficial
// evaluada fue insuficiente, y rechaza (fail-closed, mismo criterio
// que cualquier otro campo obligatorio ausente) cualquier "nuevo" que
// no la incluya. 0 llamadas IA nuevas: la validación es pura,
// determinista, sobre la respuesta que la ÚNICA llamada de generación
// ya iba a hacer.
//
// Prueba aislada (sin Anthropic real) de incorporarDeltasIa —
// función pura, sin I/O. La verificación de que la ÚNICA llamada IA
// real ya existente sigue funcionando (con el prompt actualizado) está
// cubierta por scripts/verificar-generador-programa-analitico.ts
// (test 12, real).
//
// Se ejecuta con
// `npx tsx scripts/verificar-oficial-primero-programa-analitico.ts`.

import { readFileSync } from 'node:fs'
import { incorporarDeltasIa } from '../lib/programaAnalitico/generarPropuestaProgramaAnalitico'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const cuerpoGenerador = readFileSync(new URL('../lib/programaAnalitico/generarPropuestaProgramaAnalitico.ts', import.meta.url), 'utf-8')

async function main() {
  // ============================================================
  // CASO A/B/C — el PRINCIPIO está en el prompt real que la única
  // llamada de generación ya envía (verificación estructural, nunca
  // una nueva llamada IA para "probar" que el modelo obedece).
  // ============================================================
  verificar(cuerpoGenerador.includes('PRINCIPIO OBLIGATORIO — OFICIAL PRIMERO'), 'A. el prompt real declara explícitamente el principio "oficial primero"')
  verificar(
    cuerpoGenerador.includes('Si existe cobertura oficial suficiente, o si la cobertura es parcial pero puede resolverse razonablemente contextualizando, DEBES usar "contextualizar" en vez de "nuevo"'),
    'B. el prompt indica explícitamente preferir "contextualizar" también cuando la cobertura oficial es solo PARCIAL pero resoluble'
  )
  verificar(
    cuerpoGenerador.includes('"nuevo" se reserva EXCLUSIVAMENTE para una necesidad contextual relevante que el catálogo oficial entregado no pueda representar de forma razonable'),
    'C. el prompt reserva "nuevo" explícitamente para cobertura oficial insuficiente — nunca como primera opción'
  )
  verificar(cuerpoGenerador.includes('justificacionContenidoNuevo'), 'el esquema JSON del prompt exige justificacionContenidoNuevo para toda decisión "nuevo"')

  // ============================================================
  // CASO D — local SIN justificación → rechazo fail-closed.
  // ============================================================
  {
    const sinJustificacion = incorporarDeltasIa({ decisiones: [{ decision: 'nuevo', textoLocal: 'Contenido local sin justificar.' }] })
    verificar(sinJustificacion.ok === false, 'CASO-D. "nuevo" sin justificacionContenidoNuevo → rechazado (ok:false)')
  }
  {
    const justificacionVacia = incorporarDeltasIa({ decisiones: [{ decision: 'nuevo', textoLocal: 'x', justificacionContenidoNuevo: '   ' }] })
    verificar(justificacionVacia.ok === false, 'CASO-D2. justificacionContenidoNuevo solo espacios en blanco → rechazado (fail-closed, no basta con que el campo "exista")')
  }
  {
    const justificacionMuyCorta = incorporarDeltasIa({ decisiones: [{ decision: 'nuevo', textoLocal: 'x', justificacionContenidoNuevo: 'no' }] })
    verificar(justificacionMuyCorta.ok === false, 'CASO-D3. justificacionContenidoNuevo demasiado corta (< 10 caracteres) → rechazada')
  }
  {
    const justificacionValida = incorporarDeltasIa({
      decisiones: [{ decision: 'nuevo', textoLocal: 'x', justificacionContenidoNuevo: 'Ningún contenido oficial del catálogo entregado cubre esta necesidad específica del grupo.' }],
    })
    verificar(justificacionValida.ok === true, 'CASO-D4. justificacionContenidoNuevo real y suficiente → se acepta con normalidad')
  }

  // ============================================================
  // CASO E — un "nuevo" con curriculoContenidoId oficial (inventado o
  // real) NUNCA se propaga — incorporarDeltasIa solo lee las claves
  // esperadas de "nuevo" (textoLocal/resultadoEsperadoLocal), igual
  // que ya hacía con grupoId/curriculoVersionId (test 12b existente).
  // ============================================================
  {
    const conIdInventado = incorporarDeltasIa({
      decisiones: [
        {
          decision: 'nuevo',
          textoLocal: 'x',
          curriculoContenidoId: 'id-oficial-inventado-por-la-ia',
          justificacionContenidoNuevo: 'Ningún contenido oficial cubre esta necesidad.',
        },
      ],
    })
    verificar(conIdInventado.ok === true, 'CASO-E. un "nuevo" con curriculoContenidoId (inventado) sigue aceptándose (el campo simplemente no se lee para este tipo)')
    if (conIdInventado.ok) {
      const decision = conIdInventado.decisiones[0] as Record<string, unknown>
      verificar(!('curriculoContenidoId' in decision), 'CASO-E2. curriculoContenidoId de un "nuevo" NUNCA se propaga a la decisión incorporada — imposible que termine falsificando un id oficial')
    }
  }

  // ============================================================
  // CASO F — un "nuevo" nunca puede presentarse como oficial: la forma
  // persistida de un "nuevo" (DeltaBorrador) nunca tiene
  // curriculoContenidoId, solo claveLocal — verificado estructuralmente
  // en el tipo real (borradorProgramaAnalitico.ts) y en que
  // incorporarDeltasIa jamás agrega esa clave para "nuevo".
  // ============================================================
  {
    const tiposBorrador = readFileSync(new URL('../lib/programaAnalitico/borradorProgramaAnalitico.ts', import.meta.url), 'utf-8')
    const bloqueTipoDelta = tiposBorrador.slice(tiposBorrador.indexOf('export type DeltaBorrador ='), tiposBorrador.indexOf('export type BorradorProgramaAnalitico'))
    verificar(
      /\{\s*decision:\s*'nuevo';\s*claveLocal:\s*string;\s*textoLocal:\s*string;\s*resultadoEsperadoLocal\?:\s*string\s*\|\s*null\s*\}/.test(bloqueTipoDelta),
      'CASO-F. la forma persistida de "nuevo" (DeltaBorrador) nunca incluye curriculoContenidoId — no puede presentarse como contenido oficial ni siquiera por accidente de tipos'
    )
  }

  // ============================================================
  // CASO G — contextualizar/excluir: comportamiento existente
  // intacto, sin ningún campo nuevo exigido por PA-5J.
  // ============================================================
  {
    const contextualizarNormal = incorporarDeltasIa({
      decisiones: [{ decision: 'contextualizar', curriculoContenidoId: 'x', textoContextualizado: 'Texto contextualizado.' }],
    })
    verificar(contextualizarNormal.ok === true, 'CASO-G. "contextualizar" normal (sin cambios de PA-5J) sigue aceptándose exactamente igual')
    const excluirNormal = incorporarDeltasIa({ decisiones: [{ decision: 'excluir', curriculoContenidoId: 'x' }] })
    verificar(excluirNormal.ok === true, 'CASO-G2. "excluir" normal sigue aceptándose exactamente igual — PA-5J solo endurece "nuevo"')
  }

  // ============================================================
  // CASO H — la base de 85 contenidos oficiales no se ve afectada:
  // PA-5J nunca toca construirBaseProgramaAnalitico ni el catálogo.
  // ============================================================
  {
    verificar(!cuerpoGenerador.slice(0, cuerpoGenerador.indexOf('export function construirBaseProgramaAnalitico') + 500).includes('justificacionContenidoNuevo'), 'CASO-H. construirBaseProgramaAnalitico (construcción determinista de los 85 candidatos) no fue tocada por esta regla — ningún contenido oficial puede desaparecer por esto')
  }

  // ============================================================
  // Costo — 0 IA adicional: incorporarDeltasIa sigue siendo una
  // función pura (sin fetch/Anthropic), misma UNA llamada de siempre.
  // ============================================================
  {
    const bloqueIncorporar = cuerpoGenerador.slice(cuerpoGenerador.indexOf('export function incorporarDeltasIa'), cuerpoGenerador.indexOf('function construirContextoNotasBase'))
    verificar(!/anthropic|messages\.create|messages\.stream|fetch\(/i.test(bloqueIncorporar), 'incorporarDeltasIa sigue siendo 100% pura — la validación de "oficial primero" no agrega ninguna llamada IA/red')
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
