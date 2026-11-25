// Regresión (Preview 28a123b, 2026-11-25): "Haz más dinámica la sesión 2 e
// incorpora una actividad en equipos." sobre la planeación consultada cayó en
// la edición convencional (sin ajuste, sin resumen ni aprobación). Con una
// planeación guardada confirmada como documento activo manda el contexto,
// no la lista de verbos. Sin red ni IA: la salida del modelo se simula.
//   npx tsx scripts/verificar-regresion-ajuste-edicion.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decidirEdicionGuardada, pideModificar } from '../lib/planeacion/consultaPlaneaciones'
import { ETIQUETA_AJUSTE, ajustePublicable, alcanceDeInstruccion, construirBorradorAjustado, huellaBorrador, registrarAjuste, seccionesDe, soloPideFormato, type BaseAjuste } from '../lib/planeacion/modificarPlaneacion'
import { esBorradorPlaneacion, ocultarResumenParaGuardar } from '../lib/planeacion/extraerBorrador'
import { detectarAprobarPlaneacion } from '../lib/planeacion/detectarAprobarPlaneacion'
import type { Planeacion } from '../lib/planeacion/tipos'

let fallos = 0
function verificar(condicion: boolean, nombre: string) {
  if (condicion) console.log(`✓ ${nombre}`)
  else { fallos++; console.log(`✗ ${nombre}`) }
}

const PEDIDO = 'Haz más dinámica la sesión 2 e incorpora una actividad en equipos.'
const HOY = '2026-11-25'
const decidir = (t: string) => decidirEdicionGuardada(t, { hoy: HOY, soloArchivo: soloPideFormato(t) })

const CURRICULAR = '📌 CONTENIDOS Y PDA DE ESTA PLANEACIÓN\nContenido (Catálogo curricular de la app — pendiente de validación oficial):\n- Comprensión y producción de cuentos.\nPDA de referencia:\n- Escribe cuentos con secuencia causal.'
const DIA = (n: number, titulo: string, actividad: string, evaluacion: string) => `📅 DÍA ${n} — ${titulo}\n🔹 Inicio (15 min)\n${actividad}\n🔸 Desarrollo (30 min)\nTrabajo individual.\n🔻 Cierre (10 min)\nPuesta en común.\n📌 Evaluación: ${evaluacion}`
const V1 = [
  '📋 PLANEACIÓN DIDÁCTICA\nFase: Fase 4 (3° y 4° de primaria)\nCampo Formativo: Lenguajes\nProyecto Didáctico: ¡A contar historias! Elaboración de cuentos propios\nDuración: 5 días',
  '🎯 PROPÓSITO GENERAL\nQue el grupo escriba cuentos propios con secuencia causal.',
  CURRICULAR,
  '🧰 MATERIALES\n- Cuentos de la biblioteca\n- Hojas y colores',
  DIA(1, 'Leemos cuentos', 'Lectura en voz alta.', 'participación oral.'),
  DIA(2, 'Causas y efectos', 'Esquema de causa-efecto en el cuaderno.', 'Esquema de causa-efecto completo en el cuaderno; participación en la comparación grupal.'),
  DIA(3, 'Planeamos', 'Lluvia de ideas.', 'plan escrito.'),
  DIA(4, 'Escribimos', 'Escritura del borrador.', 'borrador completo.'),
  DIA(5, 'Compartimos', 'Lectura de cuentos.', 'cuento final.'),
  '🎓 PRODUCTO FINAL\nCuento propio escrito e ilustrado.',
].join('\n\n')
const RESUMEN = ['📎 RESUMEN PARA GUARDAR', 'Nombre: ¡A contar historias! Elaboración de cuentos propios', 'Fecha de inicio: 2026-11-24', 'Fecha de fin: 2026-11-30', 'Duración: 5 días',
  'Propósito: Que el grupo escriba cuentos propios con secuencia causal.', 'Campos formativos: Lenguajes', 'Contenidos: Comprensión y producción de cuentos.', 'PDA: Escribe cuentos con secuencia causal.',
  'Ejes articuladores: Apropiación de las culturas', 'Metodología: Proyectos', 'Producto final: Cuento propio escrito e ilustrado.',
  'Secuencia didáctica: Día 1: Leemos; Día 2: Causas y efectos; Día 3: Planeamos; Día 4: Escribimos; Día 5: Compartimos', 'Recursos: Cuentos de la biblioteca; Hojas y colores',
  'Evidencias: Esquema; Borrador; Cuento', 'Indicadores de evaluación: Identifica causas y efectos; Escribe con secuencia'].join('\n')
const ESTRUCTURA = {
  planeacion: { nombre: '¡A contar historias! Elaboración de cuentos propios', proposito: 'Que el grupo escriba cuentos propios con secuencia causal.', fecha_inicio: '2026-11-24', fecha_fin: '2026-11-30', campo_formativo: 'Lenguajes' },
  proyecto: { nombre: '¡A contar historias! Elaboración de cuentos propios', campos_formativos: ['Lenguajes'], contenidos: ['Comprensión y producción de cuentos.'], pda: ['Escribe cuentos con secuencia causal.'], ejes_articuladores: ['Apropiación de las culturas'],
    metodologia: 'Proyectos', duracion_dias: 5, actividades: [1, 2, 3, 4, 5].map((dia) => ({ dia, resumen: ['Leemos', 'Causas y efectos', 'Planeamos', 'Escribimos', 'Compartimos'][dia - 1] })),
    recursos: ['Cuentos de la biblioteca', 'Hojas y colores'], indicadores: ['Identifica causas y efectos', 'Escribe con secuencia'], producto_final: 'Cuento propio escrito e ilustrado.', evidencias: ['Esquema', 'Borrador', 'Cuento'] },
}
const PLANEACION = { id: '9874a4a2-ced8-4858-a5fd-99cab1b97da8', nombre: '¡A contar historias! Elaboración de cuentos propios', version: 1, grupo_id: 'g-1' } as Planeacion
const BASE: BaseAjuste = { planeacion: PLANEACION, numero: 1, contenido: V1, estructura: ESTRUCTURA, trazabilidad: { esquema: 'planeacion-curricular-v1' } }

async function main() {
  // 1. La solicitud exacta, sobre la planeación consultada: ajuste con alcance dia:2.
  const alcance = alcanceDeInstruccion(PEDIDO)
  verificar(decidir(PEDIDO) === 'ajuste' && alcance !== 'global' && [...alcance].join() === 'dia:2', '1. Solicitud exacta sobre la planeación guardada abierta → ajuste canónico, alcance dia:2')

  // 2. El contexto manda (sin verbo reconocido también es ajuste); se distinguen los demás casos.
  const casos: [string, string][] = [
    ['Que dure 3 días', 'ajuste'], ['Más dinámicas para trabajar en equipos', 'ajuste'], ['Con menos materiales', 'ajuste'], ['La sesión 4 debe incluir una salida al patio', 'ajuste'],
    ['¿Qué planeaciones guardé en noviembre?', 'consulta'], ['Pásala a Word', 'archivo'], ['Haz una planeación nueva de fracciones', 'nuevo'], ['Crea un citatorio para mañana', 'nuevo'],
    ['¿Cuántos alumnos faltaron hoy?', 'otro_tema'], ['Pasa lista', 'otro_tema'], ['No, gracias', 'negativa'],
  ]
  const malos = casos.filter(([t, esperado]) => decidir(t) !== esperado).map(([t, e]) => `${t} → ${decidir(t)} (esperado ${e})`)
  verificar(malos.length === 0, `2. Con la planeación abierta: cambios sin verbo → ajuste; consultas, archivo, documento nuevo, otro tema y negativas se distinguen${malos.length ? ` — ${malos.join('; ')}` : ''}`)
  verificar(pideModificar(PEDIDO) && pideModificar('Incorpora una actividad en equipos') && pideModificar('Simplifica el cierre') && !pideModificar('¿Qué día es hoy?'),
    '3. Sin documento activo, los verbos ampliados ("haz", "incorpora", "simplifica"…) sirven de apoyo')

  // 4. Borrador ajustado con la salida simulada del modelo (como la real: cambió también materiales, lo curricular, el producto y la evaluación del día 2).
  const modelo = `${V1
    .replace('Esquema de causa-efecto en el cuaderno.', 'Dinámica «cadena de causas»: en equipos de 4, cada integrante agrega un eslabón y lo expone.')
    .replace('Esquema de causa-efecto completo en el cuaderno; participación en la comparación grupal.', 'Mapa de causa y efecto con al menos tres eslabones; participación activa durante la exposición del equipo.')
    .replace('- Hojas y colores', '- Hojas y colores\n- Tarjetas de cartulina\n- Cinta adhesiva')
    .replace('Comprensión y producción de cuentos.', 'Producción de textos narrativos en equipo.')
    .replace('Cuento propio escrito e ilustrado.', 'Cuento propio escrito, ilustrado y expuesto en equipo.')}\n\n${RESUMEN.replace('Recursos: Cuentos de la biblioteca; Hojas y colores', 'Recursos: Cuentos de la biblioteca; Hojas y colores; Tarjetas de cartulina')}`
  const r = construirBorradorAjustado({ textoModelo: modelo, base: BASE, instruccion: PEDIDO })!
  const sec = seccionesDe(r.textoFinal.slice(0, r.textoFinal.indexOf('📎')))!
  const base = seccionesDe(V1)!
  const igual = (k: string) => sec.find((s) => s.clave === k)!.texto === base.find((s) => s.clave === k)!.texto
  verificar(sec.find((s) => s.clave === 'dia:2')!.texto.includes('en equipos de 4') && ['encabezado', 'proposito', 'curricular', 'materiales', 'dia:1', 'dia:3', 'dia:4', 'dia:5', 'producto'].every(igual),
    '4a. Solo cambia la actividad del Día 2; materiales, contenidos y PDA, producto final y los demás días se conservan de la versión 1')
  verificar(sec.find((s) => s.clave === 'dia:2')!.texto.includes('📌 Evaluación: Esquema de causa-efecto completo en el cuaderno; participación en la comparación grupal.') && !r.textoFinal.includes('Mapa de causa y efecto'),
    '4b. La evaluación del Día 2 se conserva (no se pidió cambiarla)')
  verificar(r.textoFinal.includes('Contenidos: Comprensión y producción de cuentos.') && r.textoFinal.includes('Recursos: Cuentos de la biblioteca; Hojas y colores\n') && r.textoFinal.includes('Indicadores de evaluación: Identifica causas y efectos; Escribe con secuencia'),
    '4c. Resumen: contenidos, recursos e indicadores de la versión confirmada')
  verificar(JSON.stringify(r.cambios) === JSON.stringify(['Día 2']) && r.verificado && r.textoFinal.includes('Cambios respecto a la versión 1: Día 2. Verifiqué que el resto es idéntico a la versión 1.') && r.textoFinal.trim().endsWith('¿Quieres corregir algo más? Si está bien, dime «apruébala» y la guardo como versión 2.'),
    '4d. Resumen real de cambios (solo Día 2) y propuesta de aprobación como versión 2')

  // 5. El cierre de aprobación es visible; el resumen interno y la línea de ajuste no.
  const visible = ocultarResumenParaGuardar(r.textoFinal)
  verificar(visible.includes('Cambios respecto a la versión 1: Día 2.') && visible.trim().endsWith('Si está bien, dime «apruébala» y la guardo como versión 2.') && !visible.includes('📎 RESUMEN') && !visible.includes(ETIQUETA_AJUSTE) && !visible.includes('Indicadores de evaluación:'),
    '5a. En la interfaz se ve el resumen de cambios y la pregunta de aprobación; el bloque interno queda oculto')
  const palabra = r.textoFinal.match(/dime «([^»]+)»/)?.[1] ?? ''
  verificar(esBorradorPlaneacion(r.textoFinal) && palabra === 'apruébala' && detectarAprobarPlaneacion(palabra, { hayBorradorPlaneacion: esBorradorPlaneacion(r.textoFinal) }) && detectarAprobarPlaneacion('Sí, apruébala', { hayBorradorPlaneacion: true }),
    '5b. El cierre pide exactamente la orden que el mecanismo conversacional existente reconoce («apruébala»), sin botón nuevo')

  // 6. Metadata confiable del ajuste.
  {
    const conv: Record<string, unknown> = { planeacion_activa: { esquema: 'referencia-planeacion-v1', planeacionId: PLANEACION.id, numero: 1, opciones: [] } }
    const sb = { from: () => {
      let cambios: Record<string, unknown> | null = null
      const q = { select: () => q, eq: () => q, update: (d: Record<string, unknown>) => { cambios = d; return q }, maybeSingle: async () => ({ data: JSON.parse(JSON.stringify(conv)), error: null }),
        then: (ok: (x: unknown) => unknown) => { if (cambios) Object.assign(conv, cambios); return Promise.resolve({ error: null }).then(ok) } }
      return q
    } } as unknown as SupabaseClient
    await registrarAjuste(sb, 'conv-1', { planeacionId: PLANEACION.id, versionBase: 1, grupoId: 'g-1', huella: huellaBorrador(r.textoFinal) })
    const id = ajustePublicable(r.textoFinal, conv.planeacion_activa)
    verificar(!!id && id.planeacionId === PLANEACION.id && id.versionBase === 1 && id.grupoId === 'g-1', '6. La identidad del ajuste (planeación, versión base 1, grupo, huella) queda registrada y es la que autoriza aprobarlo')
  }

  // 7. Ruta (estático): el contexto confirmado manda; una sola generación sin clasificador; nunca la edición convencional.
  {
    const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
    const iDecision = ruta.indexOf('decidirEdicionGuardada(sinPeticionDeFormato(instruccion), { hoy: fechaISOHoy(zonaHoraria), soloArchivo: soloPideFormato(instruccion) })')
    const guardia = ruta.slice(iDecision - 600, iDecision + 2200)
    verificar(iDecision > 0 && !/esEdicionDocumento[^\n]*&& pideModificar\(sinPeticionDeFormato\(instruccion\)\)/.test(guardia) && guardia.includes("if (decision === 'ajuste') {"),
      '7a. En la edición de una planeación guardada confirmada, el ajuste no depende de pideModificar')
    verificar(guardia.includes("else if (decision === 'nuevo') return respuestaTexto(") && guardia.includes("else if (decision === 'otro_tema' || (decision === 'archivo' && !formatoOriginal)) return respuestaTexto("),
      '7b. Documento nuevo u otro tema sobre la planeación abierta: se aclara, nunca se edita como documento convencional')
    verificar(ruta.includes('if ((formatoDelAjuste || continuacionAjuste || ajusteDesdeEdicion) && !ajusteDelTurno) {') && ruta.includes('if (!sesion && (ajusteDesdeEdicion || continuacionAjuste || formatoDelAjuste)) {'),
      '7c. Si el ajuste no se puede resolver con seguridad (sin grupo, sin sesión, fuera del grupo), se dice: no cae en la edición convencional')
    verificar(/ajusteDelTurno\s*\n?\s*\? clasificacionAjustePlaneacion\(\)/.test(ruta) && ruta.includes('mensajeConDocumento = resolucion.instruccion') && ruta.includes('registrarAjuste(supabaseUser!, ajusteDelTurno.conversacionId'),
      '7d. El ajuste usa una sola generación (sin clasificador), el modelo recibe solo la instrucción y la metadata se registra en el servidor')
  }

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
