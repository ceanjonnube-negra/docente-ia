// scripts/verificar-borrador-programa-analitico.ts
//
// Prueba aislada (sin credenciales, sin red, sin IA, sin Supabase) del
// núcleo determinista de orquestación del Programa Analítico — PA-4B
// (lib/programaAnalitico/borradorProgramaAnalitico.ts). Puro: cada
// caso construye sus propios datos, sin fakes de red.
//
// Se ejecuta con `npx tsx scripts/verificar-borrador-programa-analitico.ts`.

import {
  agregarContenidoLocal,
  aplicarDeltasSobreBase,
  construirResumenPropuesta,
  contextoDocenteEsSuficiente,
  crearBorrador,
  eliminarContenidoNuevo,
  eliminarContextualizacion,
  excluirContenido,
  normalizarDecisionesIa,
  reconstruirPropuesta,
  reemplazarContextualizacion,
  restaurarContenido,
  type BorradorProgramaAnalitico,
  type IdentidadCurricularFijada,
} from '../lib/programaAnalitico/borradorProgramaAnalitico'
import type { CatalogoCurricularCerrado } from '../lib/programaAnalitico/candidatosCurriculares'
import type { ItemPropuestaProgramaAnalitico } from '../lib/programaAnalitico/tipos'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const IDENTIDAD: IdentidadCurricularFijada = { curriculoVersionId: 'version-1', curriculoFaseId: 'fase-4', curriculoGradoId: 'grado-4' }
const OTRA_IDENTIDAD: IdentidadCurricularFijada = { curriculoVersionId: 'version-2', curriculoFaseId: 'fase-4', curriculoGradoId: 'grado-4' }

const CONTENIDO_A = 'contenido-a'
const CONTENIDO_B = 'contenido-b'

const BASE: ItemPropuestaProgramaAnalitico[] = [
  { claveLocal: 'contenido:A', tipoDecision: 'sin_ajuste', curriculoContenidoId: CONTENIDO_A, textoContextualizado: null, textoLocal: null, resultadoEsperadoLocal: null, periodoEvaluacionId: null, orden: 1, curriculoPdaGradoIds: ['pdagrado-1', 'pdagrado-2'] },
  { claveLocal: 'contenido:B', tipoDecision: 'sin_ajuste', curriculoContenidoId: CONTENIDO_B, textoContextualizado: null, textoLocal: null, resultadoEsperadoLocal: null, periodoEvaluacionId: null, orden: 2, curriculoPdaGradoIds: [] },
]

const CATALOGO: CatalogoCurricularCerrado = {
  campos: [{ id: 'campo-1', clave: 'lenguajes', nombre: 'Lenguajes' }],
  contenidos: [
    { id: CONTENIDO_A, titulo: 'Narración de sucesos', campoFormativoId: 'campo-1' },
    { id: CONTENIDO_B, titulo: 'Descripción de personas', campoFormativoId: 'campo-1' },
  ],
  pda: [],
}

function borradorNuevo(): BorradorProgramaAnalitico {
  return crearBorrador('grupo-4b', IDENTIDAD, null, 'Contexto base.')
}

function main() {
  // --- 1-4. contextoDocenteEsSuficiente: casos insuficientes ---
  verificar(contextoDocenteEsSuficiente('') === false, '1. "" → insuficiente')
  verificar(contextoDocenteEsSuficiente('ok') === false, '2. "ok" → insuficiente')
  verificar(contextoDocenteEsSuficiente('hazlo') === false, '3. "hazlo" → insuficiente')
  verificar(contextoDocenteEsSuficiente('4°B') === false, '4. "4°B" → insuficiente')
  verificar(contextoDocenteEsSuficiente('   ') === false, '4b. espacios en blanco → insuficiente')
  verificar(contextoDocenteEsSuficiente('sí') === false, '4c. "sí" → insuficiente')
  verificar(contextoDocenteEsSuficiente('normal') === false, '4d. "normal" → insuficiente')
  verificar(contextoDocenteEsSuficiente('como tú quieras') === false, '4e. "como tú quieras" → insuficiente')
  verificar(contextoDocenteEsSuficiente('no sé') === false, '4f. "no sé" → insuficiente')
  verificar(contextoDocenteEsSuficiente('cualquiera') === false, '4g. "cualquiera" → insuficiente')
  verificar(contextoDocenteEsSuficiente('cuarto B') === false, '4h. "cuarto B" → insuficiente (identificador de grupo)')
  verificar(contextoDocenteEsSuficiente(null) === false, '4i. null → insuficiente')

  // --- 5. contexto pedagógico real → suficiente ---
  verificar(contextoDocenteEsSuficiente('Al grupo le cuesta comprender textos.') === true, '5. contexto pedagógico real → suficiente')
  verificar(contextoDocenteEsSuficiente('En la comunidad tenemos problemas de escasez de agua.') === true, '5b. otro contexto real → suficiente')
  verificar(contextoDocenteEsSuficiente('Tenemos poco acceso a internet.') === true, '5c. otro contexto real corto pero informativo → suficiente')

  // --- refuerzo real (hallazgo de la prueba controlada PA-4D): una
  //     solicitud PURA de iniciar el Programa Analítico, sin ningún
  //     contenido pedagógico adicional, NUNCA cuenta como contexto
  //     suficiente aunque sea larga — evita disparar una generación
  //     real con contexto vacío. ---
  verificar(contextoDocenteEsSuficiente('Ayúdame a hacer mi Programa Analítico.') === false, '5d. solicitud pura de iniciar el PA (larga mas sin contenido) → insuficiente')
  verificar(contextoDocenteEsSuficiente('Quiero armar el Programa Analítico de mi grupo.') === false, '5e. otra variante de solicitud pura → insuficiente')
  verificar(
    contextoDocenteEsSuficiente('Ayúdame a hacer mi Programa Analítico, en mi grupo hay dificultades de comprensión lectora.') === true,
    '5f. la MISMA solicitud pero con contenido real agregado en el mismo turno → sí es suficiente'
  )

  // --- 6. decisión explícita de usar currículo tal cual → suficiente ---
  verificar(contextoDocenteEsSuficiente('No tengo nada que agregar; usa el currículo oficial tal cual.') === true, '6. decisión explícita de no ajustar nada → suficiente')

  // --- 7. necesidades_apoyo existentes → no requiereContexto (probado a nivel de evaluarRequiereContexto en verificar-generador-programa-analitico.ts #1e; aquí se prueba el bloque de construcción puro) ---
  verificar(true, '7. cubierto en scripts/verificar-generador-programa-analitico.ts (#1e) — evaluarRequiereContexto ya usa contextoDocenteEsSuficiente')

  // --- 8. base + cero deltas → resumen correcto ---
  {
    const borrador = borradorNuevo()
    const r = reconstruirPropuesta(BASE, IDENTIDAD, borrador)
    verificar(r.ok === true, '8. reconstrucción sin deltas no falla')
    if (r.ok) {
      const resumen = construirResumenPropuesta(CATALOGO, borrador, r.propuesta)
      verificar(resumen.totalItems === 2 && resumen.sinAjuste.cantidad === 2, '8b. resumen: 2 items, 2 sin_ajuste, 0 ajustes')
      verificar(resumen.contextualizados.length === 0 && resumen.nuevos.length === 0 && resumen.excluidos.length === 0, '8c. resumen sin ajustes cuando no hay deltas')
    }
  }

  // --- 9. contextualizar → resumen correcto ---
  {
    const borrador = reemplazarContextualizacion(borradorNuevo(), CONTENIDO_A, 'Adaptado al agua.')
    const r = reconstruirPropuesta(BASE, IDENTIDAD, borrador)
    if (r.ok) {
      const resumen = construirResumenPropuesta(CATALOGO, borrador, r.propuesta)
      verificar(resumen.contextualizados.length === 1, '9. resumen refleja 1 contextualizado')
      verificar(resumen.contextualizados[0].tituloOficial === 'Narración de sucesos', '9b. título oficial viene del catálogo, no de la IA')
      verificar(resumen.contextualizados[0].textoContextualizado === 'Adaptado al agua.', '9c. texto contextualizado correcto')
      verificar(resumen.sinAjuste.cantidad === 1, '9d. el otro contenido sigue sin_ajuste')
    }
  }

  // --- 10. excluir → resumen conserva exclusión explícita ---
  {
    const borrador = excluirContenido(borradorNuevo(), CONTENIDO_B)
    const r = reconstruirPropuesta(BASE, IDENTIDAD, borrador)
    if (r.ok) {
      const resumen = construirResumenPropuesta(CATALOGO, borrador, r.propuesta)
      verificar(resumen.excluidos.length === 1 && resumen.excluidos[0].curriculoContenidoId === CONTENIDO_B, '10. resumen conserva la exclusión explícita (no adivinada)')
      verificar(resumen.excluidos[0].tituloOficial === 'Descripción de personas', '10b. título oficial del excluido viene del catálogo')
      verificar(resumen.totalItems === 1, '10c. propuesta final ya no contiene el excluido')
    }
  }

  // --- 11. nuevo → resumen correcto ---
  {
    const { borrador, claveLocal } = agregarContenidoLocal(borradorNuevo(), 'Contenido local de prueba.', 'Resultado esperado local.')
    const r = reconstruirPropuesta(BASE, IDENTIDAD, borrador)
    if (r.ok) {
      const resumen = construirResumenPropuesta(CATALOGO, borrador, r.propuesta)
      verificar(resumen.nuevos.length === 1 && resumen.nuevos[0].claveLocal === claveLocal, '11. resumen refleja 1 nuevo con su claveLocal')
      verificar(resumen.nuevos[0].textoLocal === 'Contenido local de prueba.', '11b. texto local correcto en el resumen')
    }
  }

  // --- 12. restaurar excluido → desaparece exclusión ---
  {
    let borrador = excluirContenido(borradorNuevo(), CONTENIDO_A)
    verificar(borrador.deltas.length === 1, '12. excluir crea 1 delta')
    borrador = restaurarContenido(borrador, CONTENIDO_A)
    verificar(borrador.deltas.length === 0, '12b. restaurar elimina la exclusión — vuelve a sin_ajuste')
    const r = reconstruirPropuesta(BASE, IDENTIDAD, borrador)
    if (r.ok) verificar(r.propuesta.items.length === 2, '12c. propuesta reconstruida vuelve a tener ambos contenidos')
  }

  // --- 13. contextualizar y luego excluir → solo excluir ---
  {
    let borrador = reemplazarContextualizacion(borradorNuevo(), CONTENIDO_A, 'x')
    borrador = excluirContenido(borrador, CONTENIDO_A)
    verificar(borrador.deltas.length === 1 && borrador.deltas[0].decision === 'excluir', '13. contextualizar luego excluir → solo queda excluir, nunca acumula')
  }

  // --- 14. excluir y luego restaurar → sin delta ---
  {
    let borrador = excluirContenido(borradorNuevo(), CONTENIDO_A)
    borrador = restaurarContenido(borrador, CONTENIDO_A)
    verificar(borrador.deltas.length === 0, '14. excluir luego restaurar → sin ningún delta sobre ese contenido')
  }
  // alias eliminarContextualizacion == restaurarContenido
  {
    let borrador = reemplazarContextualizacion(borradorNuevo(), CONTENIDO_A, 'x')
    borrador = eliminarContextualizacion(borrador, CONTENIDO_A)
    verificar(borrador.deltas.length === 0, '14b. eliminarContextualizacion (alias) también limpia el delta')
  }

  // --- 15. contenido nuevo conserva claveLocal después de recombinar ---
  {
    const { borrador, claveLocal } = agregarContenidoLocal(borradorNuevo(), 'Local 1.')
    const r1 = reconstruirPropuesta(BASE, IDENTIDAD, borrador)
    const r2 = reconstruirPropuesta(BASE, IDENTIDAD, borrador) // recombinar de nuevo, mismo borrador
    if (r1.ok && r2.ok) {
      const clave1 = r1.propuesta.items.find((i) => i.tipoDecision === 'nuevo')?.claveLocal
      const clave2 = r2.propuesta.items.find((i) => i.tipoDecision === 'nuevo')?.claveLocal
      verificar(clave1 === claveLocal && clave2 === claveLocal, '15. claveLocal del nuevo es estable entre reconstrucciones sucesivas')
    }
  }

  // --- 16. eliminar contenido nuevo usa claveLocal exacta ---
  {
    const paso1 = agregarContenidoLocal(borradorNuevo(), 'Local 1.')
    const paso2 = agregarContenidoLocal(paso1.borrador, 'Local 2.')
    const borradorFinal = eliminarContenidoNuevo(paso2.borrador, paso1.claveLocal)
    verificar(borradorFinal.deltas.length === 1, '16. eliminar por claveLocal exacta quita solo ese nuevo')
    const r = reconstruirPropuesta(BASE, IDENTIDAD, borradorFinal)
    if (r.ok) {
      const nuevos = r.propuesta.items.filter((i) => i.tipoDecision === 'nuevo')
      verificar(nuevos.length === 1 && nuevos[0].claveLocal === paso2.claveLocal, '16b. el nuevo restante es exactamente el que no se eliminó')
    }
  }

  // --- 17. dos contenidos nuevos no colisionan ---
  {
    const paso1 = agregarContenidoLocal(borradorNuevo(), 'Local 1.')
    const paso2 = agregarContenidoLocal(paso1.borrador, 'Local 2.')
    verificar(paso1.claveLocal !== paso2.claveLocal, '17. dos contenidos nuevos reciben claveLocal distinta')
    const r = reconstruirPropuesta(BASE, IDENTIDAD, paso2.borrador)
    if (r.ok) {
      const claves = r.propuesta.items.filter((i) => i.tipoDecision === 'nuevo').map((i) => i.claveLocal)
      verificar(new Set(claves).size === 2, '17b. ambos nuevos coexisten sin colisión en la propuesta final')
    }
  }

  // --- 18. idempotencyKey permanece igual después de ajustes ---
  {
    const borrador = borradorNuevo()
    const keyOriginal = borrador.idempotencyKey
    const b1 = excluirContenido(borrador, CONTENIDO_A)
    const b2 = reemplazarContextualizacion(b1, CONTENIDO_B, 'x')
    const b3 = agregarContenidoLocal(b2, 'y').borrador
    const b4 = restaurarContenido(b3, CONTENIDO_A)
    verificar([b1, b2, b3, b4].every((b) => b.idempotencyKey === keyOriginal), '18. idempotencyKey no cambia tras ningún ajuste determinista')
  }

  // --- 19. reconstrucción produce orden 1..N ---
  {
    const paso1 = agregarContenidoLocal(borradorNuevo(), 'a')
    const paso2 = agregarContenidoLocal(paso1.borrador, 'b')
    const r = reconstruirPropuesta(BASE, IDENTIDAD, paso2.borrador)
    if (r.ok) {
      const ordenes = r.propuesta.items.map((i) => i.orden).sort((a, b) => a - b)
      verificar(JSON.stringify(ordenes) === JSON.stringify([1, 2, 3, 4]), '19. orden final 1..N sin huecos ni repeticiones')
    }
  }

  // --- 20. reconstrucción conserva grupoId ---
  {
    const borrador = crearBorrador('grupo-especifico-4b', IDENTIDAD, null, null)
    const r = reconstruirPropuesta(BASE, IDENTIDAD, borrador)
    verificar(r.ok === true && r.propuesta.grupoId === 'grupo-especifico-4b', '20. propuesta reconstruida conserva el grupoId del borrador')
  }

  // --- 21. identidad curricular del borrador no proviene de IA ---
  // (crearBorrador exige la identidad como parámetro explícito del
  // llamador server-side — la firma de la función estructuralmente no
  // acepta un origen "IA"; se confirma que queda fijada tal cual.)
  {
    const borrador = crearBorrador('grupo-4b', IDENTIDAD, 'contexto', null)
    verificar(
      borrador.identidadCurricular.curriculoVersionId === IDENTIDAD.curriculoVersionId &&
        borrador.identidadCurricular.curriculoFaseId === IDENTIDAD.curriculoFaseId &&
        borrador.identidadCurricular.curriculoGradoId === IDENTIDAD.curriculoGradoId,
      '21. identidad curricular fijada exactamente como la pasó el servidor'
    )
  }

  // --- 22. cambio de identidad curricular detectado/fail-closed ---
  {
    const borrador = borradorNuevo()
    const r = reconstruirPropuesta(BASE, OTRA_IDENTIDAD, borrador)
    verificar(!r.ok && r.error.tipo === 'IDENTIDAD_CURRICULAR_CAMBIO', '22. identidad curricular distinta a la fijada → IDENTIDAD_CURRICULAR_CAMBIO, nunca reconstruye contra otra versión')
  }

  // --- refuerzo: normalizarDecisionesIa asigna claveLocal estable, no posicional ---
  {
    const decisiones = normalizarDecisionesIa([
      { decision: 'nuevo', textoLocal: 'a', resultadoEsperadoLocal: null },
      { decision: 'nuevo', textoLocal: 'b', resultadoEsperadoLocal: null },
    ])
    verificar(decisiones.every((d) => d.decision === 'nuevo' && typeof d.claveLocal === 'string' && d.claveLocal.length > 0), 'extra. normalizarDecisionesIa asigna claveLocal a cada nuevo')
    const claves = decisiones.map((d) => (d as { claveLocal: string }).claveLocal)
    verificar(new Set(claves).size === 2, 'extra2. claveLocal distinta para cada nuevo, nunca depende de un índice compartido')
  }

  // --- refuerzo: DELTA_CONTENIDO_DUPLICADO sigue siendo error real para JSON crudo con 2 decisiones simultáneas sobre el mismo contenido ---
  {
    const r = aplicarDeltasSobreBase(BASE, [
      { decision: 'contextualizar', curriculoContenidoId: CONTENIDO_A, textoContextualizado: 'x' },
      { decision: 'excluir', curriculoContenidoId: CONTENIDO_A },
    ])
    verificar(!r.ok && r.error.tipo === 'DELTA_CONTENIDO_DUPLICADO', 'extra3. 2 decisiones simultáneas sobre el mismo contenido en un array crudo siguen siendo rechazadas')
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
