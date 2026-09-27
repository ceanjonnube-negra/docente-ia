// scripts/verificar-caso3-prioridad-planeacion.ts
//
// Prueba aislada del bug de ruteo "Word en el título de una
// planeación" (ver auditoría READ-ONLY entregada antes de esta
// corrección, real E2E en Preview dpl_HpqSrio9hfk6mJ235oBQFEHwxRFK):
// un mensaje que Nivel0 clasifica CORRECTAMENTE como
// intencion_principal=planeacion_generar (Nivel4 ya arma
// esTurnoDeBorradorPlaneacion=true) igual quedaba interceptado por el
// CASO 3 de FINALIZAR ARCHIVO (app/api/chat/route.ts) porque
// tipoHerramientaSolicitado también resultaba truthy — el TÍTULO
// pedido para el archivo contenía la palabra "Word", y
// detectarFormatoExplicito (lib/asistente/documentos.ts,
// PATRONES_FORMATO) la detecta en cualquier parte del mensaje, sin
// contexto. Causa raíz real: el gate del CASO 3 no consultaba en
// absoluto la clasificación semántica ya resuelta.
//
// Corrección (única, autorizada explícitamente): el gate del CASO 3
// ahora excluye los turnos que ya pertenecen al pipeline especializado
// de planeación (!esTurnoDeBorradorPlaneacion) — sin tocar
// PATRONES_FORMATO, FRASES_FINALIZAR_DOCUMENTO ni
// detectarHerramientaDocumento(). El detector SIGUE devolviendo el
// mismo "falso positivo" de formato (por diseño: no se esconde, se le
// resta prioridad frente a la intención de planeación ya resuelta).
//
// Esta prueba NO invoca el route handler real (requiere Supabase/
// Claude/sesión completa) — sigue el mismo patrón ya establecido en
// scripts/verificar-creacion-nueva-vs-documento-activo.ts: funciones
// puras reales (detectarHerramientaDocumento, sin red) +
// verificación ESTRUCTURAL de app/api/chat/route.ts, incluyendo la
// evaluación REAL (no una copia manual) de la expresión booleana
// extraída literalmente del gate del CASO 3, para los 4 valores que
// puede tomar en producción.
//
// Se ejecuta con
// `npx tsx scripts/verificar-caso3-prioridad-planeacion.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectarHerramientaDocumento } from '../lib/asistente/documentos'

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
const cuerpoChatRoute = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf-8')

// Mensaje EXACTO que produjo el bug real en Preview.
const MENSAJE_BUG =
  "Genera una planeación didáctica para mi grupo de 4° B sobre 'Con pan, festejamos y convivimos', para una sesión. Incluye actividades de inicio, desarrollo y cierre, y una hoja de evaluación final del proyecto con 5 indicadores. Ponle como nombre: 'Prueba final Word - Con pan, festejamos y convivimos'."

async function main() {
  // ============================================================
  // 1. El gate del CASO 3 existe EXACTAMENTE con la forma
  //    autorizada, en una sola condición, sin duplicarla en otro
  //    lugar del archivo.
  // ============================================================
  const GATE_LITERAL = 'if (supabaseUser && userId && tipoHerramientaSolicitado && !esTurnoDeBorradorPlaneacion) {'
  const ocurrenciasGate = cuerpoChatRoute.split(GATE_LITERAL).length - 1
  verificar(ocurrenciasGate === 1, 'El gate corregido del CASO 3 aparece EXACTAMENTE una vez, en la forma autorizada')

  // El gate SIN la exclusión debe seguir existiendo EXACTAMENTE una
  // vez: es el gate temprano de "documento recuperable" (línea ~1111,
  // fuera de alcance de esta corrección — ya protegido por
  // pareceNuevoDocumento, ver auditoría; NO se toca a propósito). Si
  // apareciera una SEGUNDA vez, significaría que el CASO 3 (línea
  // ~3666) no quedó corregido o que la corrección se duplicó en un
  // lugar equivocado.
  const GATE_SIN_EXCLUSION = 'if (supabaseUser && userId && tipoHerramientaSolicitado) {'
  const ocurrenciasGateSinExclusion = cuerpoChatRoute.split(GATE_SIN_EXCLUSION).length - 1
  verificar(ocurrenciasGateSinExclusion === 1, 'El gate SIN la exclusión (!esTurnoDeBorradorPlaneacion) aparece EXACTAMENTE una vez — únicamente el gate temprano de "documento recuperable" (fuera de alcance), nunca el CASO 3')

  // ============================================================
  // 2. Evaluación REAL de la expresión booleana extraída
  //    literalmente del código (no una copia manual) contra los 4
  //    valores que puede tomar cada variable en producción.
  // ============================================================
  const matchExpresion = cuerpoChatRoute.match(/if \((supabaseUser && userId && tipoHerramientaSolicitado && !esTurnoDeBorradorPlaneacion)\) \{/)
  verificar(matchExpresion !== null, 'Se pudo extraer la expresión booleana real del gate desde el código fuente')
  const expresion = matchExpresion?.[1] ?? ''
  const evaluarGate = (supabaseUser: boolean, userId: boolean, tipoHerramientaSolicitado: boolean, esTurnoDeBorradorPlaneacion: boolean): boolean =>
    // eslint-disable-next-line no-new-func
    new Function('supabaseUser', 'userId', 'tipoHerramientaSolicitado', 'esTurnoDeBorradorPlaneacion', `return ${expresion}`)(
      supabaseUser,
      userId,
      tipoHerramientaSolicitado,
      esTurnoDeBorradorPlaneacion
    )

  // Escenario 1: mensaje del bug — Nivel0/Nivel4 ya resolvieron
  // esTurnoDeBorradorPlaneacion=true; tipoHerramientaSolicitado sigue
  // en 'word' (el detector NO cambia). El CASO 3 NO debe entrar.
  verificar(detectarHerramientaDocumento(MENSAJE_BUG) === 'word', 'detectarHerramientaDocumento SIGUE devolviendo "word" para el mensaje del bug (el detector no se toca — el falso positivo no se esconde)')
  verificar(evaluarGate(true, true, true, true) === false, 'Escenario 1 (mensaje del bug): con esTurnoDeBorradorPlaneacion=true, el gate del CASO 3 NO se activa aunque tipoHerramientaSolicitado="word" — el turno continúa al streaming especializado de planeación')

  // Escenario 2: creación de planeación con tema "documento oficial".
  const MENSAJE_DOCUMENTO_OFICIAL = 'Genera una planeación sobre cómo redactar un documento oficial para 5° grado.'
  verificar(detectarHerramientaDocumento(MENSAJE_DOCUMENTO_OFICIAL) === 'word', 'detectarHerramientaDocumento detecta "word" vía FRASES_FINALIZAR_DOCUMENTO ("documento oficial") en el mensaje de planeación')
  verificar(evaluarGate(true, true, true, true) === false, 'Escenario 2 ("documento oficial" en el tema): el CASO 3 tampoco intercepta — se conserva el pipeline de planeación')

  // Escenario 3: creación de planeación con "Excel" o "diapositivas" en el contenido/título.
  const MENSAJE_EXCEL = "Genera una planeación sobre hojas de cálculo. Ponle como nombre: 'Excel para principiantes'."
  const MENSAJE_DIAPOSITIVAS = "Genera una planeación para exponer con diapositivas sobre el sistema solar."
  verificar(detectarHerramientaDocumento(MENSAJE_EXCEL) === 'excel', 'detectarHerramientaDocumento detecta "excel" en el mensaje de planeación (Excel en el título)')
  verificar(detectarHerramientaDocumento(MENSAJE_DIAPOSITIVAS) === 'powerpoint', 'detectarHerramientaDocumento detecta "powerpoint" en el mensaje de planeación ("diapositivas" en el contenido)')
  verificar(evaluarGate(true, true, true, true) === false, 'Escenario 3 (Excel/diapositivas): el CASO 3 tampoco intercepta — se conserva el pipeline de planeación en ambos casos (misma evaluación del gate, tipoHerramientaSolicitado truthy)')

  // Escenario 4: ajuste de planeación con mención incidental de Word/PDF.
  // esTurnoDeBorradorPlaneacion también se fija en true en la rama de
  // ajuste (accion_planeacion_generar==='ajustar') — misma variable,
  // mismo gate, mismo resultado esperado.
  const MENSAJE_AJUSTE = 'Ajusta la planeación anterior: cámbiale la fecha de inicio y pásala a Word.'
  verificar(detectarHerramientaDocumento(MENSAJE_AJUSTE) === 'word', 'detectarHerramientaDocumento detecta "word" en un mensaje de AJUSTE de planeación')
  verificar(evaluarGate(true, true, true, true) === false, 'Escenario 4 (ajuste de planeación con "Word" incidental): el CASO 3 no intercepta — el flujo especializado de ajuste se conserva')
  verificar(cuerpoChatRoute.includes("esTurnoDeBorradorPlaneacion = true") && (cuerpoChatRoute.match(/esTurnoDeBorradorPlaneacion = true/g)?.length ?? 0) === 2, 'esTurnoDeBorradorPlaneacion se fija en true en EXACTAMENTE 2 puntos (rama "ajustar" y rama "crear" de planeacion_generar) — sin cambios respecto al código ya validado')

  // Escenario 5, 6, 7, 8: solicitudes NO relacionadas con planeación —
  // deben seguir entrando al CASO 3 exactamente igual que antes
  // (esTurnoDeBorradorPlaneacion=false en todos estos casos, porque
  // Nivel0 nunca clasificaría estos mensajes como planeacion_generar).
  const MENSAJE_WORD_NO_PLANEACION = 'Hazme una rúbrica de evaluación para el proyecto de ciencias. Envíamelo en Word.'
  const MENSAJE_PDF_NO_PLANEACION = 'Genera un citatorio para padres de familia en PDF.'
  const MENSAJE_POWERPOINT_NO_PLANEACION = 'Hazme una presentación de diapositivas sobre los estados de la materia.'
  const MENSAJE_EXCEL_NO_PLANEACION = 'Necesito una hoja de cálculo en Excel con las calificaciones del bimestre.'
  verificar(detectarHerramientaDocumento(MENSAJE_WORD_NO_PLANEACION) === 'word', 'Escenario 5: mensaje NO de planeación con "Word" explícito sigue detectándose como "word"')
  verificar(detectarHerramientaDocumento(MENSAJE_PDF_NO_PLANEACION) === 'pdf', 'Escenario 6: mensaje NO de planeación con "PDF" explícito sigue detectándose como "pdf"')
  verificar(detectarHerramientaDocumento(MENSAJE_POWERPOINT_NO_PLANEACION) === 'powerpoint', 'Escenario 7: mensaje NO de planeación con "diapositivas" sigue detectándose como "powerpoint"')
  verificar(detectarHerramientaDocumento(MENSAJE_EXCEL_NO_PLANEACION) === 'excel', 'Escenario 8: mensaje NO de planeación con "Excel" sigue detectándose como "excel"')
  verificar(evaluarGate(true, true, true, false) === true, 'Escenarios 5-8 (documentos genéricos, esTurnoDeBorradorPlaneacion=false): el gate del CASO 3 SIGUE activándose exactamente igual que antes de la corrección')

  // Sin sesión/usuario autenticado, el CASO 3 nunca debe activarse —
  // comportamiento preexistente, no debe cambiar con esta corrección.
  verificar(evaluarGate(false, true, true, false) === false, 'Sin supabaseUser, el gate del CASO 3 sigue sin activarse (sin cambios)')
  verificar(evaluarGate(true, false, true, false) === false, 'Sin userId, el gate del CASO 3 sigue sin activarse (sin cambios)')
  verificar(evaluarGate(true, true, false, false) === false, 'Sin tipoHerramientaSolicitado, el gate del CASO 3 sigue sin activarse (sin cambios)')

  // ============================================================
  // 9. convertir_documento — intención completamente distinta
  //    (capacidad_contextual, no intencion_principal), nunca fija
  //    esTurnoDeBorradorPlaneacion, y su bloque no fue tocado.
  // ============================================================
  const bloqueConvertirDocumento = cuerpoChatRoute.slice(cuerpoChatRoute.indexOf("capacidad_contextual === 'convertir_documento'") - 500, cuerpoChatRoute.indexOf("capacidad_contextual === 'convertir_documento'") + 2000)
  verificar(cuerpoChatRoute.includes("capacidad_contextual === 'convertir_documento'"), 'convertir_documento sigue presente, resuelto vía capacidad_contextual (nunca intencion_principal)')
  verificar(!bloqueConvertirDocumento.includes('esTurnoDeBorradorPlaneacion = true'), 'El bloque de convertir_documento nunca fija esTurnoDeBorradorPlaneacion=true — es una ruta completamente independiente del gate corregido')

  // ============================================================
  // 10. La aprobación de planeación conserva su retorno previo,
  //     sin ningún cambio: ya retorna ANTES de llegar siquiera al
  //     CASO 3 (línea ~2131), este gate ni se evalúa para ese caso.
  // ============================================================
  verificar(
    cuerpoChatRoute.includes("if (clasificacion.intencion_principal === 'planeacion_generar' && clasificacion.accion_planeacion_generar === 'aprobar') {"),
    'El gate de aprobación de planeación (accion_planeacion_generar==="aprobar") permanece exactamente igual, sin ningún cambio'
  )

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
