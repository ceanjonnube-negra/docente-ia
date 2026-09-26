// scripts/verificar-evaluacion-eval1i.ts
//
// EVAL-1I — verificación estructural (sin credenciales, sin red, sin
// datos reales) de la primera pantalla operativa de Evaluación:
//   1. app/api/proyectos-seguimiento/route.ts (GET extendido con el
//      embed de hojas_evaluacion, sin N+1, sin URL firmada).
//   2. app/api/proyectos-seguimiento/[id]/hoja-url/route.ts (nuevo).
//   3. app/dashboard/evaluacion/page.tsx (nueva pantalla).
//   4. components/Asistente/AsistentePanel.tsx (nuevo ítem de nav).
// Mismo criterio ya usado en el resto de esta familia: inspección del
// código fuente para las propiedades que si fallaran silenciosamente
// serían graves.
//
// Se ejecuta con `npx tsx scripts/verificar-evaluacion-eval1i.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const raiz = (...partes: string[]) => join(__dirname, '..', ...partes)
const listaRuta = readFileSync(raiz('app', 'api', 'proyectos-seguimiento', 'route.ts'), 'utf-8')
const hojaUrlRuta = readFileSync(raiz('app', 'api', 'proyectos-seguimiento', '[id]', 'hoja-url', 'route.ts'), 'utf-8')
const paginaEvaluacion = readFileSync(raiz('app', 'dashboard', 'evaluacion', 'page.tsx'), 'utf-8')
const asistentePanel = readFileSync(raiz('components', 'Asistente', 'AsistentePanel.tsx'), 'utf-8')
const capturaHoja = readFileSync(raiz('components', 'Asistente', 'CapturaHoja.tsx'), 'utf-8')

function main() {
  // ============================================================
  // 1. GET /api/proyectos-seguimiento — extensión mínima.
  // ============================================================
  verificar(listaRuta.includes("hojas_evaluacion!hoja_id(identificador_visible, storage_path, generado_en)"), '1. El GET de listado embebe la hoja relacionada (identificador_visible/storage_path/generado_en) EN LA MISMA consulta — evita un patrón N+1')
  verificar(!listaRuta.includes('createSignedUrl') && !listaRuta.includes('crearUrlFirmada'), '2. El GET de listado NUNCA genera una URL firmada — eso vive exclusivamente en hoja-url/route.ts, a demanda')
  verificar(listaRuta.includes("grupo.docente_id !== docenteId"), '3. El GET de listado sigue verificando explícitamente que el grupo pertenece al docente real (sin cambios)')
  verificar(!listaRuta.includes('SERVICE_ROLE') && !listaRuta.includes('createClient('), '4. El GET de listado sigue sin SERVICE_ROLE ni cliente propio')

  // ============================================================
  // 2. hoja-url/route.ts — nuevo, mínimo, de solo lectura.
  // ============================================================
  verificar(!hojaUrlRuta.includes('SERVICE_ROLE') && !hojaUrlRuta.includes('createClient('), '5. hoja-url: no referencia SERVICE_ROLE ni crea su propio cliente')
  verificar(hojaUrlRuta.includes('extraerBearerToken'), '6. hoja-url: se autentica vía Authorization Bearer (GET, sin body) — mismo patrón que estado-captura/revisar-hoja')
  verificar(/proyecto\.docente_id !== docenteId/.test(hojaUrlRuta), '7. hoja-url: rechaza explícitamente un proyecto que no pertenece al docente real')
  verificar(/!hoja \|\| !hoja\.storage_path/.test(hojaUrlRuta), '8. hoja-url: fail-closed si la hoja todavía no tiene storage_path (archivo no generado)')
  verificar(hojaUrlRuta.includes('crearUrlFirmada') && hojaUrlRuta.includes("from '@/lib/documentGen/almacenamiento'"), '9. hoja-url: reutiliza crearUrlFirmada (lib ya existente) — nunca reimplementa la firma de URLs')
  verificar(hojaUrlRuta.includes('nombreArchivoHoja'), '10. hoja-url: reutiliza nombreArchivoHoja (lib ya existente) para el nombre de descarga')
  verificar(!hojaUrlRuta.includes('.insert(') && !hojaUrlRuta.includes('.update(') && !hojaUrlRuta.includes('.upsert(') && !hojaUrlRuta.includes('.delete('), '11. hoja-url: 0 escrituras — nunca persiste la URL firmada como fuente de verdad')
  verificar(!/anthropic\.messages|new Anthropic|openai\.|OpenAI\(/i.test(hojaUrlRuta), '12. hoja-url: 0 llamadas IA')
  verificar(!hojaUrlRuta.includes(".from('seguimiento_resultados')") && !hojaUrlRuta.includes(".from('evaluaciones')"), '13. hoja-url: nunca toca seguimiento_resultados ni la tabla histórica evaluaciones')

  // ============================================================
  // 3. app/dashboard/evaluacion/page.tsx
  // ============================================================
  verificar(paginaEvaluacion.includes("'use client'"), '14. La pantalla de Evaluación es un componente cliente')
  verificar(paginaEvaluacion.includes('docente_contexto_activo') && paginaEvaluacion.includes('ciclos_escolares.activo'), '15. Resuelve el grupo activo con el MISMO mecanismo canónico ya usado en Lista (MG-A: contexto persistido validado, nunca por nombre)')
  verificar(!/nombre_grupo\s*===|filtrar.*nombre/i.test(paginaEvaluacion), '16. Nunca resuelve el grupo por nombre/heurística de texto')
  verificar(
    /import CapturaHoja,?.*from '@\/components\/Asistente\/CapturaHoja'/.test(paginaEvaluacion) && paginaEvaluacion.includes('proyectoId={proyecto.id}'),
    '17. Reutiliza CapturaHoja.tsx tal cual, con proyectoId — nunca reimplementa su lógica de captura'
  )
  verificar(!paginaEvaluacion.includes('type="file"'), '18. La pantalla de Evaluación NO crea ningún <input type="file"> propio — toda la captura de fotos pasa por CapturaHoja')
  verificar(!paginaEvaluacion.includes(".from('evaluaciones')"), '19. Nunca lee ni escribe la tabla histórica/desconectada evaluaciones')
  verificar(!paginaEvaluacion.includes(".insert(") && !paginaEvaluacion.includes(".update(") && !paginaEvaluacion.includes(".upsert("), '20. La pantalla en sí no hace NINGUNA escritura propia — toda escritura real la hace CapturaHoja a través de las rutas ya existentes')
  verificar(paginaEvaluacion.includes("filter((p: Proyecto) => p.hoja_id)"), '21. Solo lista proyectos que YA tienen hoja_id — un proyecto sin hoja generada nunca aparece')
  verificar(paginaEvaluacion.includes('estado-captura'), '22. Usa el estado canónico de EVAL-1G (GET estado-captura) para el badge — nunca inventa otra máquina de estados')
  verificar(
    ['sin_fotografia', 'captura_incompleta', 'lista_para_analizar', 'revision_pendiente', 'lista_para_confirmar', 'confirmado'].every((e) => paginaEvaluacion.includes(e)),
    '23. Los 6 estados traducidos a etiqueta son EXACTAMENTE los del enum EstadoCapturaHoja de EVAL-1G, sin agregar ni quitar ninguno'
  )
  verificar(paginaEvaluacion.includes('hoja-url'), '24. "Ver hoja" llama a la nueva ruta hoja-url (URL firmada a demanda, nunca persistida)')
  verificar(paginaEvaluacion.includes('asistente.cerrarPanel()'), '25. Cierra el panel flotante del Chat al entrar, mismo patrón ya usado por Planeación')
  verificar(!/anthropic|Anthropic|OpenAI/i.test(paginaEvaluacion), '26. La pantalla de Evaluación no referencia ningún cliente de IA — 0 llamadas nuevas')

  // ============================================================
  // 4. Navegación — un solo ítem nuevo, en el menú real existente.
  // ============================================================
  verificar(asistentePanel.includes('href="/dashboard/evaluacion"'), '27. Se agregó el ítem "Evaluación" en el MISMO menú lateral real (AsistentePanel.tsx), nunca un sistema de navegación paralelo')
  verificar(
    ['/dashboard/lista', '/dashboard/planeacion', '/dashboard/calendario', '/documentos'].every((href) => asistentePanel.includes(`href="${href}"`)),
    '28. Los 4 ítems de navegación preexistentes (Lista/Planeación/Calendario/Documentos) siguen intactos — no se eliminó ni reorganizó ninguno'
  )

  // ============================================================
  // 5. Pulido UX — tarjeta contextual (post-validación en iPhone).
  // ============================================================
  verificar(paginaEvaluacion.includes("sin_fotografia: 'Capturar resultados'"), "29. sin_fotografia -> acción 'Capturar resultados'")
  verificar(paginaEvaluacion.includes("captura_incompleta: 'Continuar captura'"), "30. captura_incompleta -> acción 'Continuar captura'")
  verificar(paginaEvaluacion.includes("revision_pendiente: 'Revisar resultados'"), "31. revision_pendiente -> acción 'Revisar resultados'")
  verificar(paginaEvaluacion.includes("lista_para_confirmar: 'Confirmar resultados'"), "32. lista_para_confirmar -> acción 'Confirmar resultados'")
  verificar(paginaEvaluacion.includes("confirmado: 'Resultados registrados'"), "33. confirmado -> etiqueta 'Resultados registrados'")
  // confirmado es terminal: NUNCA debe tener una entrada de acción —
  // ETIQUETA_ACCION es Partial<Record<...>> precisamente para que
  // omitirlo sea válido en TypeScript y real en tiempo de ejecución
  // (accion queda undefined -> no se renderiza ningún botón de acción).
  verificar(!/ETIQUETA_ACCION[\s\S]{0,400}confirmado:/.test(paginaEvaluacion), '34. confirmado NUNCA tiene una acción de captura asociada — estado terminal real, no solo visual')
  // El identificador técnico (ej. "SG-VXKR") ya no se muestra en la
  // tarjeta — sigue existiendo en BD/PDF/pipeline, solo se oculta aquí.
  verificar(!/\{fecha\}[\s\S]{0,20}identificador_visible|identificador_visible[\s\S]{0,20}\{fecha\}/.test(paginaEvaluacion), '35. La tarjeta ya no muestra identificador_visible junto a la fecha (oculto en la vista, intacto en BD/PDF/pipeline)')
  verificar(paginaEvaluacion.includes('formatearFecha') && paginaEvaluacion.includes("from '@/lib/tiempo/TimeService'"), '36. La fecha se formatea con formatearFecha (lib ya existente, mismo criterio de zona horaria que el resto de la app) — nunca un formateador nuevo')
  verificar(paginaEvaluacion.includes('erroresEstado') && paginaEvaluacion.includes('No disponible para captura automática'), '37. Una hoja histórica sin roster congelado (estado-captura falla) se comunica con un mensaje honesto y sin botón de acción, en vez de caer en un genérico "Abrir"')

  // Exactamente 1 consulta a estado-captura por proyecto al cargar —
  // nunca una segunda solo por el pulido visual.
  const llamadasEstadoCaptura = (paginaEvaluacion.match(/\/estado-captura/g) || []).length
  verificar(llamadasEstadoCaptura === 1, `38. page.tsx referencia /estado-captura exactamente 1 vez (una sola consulta por proyecto al cargar la lista) — recuento real: ${llamadasEstadoCaptura}`)

  // onEstadoCambiado — mecanismo mínimo y local, aditivo, opcional.
  verificar(capturaHoja.includes('onEstadoCambiado?:'), '39. CapturaHoja.tsx: onEstadoCambiado es un prop OPCIONAL (la tarjeta del Chat, que no lo pasa, sigue funcionando idéntica)')
  verificar(/onEstadoCambiado\?\.\(estado\)/.test(capturaHoja), '40. CapturaHoja.tsx: el callback reenvía el mismo `estado` que el componente ya obtuvo — nunca dispara una consulta nueva')
  verificar(paginaEvaluacion.includes('onEstadoCambiado={(nuevoEstado)'), '41. page.tsx pasa onEstadoCambiado para mantener la tarjeta sincronizada en vivo mientras CapturaHoja está expandida')
  verificar(asistentePanel.includes('<CapturaHoja proyectoId={principal.proyectoSeguimientoId} />') && !asistentePanel.includes('onEstadoCambiado'), '42. La tarjeta del Chat (AsistentePanel.tsx) sigue usando CapturaHoja SIN el callback — comportamiento idéntico a EVAL-1G, sin cambios')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
