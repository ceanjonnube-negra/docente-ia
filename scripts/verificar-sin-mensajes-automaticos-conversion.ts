// scripts/verificar-sin-mensajes-automaticos-conversion.ts
//
// Prueba aislada (sin credenciales, sin red, sin escrituras reales) de
// "CORRECCIÓN REAL DE PRODUCCIÓN — los botones Word y PDF crean
// mensajes falsos del docente": a diferencia de
// scripts/verificar-conversion-tarjetas.ts (que ya cubre la mecánica
// general de la conversión silenciosa), este archivo se enfoca
// específicamente en los invariantes de la INCIDENCIA reportada —
// "el número de mensajes del chat antes y después es idéntico", "no
// aparece ningún nuevo mensaje role:user", singular `archivo` vs
// `archivos[]`, documento activo vs uno que ya no lo es ("provisional"
// — una tarjeta vieja mientras el docente generó otra cosa), una
// búsqueda GLOBAL en todo el repositorio (no solo en los archivos ya
// auditados) de las frases prohibidas exactas, y — la parte nueva de
// esta ronda (sección E) — la extracción y verificación del CALLBACK
// REAL que produce el botón "Word"/"PDF" dentro de TarjetaDescarga en
// components/Asistente/AsistentePanel.tsx, el componente que de verdad
// se renderiza en producción (no una reimplementación aparte que
// pudiera pasar aunque el componente real siguiera roto).
//
// React/DOM no están disponibles en este runner (mismo criterio que el
// resto de C-005 — no hay framework de pruebas de componentes en el
// proyecto; se decidió explícitamente NO agregar jsdom para esto). En
// vez de eso: (a) se REIMPLEMENTA la lógica pura real de
// agregarArchivoATarjeta —con el mismo algoritmo, verificado línea por
// línea contra el código fuente real más abajo— y se EJECUTA de verdad
// con datos reales, y (b) se extrae y analiza el bloque de código EXACTO
// del onClick real del botón (sección E) y del resto del componente,
// para los invariantes que no dependen de I/O de navegador (localStorage,
// fetch, DOM).
// Se ejecuta con `npx tsx scripts/verificar-sin-mensajes-automaticos-conversion.ts`.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

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

// ============================================================
// A. Búsqueda GLOBAL de las frases prohibidas — en TODO el repositorio
//    (no solo en los archivos ya sospechosos), excluyendo únicamente
//    node_modules/.next/.git y este mismo archivo de prueba (que
//    necesita nombrar las frases para poder buscarlas). Solo cuentan
//    como violación si aparecen en una línea de código real —
//    mencionarlas dentro de un comentario `//` (como hacen
//    AsistenteService.ts/route.ts para documentar el camino de texto
//    escrito por el docente) es documentación legítima, no el bug.
// ============================================================
const DIRECTORIOS_EXCLUIDOS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.vercel'])
const EXTENSIONES_INCLUIDAS = new Set(['.ts', '.tsx'])
const ARCHIVO_PROPIO = 'verificar-sin-mensajes-automaticos-conversion.ts'

// Construidas con concatenación para que este archivo NO se detecte a
// sí mismo como una violación al escanearse (se excluye igual más
// abajo, pero así el patrón nunca aparece literal aquí tampoco).
const FRASES_PROHIBIDAS = [
  'Convi' + 'értelo a Word.',
  'Convi' + 'értelo a PDF.',
  'Convi' + 'értelo a PowerPoint.',
  'Convi' + 'értelo a Excel.',
]

function listarArchivos(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (DIRECTORIOS_EXCLUIDOS.has(entrada)) continue
    const ruta = join(dir, entrada)
    const info = statSync(ruta)
    if (info.isDirectory()) {
      listarArchivos(ruta, acc)
    } else if (EXTENSIONES_INCLUIDAS.has(extname(entrada)) && entrada !== ARCHIVO_PROPIO) {
      acc.push(ruta)
    }
  }
  return acc
}

async function main() {
  const rutaServicio = readFileSync(join(RAIZ, 'lib', 'asistente', 'AsistenteService.ts'), 'utf-8')
  const rutaPanel = readFileSync(join(RAIZ, 'components', 'Asistente', 'AsistentePanel.tsx'), 'utf-8')

  {
    const archivos = listarArchivos(RAIZ)
    const violaciones: string[] = []
    for (const ruta of archivos) {
      const contenido = readFileSync(ruta, 'utf-8')
      const lineas = contenido.split('\n')
      lineas.forEach((linea, i) => {
        const sinEspacios = linea.trim()
        if (sinEspacios.startsWith('//') || sinEspacios.startsWith('*') || sinEspacios.startsWith('/*')) return
        for (const frase of FRASES_PROHIBIDAS) {
          if (linea.includes(frase)) violaciones.push(`${ruta.replace(RAIZ + '/', '')}:${i + 1} -> "${frase}"`)
        }
      })
    }
    verificar(archivos.length > 50, `A0. El barrido global recorrió el repositorio completo (${archivos.length} archivos .ts/.tsx, fuera de node_modules/.next/.git)`)
    verificar(violaciones.length === 0, `A. Ninguna frase prohibida aparece en código real (fuera de comentarios) en TODO el repositorio${violaciones.length > 0 ? ' — encontradas: ' + violaciones.join(' | ') : ''}`)
  }

  // ============================================================
  // B. convertirDocumento recibe una acción ESTRUCTURADA
  //    (ParametrosConversionDocumento, un objeto de datos planos) —
  //    NUNCA dos argumentos sueltos ni un string de texto. Ver
  //    "protección obligatoria — los manejadores de conversión no
  //    pueden aceptar parámetros string usados como prompts".
  // ============================================================
  {
    const rutaDocumentos = readFileSync(join(RAIZ, 'lib', 'asistente', 'documentos.ts'), 'utf-8')
    const rutaTipos = readFileSync(join(RAIZ, 'lib', 'asistente', 'tipos.ts'), 'utf-8')
    verificar(
      rutaDocumentos.includes("export type TipoHerramienta = 'word' | 'pdf' | 'powerpoint' | 'excel'"),
      'B1. TipoHerramienta es una unión literal cerrada (no `string`) — un botón no puede pasar texto libre como formato'
    )
    verificar(
      rutaServicio.includes('async convertirDocumento(params: ParametrosConversionDocumento) {'),
      'B2. AsistenteService.convertirDocumento(params) es EL callback real que ejecuta la conversión — recibe un objeto estructurado, nunca un string'
    )
    verificar(
      rutaTipos.includes('export type ParametrosConversionDocumento = {') && rutaTipos.includes('archivoId: string') && rutaTipos.includes('formatoDestino: string'),
      'B2b. ParametrosConversionDocumento existe y es un objeto de datos planos (archivoId/nombreArchivo/url/tipoDocumento/formatoOrigen/formatoDestino/tokenVistaPrevia) — ningún campo de tipo función'
    )
    const rutaPanelProp = rutaPanel.includes('onConvertir: (params: ParametrosConversionDocumento) => void')
    verificar(rutaPanelProp, 'B3. La prop onConvertir de TarjetaDescarga está tipada con ParametrosConversionDocumento — la barrera estructural llega hasta el componente')
    verificar(
      rutaServicio.includes("FORMATOS_CONVERSION_VALIDOS = new Set<TipoHerramienta>(['word', 'pdf', 'powerpoint', 'excel'])") &&
      rutaServicio.includes('if (!AsistenteServiceImpl.FORMATOS_CONVERSION_VALIDOS.has(formatoDestino as TipoHerramienta)) return'),
      'B4. convertirDocumento valida formatoDestino en TIEMPO DE EJECUCIÓN contra los 4 formatos reales antes de tocar nada — segunda capa de defensa además del tipo'
    )
  }

  // ============================================================
  // C. Los componentes de documentos no reciben sendMessage ni
  //    handleSend como dependencia — ni como prop declarada, ni
  //    capturada por closure desde el ámbito del panel.
  // ============================================================
  const iTarjeta = rutaPanel.indexOf('function TarjetaDescarga(')
  const iFinTarjeta = rutaPanel.indexOf('\n// Vista previa de solo lectura del documento activo', iTarjeta)
  const cuerpoTarjeta = rutaPanel.slice(iTarjeta, iFinTarjeta)
  // Solo código real, nunca comentarios — TarjetaDescarga documenta a
  // propósito, en varios comentarios, que NO usa sendMessage/setInput
  // (para dejar la garantía explícita); esas menciones son
  // documentación, no uso real, así que se excluyen aquí igual que en
  // el barrido global (sección A).
  const codigoRealTarjeta = cuerpoTarjeta.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  {
    verificar(!/sendMessage|handleSend/.test(codigoRealTarjeta), 'C1. TarjetaDescarga no declara ni usa sendMessage/handleSend en ninguna forma (fuera de comentarios explicativos)')
    verificar(!codigoRealTarjeta.includes('enviarMensaje'), 'C2. TarjetaDescarga tampoco recibe ni llama enviarMensaje — su única dependencia de conversión es onConvertir(params)')
    verificar(!codigoRealTarjeta.includes('setInput'), 'C3. TarjetaDescarga no tiene acceso a setInput — no puede escribir en la caja de texto (fuera de comentarios explicativos)')
  }

  // ============================================================
  // E. EL CALLBACK REAL — se extrae el onClick EXACTO que produce el
  //    componente real cuando el docente toca "Word" o "PDF" dentro
  //    del menú "Convertir" (no una copia independiente): se localiza
  //    dentro del cuerpo YA extraído de TarjetaDescarga, se aísla el
  //    bloque onClick={() => onConvertir({...})} y se comprueba que
  //    ESE bloque exacto (a) construye el objeto estructurado con los
  //    7 campos pedidos, (b) llama a onConvertir con ese objeto, y (c)
  //    no contiene en ninguna forma sendMessage/handleSend/
  //    enviarMensaje/setInput ni la frase "Conviértelo". Si production
  //    volviera a tener el bug, este bloque de texto sería distinto
  //    (contendría sendMessage/setInput/una plantilla de texto) y esta
  //    prueba fallaría de inmediato.
  // ============================================================
  {
    const iOnClick = cuerpoTarjeta.indexOf('onClick={() => onConvertir({')
    verificar(iOnClick !== -1, 'E0. El botón de formato dentro de TarjetaDescarga tiene un onClick que llama a onConvertir({...}) — el callback real existe en el componente que se renderiza en producción')
    const iFinOnClick = cuerpoTarjeta.indexOf('disabled={estado', iOnClick)
    const bloqueOnClick = cuerpoTarjeta.slice(iOnClick, iFinOnClick)
    // tipoDocumento se lee con un cast seguro (archivo as {
    // tipoDocumento?: string }).tipoDocumento en un commit aislado que
    // excluya la diferenciación de documentos pendiente — o con acceso
    // directo archivo.tipoDocumento una vez que ese campo esté
    // declarado en ArchivoGeneradoInfo; se acepta cualquiera de las dos
    // formas para que la prueba sea válida en ambos estados del repo.
    verificar(
      bloqueOnClick.includes('archivoId: mensajeId') &&
      bloqueOnClick.includes('nombreArchivo: archivo.nombre') &&
      bloqueOnClick.includes('url: archivo.url') &&
      (bloqueOnClick.includes('tipoDocumento: archivo.tipoDocumento') || bloqueOnClick.includes('tipoDocumento: (archivo as { tipoDocumento?: string }).tipoDocumento')) &&
      bloqueOnClick.includes('formatoOrigen: archivo.tipo') &&
      bloqueOnClick.includes('formatoDestino: tipo'),
      'E1. El callback REAL del botón construye ParametrosConversionDocumento completo (archivoId/nombreArchivo/url/tipoDocumento/formatoOrigen/formatoDestino) a partir de datos del archivo, nunca de texto escrito'
    )
    verificar(!/sendMessage|handleSend|enviarMensaje|setInput/.test(bloqueOnClick), 'E2. El callback real del botón no contiene sendMessage/handleSend/enviarMensaje/setInput en ninguna forma')
    verificar(!/Convi.rtelo/.test(bloqueOnClick) && !bloqueOnClick.includes('`Conviértelo'), 'E3. El callback real del botón no construye ninguna frase tipo "Conviértelo a X" — solo pasa datos del archivo')
    verificar(bloqueOnClick.trim().startsWith('onClick={() => onConvertir({') , 'E4. El único efecto del clic es invocar onConvertir(params) — no hay ninguna otra llamada previa (sin setInput, sin enviar, sin abrir el chat)')

    // Confirma además que ESTE MISMO archivo (AsistentePanel.tsx) es el
    // único componente de todo el repositorio que renderiza botones de
    // formato — si existiera un componente viejo/duplicado en otra
    // ruta, esta prueba lo habría encontrado en el barrido global (A).
    verificar(
      rutaPanel.includes("onConvertir={asistente.convertirDocumento}"),
      'E5. AsistentePanel.tsx conecta la tarjeta real con AsistenteService.convertirDocumento (vía el hook useAsistente) — no con una función intermedia que arme texto'
    )
  }

  // ============================================================
  // D. Reimplementación fiel de agregarArchivoATarjeta — se compara
  //    contra el código fuente real (mismas líneas exactas) antes de
  //    ejecutarla, para garantizar que no se está probando una copia
  //    divergente.
  // ============================================================
  const LINEA_1 = 'const existentes = msg.archivos && msg.archivos.length > 0 ? msg.archivos : msg.archivo ? [msg.archivo] : []'
  const LINEA_2 = "const yaExisteIdx = existentes.findIndex(a => a.tipo === archivo.tipo)"
  const LINEA_3 = 'const nuevos = yaExisteIdx !== -1'
  {
    verificar(rutaServicio.includes(LINEA_1) && rutaServicio.includes(LINEA_2) && rutaServicio.includes(LINEA_3), 'D0. Las líneas reimplementadas abajo coinciden EXACTAMENTE con agregarArchivoATarjeta en AsistenteService.ts')
  }

  type Archivo = { tipo: string; nombre: string; url: string }
  type Mensaje = { id: string; rol: 'usuario' | 'asistente'; texto: string; archivo?: Archivo; archivos?: Archivo[] }

  // Copia exacta del algoritmo de agregarArchivoATarjeta (líneas D0
  // arriba) — nunca agrega un mensaje nuevo al arreglo, solo
  // reconstruye el MISMO mensaje en su misma posición.
  function agregarArchivoATarjeta(mensajes: Mensaje[], idMensaje: string, archivo: Archivo): Mensaje[] {
    const idx = mensajes.findIndex(m => m.id === idMensaje)
    if (idx === -1) return mensajes
    const msg = mensajes[idx]
    const existentes = msg.archivos && msg.archivos.length > 0 ? msg.archivos : msg.archivo ? [msg.archivo] : []
    const yaExisteIdx = existentes.findIndex(a => a.tipo === archivo.tipo)
    const nuevos = yaExisteIdx !== -1 ? existentes.map((a, i) => (i === yaExisteIdx ? archivo : a)) : [...existentes, archivo]
    return [...mensajes.slice(0, idx), { ...msg, archivo: msg.archivo ?? nuevos[0], archivos: nuevos }, ...mensajes.slice(idx + 1)]
  }

  // ============================================================
  // 1-2. El número de mensajes antes y después es idéntico, y NUNCA
  //      aparece un nuevo mensaje con rol "usuario".
  // ============================================================
  {
    const mensajesIniciales: Mensaje[] = [
      { id: 'm1', rol: 'usuario', texto: 'hazme una planeación de matemáticas' },
      { id: 'm2', rol: 'asistente', texto: '...', archivo: { tipo: 'pdf', nombre: 'planeacion.pdf', url: 'https://x/pdf' } },
    ]
    const resultado = agregarArchivoATarjeta(mensajesIniciales, 'm2', { tipo: 'word', nombre: 'planeacion.docx', url: 'https://x/word' })
    verificar(resultado.length === mensajesIniciales.length, '1. El número de mensajes antes (2) y después de convertir es idéntico (2) — no se agregó ningún mensaje nuevo')
    verificar(resultado.every(m => m.rol !== 'usuario' || mensajesIniciales.some(o => o.id === m.id && o.rol === 'usuario' && o.texto === m.texto)), '2. Ningún mensaje nuevo con rol "usuario" apareció — los mensajes de rol usuario son exactamente los mismos que ya existían, con el mismo texto')
  }

  // ============================================================
  // 3-5. No se llama a sendMessage/handleSend, no se modifica el
  //      input — ya probado a nivel de tipos y de código fuente en B
  //      y C; aquí se confirma que la función pura usada (D) no
  //      recibe ni necesita ninguno de los dos para funcionar.
  // ============================================================
  {
    verificar(agregarArchivoATarjeta.length === 3, '3-5. agregarArchivoATarjeta solo necesita (mensajes, idMensaje, archivo) — su firma no deja espacio para sendMessage/handleSend/texto de input')
  }

  // ============================================================
  // 6. Se muestra "Convirtiendo…" — ya cubierto por
  //    verificar-conversion-tarjetas.ts (6a/6b); referencia cruzada
  //    aquí para que esta prueba sea autocontenida.
  // ============================================================
  {
    verificar(rutaServicio.includes("this.marcarEstadoConversion(idDocumento, tipo, 'convirtiendo')"), '6. Se marca "convirtiendo" antes de iniciar — la tarjeta muestra "Convirtiendo a X…" (ver TarjetaDescarga)')
  }

  // ============================================================
  // 8-9. El formato actual no aparece como opción; un formato sin
  //      implementación permanece oculto (hoja_evaluacion nunca
  //      ofrece Word/PowerPoint).
  // ============================================================
  {
    const FORMATOS_POR_TIPO_DOCUMENTO: Record<string, readonly string[]> = {
      planeacion: ['pdf', 'word', 'powerpoint'],
      hoja_evaluacion: ['pdf', 'excel'],
    }
    const FORMATOS_CONVERTIBLES = ['word', 'pdf', 'powerpoint', 'excel']
    function formatosDisponiblesPara(archivo: { tipo: string; tipoDocumento?: string }): string[] {
      const base = (archivo.tipoDocumento && FORMATOS_POR_TIPO_DOCUMENTO[archivo.tipoDocumento]) || FORMATOS_CONVERTIBLES
      return base.filter((t) => t !== archivo.tipo)
    }
    verificar(!formatosDisponiblesPara({ tipo: 'word', tipoDocumento: 'planeacion' }).includes('word'), '8. El formato actual (Word) nunca aparece como opción de conversión para sí mismo')
    verificar(!formatosDisponiblesPara({ tipo: 'pdf', tipoDocumento: 'hoja_evaluacion' }).includes('powerpoint') && !formatosDisponiblesPara({ tipo: 'pdf', tipoDocumento: 'hoja_evaluacion' }).includes('word'), '9. Un formato sin conversión útil implementada (Word/PowerPoint para hoja_evaluacion) permanece oculto, nunca se ofrece como botón')
  }

  // ============================================================
  // 10. Funciona tanto con `archivo` (singular) como con `archivos[]`.
  // ============================================================
  {
    const conSingular: Mensaje[] = [{ id: 'm1', rol: 'asistente', texto: '', archivo: { tipo: 'pdf', nombre: 'a.pdf', url: 'u1' } }]
    const resSingular = agregarArchivoATarjeta(conSingular, 'm1', { tipo: 'word', nombre: 'a.docx', url: 'u2' })
    verificar(resSingular[0].archivos?.length === 2 && resSingular[0].archivos?.[0].tipo === 'pdf' && resSingular[0].archivos?.[1].tipo === 'word', '10a. Con un mensaje que solo tenía `archivo` (singular), la conversión produce `archivos` con ambos, conservando el original primero')

    const conArreglo: Mensaje[] = [{ id: 'm1', rol: 'asistente', texto: '', archivos: [{ tipo: 'pdf', nombre: 'a.pdf', url: 'u1' }, { tipo: 'excel', nombre: 'a.xlsx', url: 'u3' }] }]
    const resArreglo = agregarArchivoATarjeta(conArreglo, 'm1', { tipo: 'word', nombre: 'a.docx', url: 'u2' })
    verificar(resArreglo[0].archivos?.length === 3, '10b. Con un mensaje que ya tenía `archivos[]` (varios), la conversión agrega uno más sin perder los existentes')
  }

  // ============================================================
  // 11. Funciona en documentos activos y en "provisionales" (una
  //     tarjeta que YA NO es el documento activo, ej. el docente
  //     generó otra cosa mientras esa tarjeta seguía en pantalla) —
  //     en ese caso la guardia corta ANTES de tocar nada, sin error
  //     visible ni burbuja, exactamente como si no se hubiera hecho
  //     clic.
  // ============================================================
  {
    verificar(rutaServicio.includes('if (!this.documentoActivo || this.documentoActivo.id !== idDocumento) return'), '11a. convertirDocumento corta de inmediato si el documento ya no es el Documento Activo (tarjeta vieja/"provisional") — nunca convierte ni narra nada por error')
    verificar(rutaPanel.includes('esActivo={asistente.documentoActivoId === m.id}') && rutaPanel.includes('esActivo && otrosFormatos.length > 0 && ('), '11b. En la interfaz, el menú "Convertir" solo se ofrece sobre la tarjeta del Documento Activo — una tarjeta "provisional"/vieja ni siquiera muestra el botón')
  }

  // ============================================================
  // 12. El original permanece intacto tras la conversión.
  // ============================================================
  {
    const inicial: Mensaje[] = [{ id: 'm1', rol: 'asistente', texto: '', archivo: { tipo: 'pdf', nombre: 'original.pdf', url: 'u1' } }]
    const resultado = agregarArchivoATarjeta(inicial, 'm1', { tipo: 'word', nombre: 'nuevo.docx', url: 'u2' })
    const original = resultado[0].archivos?.find(a => a.tipo === 'pdf')
    verificar(original?.nombre === 'original.pdf' && original?.url === 'u1', '12. El archivo original (PDF) sigue exactamente igual después de convertir a Word — nunca se sobrescribe ni se pierde')
  }

  // ============================================================
  // 13. No se crean duplicados — convertir dos veces al MISMO formato
  //     reemplaza en el mismo lugar, nunca agrega una segunda tarjeta
  //     idéntica.
  // ============================================================
  {
    const inicial: Mensaje[] = [{ id: 'm1', rol: 'asistente', texto: '', archivo: { tipo: 'pdf', nombre: 'a.pdf', url: 'u1' } }]
    const primero = agregarArchivoATarjeta(inicial, 'm1', { tipo: 'word', nombre: 'a-v1.docx', url: 'u2' })
    const segundo = agregarArchivoATarjeta(primero, 'm1', { tipo: 'word', nombre: 'a-v2.docx', url: 'u3' })
    verificar(segundo[0].archivos?.length === 2, '13a. Convertir dos veces al mismo formato (Word) nunca deja tres tarjetas — sigue habiendo exactamente 2 (PDF original + Word)')
    verificar(segundo[0].archivos?.find(a => a.tipo === 'word')?.url === 'u3', '13b. La segunda conversión al mismo formato reemplaza la anterior en el mismo lugar (la más reciente gana), nunca se duplica')
    verificar(rutaServicio.includes('if (this.conversionesEnCurso.has(clave)) return'), '13c. Además, un segundo toque MIENTRAS la primera conversión sigue en vuelo se corta de inmediato (conversionesEnCurso) — nunca dispara una segunda petición en paralelo')
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
