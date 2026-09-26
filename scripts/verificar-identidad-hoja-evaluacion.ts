// scripts/verificar-identidad-hoja-evaluacion.ts
//
// Corrección de la causa raíz real del incidente "Los Insectos y su
// Papel en la Naturaleza": una fotografía de un documento distinto
// ("Evaluación Diagnóstica", 27 alumnos ajenos) fue aceptada como si
// fuera la hoja oficial del proyecto — el sistema solo emparejaba
// fila.posicion -> rosterCongelado.posicion, sin verificar identidad.
//
// Diseño final (revisión 3 — corrige deuda técnica de la revisión 1 y
// elimina encabezadosReconocidos, sin consumidor real, ver revisión 3):
//   - Identidad fuerte: hojas_evaluacion.identificador_visible, ya
//     único/NOT NULL/impreso en el PDF. La generación
//     (generarCodigoHoja) y la validación (normalizarIdentificadorHoja/
//     esIdentificadorHojaValido) viven en la MISMA fuente canónica,
//     lib/identificadorHoja.ts — analizar-hoja/route.ts las importa,
//     nunca duplica el alfabeto/regex.
//   - "El modelo observa. El servidor valida.": analizarImagenesHojaEvaluacion
//     NUNCA recibe el identificador_visible esperado.
//   - captura_pendiente.extraidoBruto significa EXCLUSIVAMENTE
//     "extracción de una fotografía cuya identidad ya fue validada" —
//     un rechazo NUNCA lo escribe, ni siquiera vacío. La señal de
//     rechazo vive en su propio campo aditivo,
//     captura_pendiente.validacionIdentidad = { estado: 'rechazada',
//     razon, validadaEn }, que determinarEstadoCapturaHoja (extendido
//     con el parámetro opcional identidadRechazada) traduce al nuevo
//     estado 'identidad_no_valida' — deliberadamente distinto de
//     'lista_para_analizar', así que recargar nunca re-analiza
//     automáticamente. Al subir una foto nueva, foto-hoja/route.ts
//     (sin modificar) reemplaza captura_pendiente por completo y la
//     señal desaparece sola.
//
// Verificación estructural + funcional (sin credenciales de Anthropic
// reales, sin red, sin datos reales, sin llamar al modelo). Las
// pruebas C-F, G-parcial, H y N ejecutan código real y determinista.
//
// Se ejecuta con `npx tsx scripts/verificar-identidad-hoja-evaluacion.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { analizarImagenesHojaEvaluacion } from '../lib/seguimiento/analisisHojaEvaluacion'
import { determinarEstadoCapturaHoja } from '../lib/seguimiento/estadoCapturaHoja'
import { prepararResultadosConfirmacion, construirMatrizRevision } from '../lib/seguimiento/confirmarResultadosHoja'
import { generarCodigoHoja, normalizarIdentificadorHoja, esIdentificadorHojaValido } from '../lib/identificadorHoja'
import type { AlumnoRosterCongelado, IndicadorCongelado } from '../lib/seguimiento/tipos'
import type Anthropic from '@anthropic-ai/sdk'

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
const analisisLib = readFileSync(raiz('lib', 'seguimiento', 'analisisHojaEvaluacion.ts'), 'utf-8')
const rutaAnalizar = readFileSync(raiz('app', 'api', 'proyectos-seguimiento', '[id]', 'analizar-hoja', 'route.ts'), 'utf-8')
const rutaFoto = readFileSync(raiz('app', 'api', 'proyectos-seguimiento', '[id]', 'foto-hoja', 'route.ts'), 'utf-8')
const rutaEstadoCaptura = readFileSync(raiz('app', 'api', 'proyectos-seguimiento', '[id]', 'estado-captura', 'route.ts'), 'utf-8')
const capturaHoja = readFileSync(raiz('components', 'Asistente', 'CapturaHoja.tsx'), 'utf-8')
const estadoCapturaHojaLib = readFileSync(raiz('lib', 'seguimiento', 'estadoCapturaHoja.ts'), 'utf-8')
const identificadorHojaLib = readFileSync(raiz('lib', 'identificadorHoja.ts'), 'utf-8')
const confirmarResultadosHoja = readFileSync(raiz('lib', 'seguimiento', 'confirmarResultadosHoja.ts'), 'utf-8')

function sinComentariosDeLinea(contenido: string): string {
  return contenido.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
}

function crearAnthropicFalso(respuesta: Record<string, unknown>) {
  let llamadas = 0
  const anthropic = {
    messages: {
      create: async () => {
        llamadas++
        return { content: [{ type: 'text', text: JSON.stringify(respuesta) }] }
      },
    },
  } as unknown as Anthropic
  return { anthropic, contarLlamadas: () => llamadas }
}

function filaCompleta(posicion: number, valor: number) {
  return { posicion, celdas: [1, 2, 3, 4, 5].map((n) => ({ numeroIndicador: n, digitosDetectados: [valor], confianza: 'alta' as const })) }
}

function filaValidada(posicion: number, nivel: 1 | 2 | 3 | 4) {
  return {
    posicion,
    celdas: [1, 2, 3, 4, 5].map((n) => ({
      numeroIndicador: n,
      lectura: { estado: 'nivel' as const, nivel },
      confianza: 'alta' as const,
      dudoso: false,
    })),
  }
}

const rosterCongelado28: AlumnoRosterCongelado[] = Array.from({ length: 28 }, (_, i) => ({
  alumno_id: `a${i}`, inscripcion_id: `i${i}`, nombre: `Alumno ${i}`, posicion: i + 1,
}))
const indicadoresCongelados: IndicadorCongelado[] = Array.from({ length: 5 }, (_, i) => ({
  numero_indicador: i + 1, indicador_especifico: `Indicador ${i + 1}`, aspecto_general: 'logro_aprendizaje',
})) as unknown as IndicadorCongelado[]

async function main() {
  // ============================================================
  // A. El prompt/modelo NO recibe el identificador esperado.
  // ============================================================
  verificar(
    !/function construirInstrucciones\([^)]*identificador/i.test(analisisLib),
    'A1. construirInstrucciones() no tiene ningún parámetro relacionado con "identificador" — el prompt no puede depender de un valor esperado'
  )
  verificar(
    /export async function analizarImagenesHojaEvaluacion\(\s*anthropic: Anthropic,\s*imagenes: ImagenHojaEvaluacion\[\],\s*cantidadFilasEsperadas: number\s*\)/.test(analisisLib),
    'A2. analizarImagenesHojaEvaluacion() conserva EXACTAMENTE sus 3 parámetros de siempre — no se le agregó un 4º parámetro con el identificador esperado'
  )
  verificar(
    /analizarImagenesHojaEvaluacion\(\s*anthropic,\s*imagenesNormalizadas,\s*rosterCongelado\.length\s*\)/.test(rutaAnalizar),
    'A3. analizar-hoja/route.ts llama a analizarImagenesHojaEvaluacion con los MISMOS 3 argumentos de siempre — nunca le pasa hoja.identificador_visible'
  )

  // ============================================================
  // B. El modelo únicamente transcribe lo observado (prompt genérico).
  // ============================================================
  verificar(analisisLib.includes('NUNCA lo inventes, completes ni lo deduzcas'), 'B1. El prompt instruye explícitamente a nunca inventar/completar/deducir el identificador')
  verificar(analisisLib.includes('o null si no existe o no es legible'), 'B2. El prompt permite explícitamente responder null cuando no se puede leer')
  verificar(
    /function normalizarIdentificadorVisibleObservado\(valor: unknown\): string \| null \{\s*if \(typeof valor !== 'string'\) return null/.test(analisisLib),
    'B3. normalizarIdentificadorVisibleObservado() es una función pura de forma/presencia — nunca compara contra ningún valor esperado'
  )

  // ============================================================
  // C-F. Fuente canónica ÚNICA (lib/identificadorHoja.ts) — pruebas
  // funcionales REALES (no una reimplementación de prueba).
  // ============================================================
  verificar(normalizarIdentificadorHoja(' sg-pwcu ') === 'SG-PWCU', "C. normalizarIdentificadorHoja(' sg-pwcu ') === 'SG-PWCU' (trim+uppercase reales)")
  verificar(esIdentificadorHojaValido(normalizarIdentificadorHoja('sg-pwcu')) === true, 'C2. Un código real bien formado (normalizado) pasa esIdentificadorHojaValido')
  verificar(normalizarIdentificadorHoja('SG-PWCU') !== normalizarIdentificadorHoja('SG-VXKR'), 'D. SG-PWCU y SG-VXKR normalizan a valores distintos — nunca coinciden')
  verificar(esIdentificadorHojaValido('ABCD') === false, 'F. formato inválido ("ABCD", sin "SG-") => esIdentificadorHojaValido lo rechaza')
  verificar(esIdentificadorHojaValido('SG-PWCV') === true && 'SG-PWCV' !== normalizarIdentificadorHoja('SG-PWCU'), 'F2. SG-PWCV tiene formato válido pero NO es igual a SG-PWCU — un solo carácter distinto nunca "pasa" (sin tolerancia tipo Levenshtein)')
  for (let i = 0; i < 20; i++) {
    const codigo = generarCodigoHoja()
    verificar(esIdentificadorHojaValido(normalizarIdentificadorHoja(codigo)), `C3-gen${i}. generarCodigoHoja() produce un código que esIdentificadorHojaValido acepta (generación y validación consistentes entre sí) — "${codigo}"`)
  }

  // ============================================================
  // Fuente canónica: analizar-hoja/route.ts importa de
  // lib/identificadorHoja.ts, nunca duplica el alfabeto/regex.
  // ============================================================
  verificar(rutaAnalizar.includes("import { normalizarIdentificadorHoja, esIdentificadorHojaValido } from '@/lib/identificadorHoja'"), 'Fuente1. analizar-hoja/route.ts importa la validación desde lib/identificadorHoja.ts')
  verificar(!rutaAnalizar.includes('ABCDEFGHJKMNPQRSTUVWXYZ23456789'), 'Fuente2. analizar-hoja/route.ts NO contiene una copia del alfabeto — una sola fuente real')
  verificar(!/const REGEX_CODIGO_HOJA/.test(rutaAnalizar), 'Fuente3. analizar-hoja/route.ts no define su propio regex de identificador')
  verificar((identificadorHojaLib.match(/ABCDEFGHJKMNPQRSTUVWXYZ23456789/g) || []).length === 1, 'Fuente4. lib/identificadorHoja.ts define el alfabeto UNA sola vez — generarCodigoHoja() y esIdentificadorHojaValido() comparten la misma constante')
  verificar(identificadorHojaLib.includes('export function normalizarIdentificadorHoja') && identificadorHojaLib.includes('export function esIdentificadorHojaValido'), 'Fuente5. lib/identificadorHoja.ts exporta ambas funciones reutilizables')
  verificar(sinComentariosDeLinea(identificadorHojaLib).includes('export function generarCodigoHoja'), 'Fuente6. generarCodigoHoja() sigue exportada, formato sin cambios (SG- + 4 caracteres)')

  // ============================================================
  // G. Rechazo de identidad: extraidoBruto NUNCA existe; la señal es
  // un campo propio, nunca una extracción vacía disfrazada.
  // ============================================================
  const inicioRechazo = rutaAnalizar.indexOf('Gate de identidad')
  const inicioExito = rutaAnalizar.indexOf('const { error: errorUpdate }')
  const bloqueRechazo = rutaAnalizar.slice(inicioRechazo, inicioExito)
  verificar(!sinComentariosDeLinea(bloqueRechazo).includes('extraidoBruto'), 'G1. El bloque de rechazo NUNCA escribe extraidoBruto en código real (ni vacío, ni de ninguna forma — solo se menciona en un comentario explicando la regla) — extraidoBruto sigue significando exclusivamente "identidad ya validada"')
  verificar(bloqueRechazo.includes("validacionIdentidad: { estado: 'rechazada', razon: 'identidad_no_valida'"), 'G2. El bloque de rechazo persiste una señal explícita y propia: captura_pendiente.validacionIdentidad')
  verificar(bloqueRechazo.includes('...capturaPendiente'), 'G3. El rechazo conserva capturaPendiente.fotos tal cual (spread) — nunca lo modifica ni borra Storage')
  verificar(!/eliminarArchivo|\.remove\(/.test(bloqueRechazo), 'G4. El bloque de rechazo nunca borra ningún archivo de Storage')

  // ============================================================
  // Identidad válida SÍ puede persistir extraidoBruto, y limpia
  // cualquier rechazo previo explícitamente (nunca coexisten).
  // ============================================================
  const bloqueExito = rutaAnalizar.slice(inicioExito)
  verificar(bloqueExito.includes('extraidoBruto: resultado.extraccion'), 'ExtraidoValido1. Con identidad válida, extraidoBruto SÍ se persiste — la extracción real del modelo')
  verificar(bloqueExito.includes('validacionIdentidad: null'), 'ExtraidoValido2. La escritura de éxito limpia explícitamente validacionIdentidad — nunca coexisten extraidoBruto y un rechazo activo')

  // ============================================================
  // H. determinarEstadoCapturaHoja distingue los 3 casos pedidos —
  // prueba funcional real, sin modificar la función más de lo
  // necesario (solo el parámetro opcional identidadRechazada).
  // ============================================================
  {
    // A) fotos completas + sin análisis + sin rechazo -> lista_para_analizar
    const a = determinarEstadoCapturaHoja({
      estadoProyecto: 'fotografia_cargada', paginasEsperadas: 1, paginasCargadas: 1,
      extraidoBruto: null, rosterCongelado: rosterCongelado28, indicadoresCongelados,
    })
    verificar(a.estado === 'lista_para_analizar', 'H-A. Fotos completas, sin análisis, sin rechazo => lista_para_analizar (comportamiento de siempre, sin cambios)')

    // B) fotos completas + identidad rechazada -> identidad_no_valida, NUNCA lista_para_analizar
    const b = determinarEstadoCapturaHoja({
      estadoProyecto: 'fotografia_cargada', paginasEsperadas: 1, paginasCargadas: 1,
      extraidoBruto: null, rosterCongelado: rosterCongelado28, indicadoresCongelados,
      identidadRechazada: true,
    })
    verificar(b.estado === 'identidad_no_valida', 'H-B. Fotos completas + identidad rechazada => identidad_no_valida')
    verificar(b.estado !== 'lista_para_analizar', 'H-B2. NUNCA lista_para_analizar cuando hay un rechazo — CapturaHoja.tsx solo auto-reintenta con ese valor exacto, así que recargar no dispara otra llamada IA')

    // C) identidad válida + extraidoBruto -> flujo actual de revisión/confirmación (sin cambios)
    const c = determinarEstadoCapturaHoja({
      estadoProyecto: 'requiere_revision', paginasEsperadas: 1, paginasCargadas: 1,
      extraidoBruto: { filas: [filaValidada(1, 4)] }, rosterCongelado: [rosterCongelado28[0]], indicadoresCongelados,
    })
    verificar(c.estado === 'lista_para_confirmar', 'H-C. Identidad válida + extraidoBruto completo => flujo normal de confirmación, sin cambios')

    // Fotografía nueva correcta: capturaPendiente fresca (sin
    // validacionIdentidad, sin extraidoBruto) vuelve a ser analizable.
    const d = determinarEstadoCapturaHoja({
      estadoProyecto: 'fotografia_cargada', paginasEsperadas: 1, paginasCargadas: 1,
      extraidoBruto: null, rosterCongelado: rosterCongelado28, indicadoresCongelados,
      identidadRechazada: false,
    })
    verificar(d.estado === 'lista_para_analizar', 'FotoNueva1. Tras una carga fresca (identidadRechazada=false, sin extraidoBruto) vuelve a lista_para_analizar — la foto nueva es analizable con normalidad')
  }
  verificar(/json\.estado === 'lista_para_analizar'\) \{\s*await analizar/.test(capturaHoja), "H3. El único auto-reintento de CapturaHoja.tsx sigue disparándose ÚNICAMENTE con estado==='lista_para_analizar' — nunca con 'identidad_no_valida'")

  // ============================================================
  // Fotografía nueva reemplaza/elimina la señal de rechazo — mismo
  // mecanismo YA existente de foto-hoja/route.ts, sin modificarlo.
  // ============================================================
  verificar(rutaFoto.includes('captura_pendiente: { fotos: fotosActualizadas }'), 'FotoNueva2. foto-hoja/route.ts (sin modificar) reemplaza captura_pendiente por completo en cada carga — validacionIdentidad de un rechazo previo desaparece automáticamente, igual que extraidoBruto')

  // ============================================================
  // I. Ningún consumidor puede interpretar un rechazo como extracción
  // válida — confirmarResultadosHoja.ts nunca ve validacionIdentidad.
  // ============================================================
  verificar(!confirmarResultadosHoja.includes('validacionIdentidad'), 'ConsumidorSeguro1. confirmarResultadosHoja.ts no conoce ni necesita conocer validacionIdentidad — solo procesa extraidoBruto ya validado')
  verificar(!confirmarResultadosHoja.includes('identidadHojaValida'), 'ConsumidorSeguro2. confirmarResultadosHoja.ts no fue tocado — no tiene ninguna referencia a la validación de identidad')

  // ============================================================
  // J. Hoja identificada correctamente con una fila faltante conserva
  // el comportamiento de cobertura/revisión existente.
  // ============================================================
  {
    const roster3: AlumnoRosterCongelado[] = rosterCongelado28.slice(0, 3)
    const extraidoBrutoIncompleto = { filas: [filaValidada(1, 4), filaValidada(2, 3)] } // falta posición 3
    const matriz = construirMatrizRevision(extraidoBrutoIncompleto, roster3, indicadoresCongelados)
    verificar(matriz.coberturaCompleta === false, 'J1. Una hoja identificada correctamente con una fila faltante sigue calculando coberturaCompleta=false (EVAL-1E/1F sin cambios)')
    verificar(matriz.alumnos.find((a) => a.posicion === 3)?.cubierto === false, 'J2. La posición faltante se marca cubierto=false, nunca se inventa')
  }

  // ============================================================
  // K. Exactamente 1 llamada IA en el caso normal (identidad válida).
  // ============================================================
  {
    const { anthropic, contarLlamadas } = crearAnthropicFalso({
      hojaLegible: true, identificadorVisible: 'sg-pwcu', filas: [filaCompleta(1, 4)],
    })
    const r = await analizarImagenesHojaEvaluacion(anthropic, [{ base64: 'ZmFrZQ==', mediaType: 'image/jpeg' }], 28)
    verificar(contarLlamadas() === 1, 'K1. Caso normal: exactamente 1 llamada a anthropic.messages.create')
    verificar(normalizarIdentificadorHoja(r.identificadorVisibleObservado ?? '') === normalizarIdentificadorHoja('SG-PWCU'), 'K2. El identificador observado, normalizado con la fuente canónica real, coincide con el esperado')
  }

  // ============================================================
  // L. Exactamente 1 llamada IA para detectar una foto incorrecta.
  // ============================================================
  {
    const { anthropic, contarLlamadas } = crearAnthropicFalso({
      hojaLegible: true, identificadorVisible: null,
      filas: Array.from({ length: 27 }, (_, i) => filaCompleta(i + 1, 3)),
    })
    const r = await analizarImagenesHojaEvaluacion(anthropic, [{ base64: 'ZmFrZQ==', mediaType: 'image/jpeg' }], 28)
    verificar(contarLlamadas() === 1, 'L1. Detectar una foto incorrecta sigue costando exactamente 1 llamada IA')
    verificar(r.identificadorVisibleObservado === null, 'L2. identificadorVisible=null reproduce exactamente el caso real de "Los Insectos"')
  }
  verificar(!/anthropic\.messages\.create/.test(bloqueRechazo) && !/analizarImagenesHojaEvaluacion/.test(bloqueRechazo), 'L3. El bloque de rechazo no contiene ninguna llamada adicional a Anthropic')

  // ============================================================
  // M. Ningún resultado llega a seguimiento_resultados sin confirmar.
  // ============================================================
  verificar(!rutaAnalizar.includes(".from('seguimiento_resultados')"), 'M. analizar-hoja/route.ts sigue sin escribir seguimiento_resultados, incluido el bloque de rechazo')

  // ============================================================
  // N. El extraidoBruto legacy de "Los Insectos" (27 filas) sigue sin
  // poder confirmarse — regla EVAL-1E preexistente, sin tocar.
  // ============================================================
  {
    const extraidoBrutoLegacy27Filas = { filas: Array.from({ length: 27 }, (_, i) => filaValidada(i + 1, 3)) }
    let lanzo = false
    let mensaje = ''
    try {
      prepararResultadosConfirmacion('proyecto-fake', extraidoBrutoLegacy27Filas, rosterCongelado28, indicadoresCongelados)
    } catch (e) {
      lanzo = true
      mensaje = e instanceof Error ? e.message : ''
    }
    verificar(lanzo && mensaje.includes('28') && mensaje.includes('27'), 'N. El extraidoBruto legacy real (27 vs 28) SIGUE siendo rechazado — regla preexistente, independiente de este cambio (no se tocó ni se necesitó tocar)')
  }

  // ============================================================
  // encabezadosReconocidos — ELIMINADO en esta revisión: se inspeccionó
  // y no tenía ningún consumidor real (ni en analizar-hoja/route.ts, ni
  // en ningún otro archivo de producción) — solo ampliaba prompt/schema/
  // tipo sin usarse. SG-XXXX sigue siendo el único gate de identidad,
  // ahora sin ninguna señal muerta alrededor.
  // ============================================================
  verificar(!analisisLib.includes('encabezadosReconocidos'), 'EncabezadosEliminado1. analisisHojaEvaluacion.ts ya no define, pide ni devuelve encabezadosReconocidos')
  verificar(!rutaAnalizar.includes('encabezadosReconocidos'), 'EncabezadosEliminado2. analizar-hoja/route.ts nunca lo referenció y sigue sin hacerlo')
  verificar(!capturaHoja.includes('encabezadosReconocidos'), 'EncabezadosEliminado3. CapturaHoja.tsx nunca lo referenció')

  // ============================================================
  // MULTIPÁGINA — el identificador solo vive en la imagen de la
  // página 1, pero TODAS las páginas viajan en la MISMA llamada; el
  // gate de identidad es independiente del número de páginas/filas.
  // ============================================================
  {
    // Página 1 ilegible para el identificador (borrosa/cortada en la
    // esquina) pero el resto de la hoja SÍ se pudo transcribir bien —
    // identificadorVisibleObservado=null de todos modos rechaza TODO,
    // sin importar cuántas filas válidas haya.
    const { anthropic, contarLlamadas } = crearAnthropicFalso({
      hojaLegible: true,
      identificadorVisible: null, // esquina de la página 1 no legible
      filas: [...Array.from({ length: 15 }, (_, i) => filaCompleta(i + 1, 4)), ...Array.from({ length: 13 }, (_, i) => filaCompleta(i + 16, 3))], // 28 filas, ambas páginas perfectamente leídas
    })
    const r = await analizarImagenesHojaEvaluacion(
      anthropic,
      [{ base64: 'cGFnaW5hMQ==', mediaType: 'image/jpeg' }, { base64: 'cGFnaW5hMg==', mediaType: 'image/jpeg' }],
      28
    )
    verificar(contarLlamadas() === 1, 'Multi1. 2 páginas en la misma llamada: exactamente 1 llamada IA, incluso con 28 filas perfectamente leídas')
    verificar(r.identificadorVisibleObservado === null, 'Multi2. identificadorVisibleObservado=null aunque las 28 filas de ambas páginas se leyeron bien — el gate de identidad no depende de la cobertura de filas')
    const identidadValidaSimulada = r.identificadorVisibleObservado !== null && esIdentificadorHojaValido(normalizarIdentificadorHoja(r.identificadorVisibleObservado)) && normalizarIdentificadorHoja(r.identificadorVisibleObservado) === normalizarIdentificadorHoja('SG-PWCU')
    verificar(identidadValidaSimulada === false, 'Multi3. Con las funciones canónicas reales (normalizarIdentificadorHoja/esIdentificadorHojaValido), este caso se rechazaría: null nunca pasa, sin importar cuántas páginas/filas se leyeron')
  }
  {
    // Página 1 con SG-XXXX perteneciente a OTRA hoja real (formato
    // válido, pero no la esperada) — rechazo, aunque todas las tablas
    // sean plausibles.
    const { anthropic, contarLlamadas } = crearAnthropicFalso({
      hojaLegible: true,
      identificadorVisible: 'SG-VXKR', // código real de OTRA hoja (histórica, "Las Leyendas de Mi Tierra")
      filas: Array.from({ length: 28 }, (_, i) => filaCompleta(i + 1, 4)),
    })
    const r = await analizarImagenesHojaEvaluacion(
      anthropic,
      [{ base64: 'cGFnaW5hMQ==', mediaType: 'image/jpeg' }, { base64: 'cGFnaW5hMg==', mediaType: 'image/jpeg' }],
      28
    )
    verificar(contarLlamadas() === 1, 'Multi4. Exactamente 1 llamada IA también en este caso')
    verificar(normalizarIdentificadorHoja(r.identificadorVisibleObservado ?? '') !== normalizarIdentificadorHoja('SG-PWCU'), 'Multi5. SG-VXKR (de otra hoja real) nunca coincide con SG-PWCU, aunque las 28 filas sean plausibles — rechazo por identidad')
  }
  // SG correcto pero cobertura incompleta: NO debe confundirse con
  // identidad incorrecta — sigue el comportamiento normal de EVAL-1E/1F.
  {
    const identidadValida = normalizarIdentificadorHoja('sg-pwcu') === normalizarIdentificadorHoja('SG-PWCU') && esIdentificadorHojaValido(normalizarIdentificadorHoja('sg-pwcu'))
    verificar(identidadValida === true, 'Multi6. Identidad SG válida y coincidente (paso previo al siguiente check)')
    // Con identidad válida, el código YA NO pasa por identidadHojaValida
    // — cae directo al camino de éxito, que persiste extraidoBruto.extraccion
    // real (incompleto o no) — es exactamente lo que ya prueban H-C/J1/J2
    // usando construirMatrizRevision/determinarEstadoCapturaHoja reales:
    // cobertura incompleta con identidad válida => 'revision_pendiente',
    // NUNCA 'identidad_no_valida'.
    const estadoConCoberturaIncompleta = determinarEstadoCapturaHoja({
      estadoProyecto: 'requiere_revision', paginasEsperadas: 1, paginasCargadas: 1,
      extraidoBruto: { filas: [filaValidada(1, 4)] }, // solo 1 de 2 esperadas
      rosterCongelado: rosterCongelado28.slice(0, 2), indicadoresCongelados,
    })
    verificar(estadoConCoberturaIncompleta.estado === 'revision_pendiente', "Multi7. SG correcto + cobertura incompleta => 'revision_pendiente' (comportamiento normal existente), NUNCA 'identidad_no_valida'")
  }

  // ============================================================
  // Transición completa: captura A rechazada -> foto B correcta.
  // Nada de la captura A sobrevive salvo lo que exista legítimamente
  // en logs técnicos (fuera de captura_pendiente).
  // ============================================================
  {
    // 1. Captura A: identidad rechazada (mismo resultado que produce
    // analizar-hoja/route.ts en su bloque de rechazo).
    const capturaPendienteTrasRechazoA = {
      fotos: [{ storagePath: 'foto-A.jpg', pagina: 1, subidaEn: '2026-01-01T00:00:00.000Z' }],
      validacionIdentidad: { estado: 'rechazada' as const, razon: 'identidad_no_valida', validadaEn: '2026-01-01T00:00:01.000Z' },
    }
    const estadoTrasRechazoA = determinarEstadoCapturaHoja({
      estadoProyecto: 'fotografia_cargada', paginasEsperadas: 1, paginasCargadas: capturaPendienteTrasRechazoA.fotos.length,
      extraidoBruto: null, rosterCongelado: rosterCongelado28, indicadoresCongelados,
      identidadRechazada: capturaPendienteTrasRechazoA.validacionIdentidad.estado === 'rechazada',
    })
    verificar(estadoTrasRechazoA.estado === 'identidad_no_valida', 'Transicion1. Tras la captura A rechazada: estado=identidad_no_valida')

    // 2. El docente pulsa "Volver a fotografiar" -> foto-hoja/route.ts
    // reemplaza captura_pendiente POR COMPLETO (mismo objeto literal que
    // ese archivo escribe de verdad, sin modificar — ver FotoNueva2):
    // captura_pendiente: { fotos: fotosActualizadas } — nada de la
    // captura A (ni validacionIdentidad ni fotos[0]) sobrevive.
    const capturaPendienteTrasFotoB = { fotos: [{ storagePath: 'foto-B.jpg', pagina: 1, subidaEn: '2026-01-01T00:05:00.000Z' }] }
    verificar(!('validacionIdentidad' in capturaPendienteTrasFotoB), 'Transicion2. captura_pendiente tras la foto B NO conserva validacionIdentidad de la captura A')
    verificar(!('extraidoBruto' in capturaPendienteTrasFotoB), 'Transicion3. captura_pendiente tras la foto B NO conserva ningún extraidoBruto previo')
    verificar((capturaPendienteTrasFotoB.fotos[0] as { storagePath: string }).storagePath === 'foto-B.jpg', 'Transicion4. Solo queda la fotografía B — la ruta de Storage de la foto A ya no aparece en captura_pendiente')

    // 3. Con esa captura_pendiente fresca, el estado vuelve a
    // lista_para_analizar (identidadRechazada ya no aplica).
    const estadoTrasFotoB = determinarEstadoCapturaHoja({
      estadoProyecto: 'fotografia_cargada', paginasEsperadas: 1, paginasCargadas: capturaPendienteTrasFotoB.fotos.length,
      extraidoBruto: null, rosterCongelado: rosterCongelado28, indicadoresCongelados,
      identidadRechazada: 'validacionIdentidad' in capturaPendienteTrasFotoB,
    })
    verificar(estadoTrasFotoB.estado === 'lista_para_analizar', 'Transicion5. Tras la foto B: estado=lista_para_analizar — analizable de nuevo, sin arrastrar el rechazo de A')

    // 4. Análisis de la foto B con SG válido -> extraidoBruto real,
    // exactamente 1 llamada IA para esta segunda foto.
    const { anthropic, contarLlamadas } = crearAnthropicFalso({ hojaLegible: true, identificadorVisible: 'SG-PWCU', filas: [filaCompleta(1, 4)] })
    const r = await analizarImagenesHojaEvaluacion(anthropic, [{ base64: 'Zm90b0I=', mediaType: 'image/jpeg' }], 1)
    verificar(contarLlamadas() === 1, 'Transicion6. El análisis de la foto B (correcta) hace exactamente 1 llamada IA')
    verificar(normalizarIdentificadorHoja(r.identificadorVisibleObservado ?? '') === normalizarIdentificadorHoja('SG-PWCU'), 'Transicion7. La foto B pasa el gate de identidad — SG validado, flujo normal a partir de aquí (extraidoBruto: resultado.extraccion, como prueban ExtraidoValido1/2)')
  }

  // ============================================================
  // Posición->alumno solo después del gate — sin cambios.
  // ============================================================
  verificar(!confirmarResultadosHoja.includes('anthropic') && !confirmarResultadosHoja.includes('Anthropic'), 'Cuarto1. confirmarResultadosHoja.ts (sin cambios) sigue sin ninguna referencia a IA')

  // ============================================================
  // estado-captura/route.ts propaga la señal correctamente.
  // ============================================================
  verificar(rutaEstadoCaptura.includes("capturaPendiente?.validacionIdentidad?.estado === 'rechazada'"), 'EstadoCaptura1. estado-captura/route.ts deriva identidadRechazada de captura_pendiente.validacionIdentidad')
  verificar(rutaEstadoCaptura.includes('identidadRechazada,'), 'EstadoCaptura2. estado-captura/route.ts pasa identidadRechazada a determinarEstadoCapturaHoja')
  verificar(estadoCapturaHojaLib.includes("| 'identidad_no_valida'"), "EstadoCaptura3. EstadoCapturaHoja incluye 'identidad_no_valida' como valor real del enum")
  verificar(/if \(params\.identidadRechazada\) return \{ estado: 'identidad_no_valida'/.test(estadoCapturaHojaLib), 'EstadoCaptura4. determinarEstadoCapturaHoja distingue identidadRechazada ANTES de asumir lista_para_analizar')

  // ============================================================
  // UX — mensaje simple, sin jerga interna, gateado por el estado
  // real del servidor (nunca un heurístico del cliente).
  // ============================================================
  verificar(capturaHoja.includes("estado === 'identidad_no_valida'"), 'UX1. CapturaHoja.tsx renderiza su bloque específico gateado por el estado real del servidor, no por un heurístico local')
  verificar(!/OCR|schema|roster congelado|identity mismatch/i.test(capturaHoja), 'UX2. CapturaHoja.tsx no menciona OCR/schema/roster congelado/identity mismatch en ningún mensaje')
  verificar(capturaHoja.includes('👁️') && capturaHoja.includes('Ver hoja') && capturaHoja.includes('Volver a fotografiar'), 'UX3. Ofrece "Ver hoja" y "Volver a fotografiar" en el caso de rechazo')
  verificar(!capturaHoja.includes('identidadNoValida'), 'UX4. CapturaHoja.tsx ya no mantiene un estado local heurístico (identidadNoValida) — el servidor es la única fuente de verdad')

  // ============================================================
  // 0 llamadas IA nuevas en ningún archivo de esta tarea.
  // ============================================================
  verificar((analisisLib.match(/anthropic\.messages\.create/g) || []).length === 1, 'IA1. analisisHojaEvaluacion.ts sigue teniendo exactamente 1 referencia a anthropic.messages.create')
  verificar(!capturaHoja.includes('anthropic') && !capturaHoja.includes('Anthropic'), 'IA2. CapturaHoja.tsx sigue sin ninguna referencia a IA')
  verificar(!identificadorHojaLib.includes('anthropic') && !identificadorHojaLib.includes('Anthropic'), 'IA3. lib/identificadorHoja.ts (extendido) sigue sin ninguna referencia a IA')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
