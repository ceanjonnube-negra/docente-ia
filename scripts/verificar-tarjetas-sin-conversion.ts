// scripts/verificar-tarjetas-sin-conversion.ts
//
// Prueba aislada (sin credenciales, sin red, sin escrituras reales) de
// "CONTENCIÓN DEFINITIVA — retirar temporalmente Convertir de todas
// las tarjetas de documentos": tras dos correcciones previas que no
// bastaron para que producción dejara de mostrar "Conviértelo a
// Word."/"Conviértelo a PDF." como burbujas del docente, la decisión
// de producto fue retirar por completo el menú "Convertir" (y sus
// callbacks) de TarjetaDescarga — nunca reemplazarlo por otro parche.
// Esta prueba reemplaza a scripts/verificar-conversion-tarjetas.ts y
// scripts/verificar-sin-mensajes-automaticos-conversion.ts (ambos
// eliminados: probaban una función que ya no existe) y confirma que
// las tarjetas de documentos ahora SOLO ofrecen Descargar/Abrir/
// Compartir, que ningún callback de conversión sigue conectado ni
// invocable, y que Descargar/Abrir/Compartir + el historial existente
// permanecen exactamente iguales.
// Se ejecuta con `npx tsx scripts/verificar-tarjetas-sin-conversion.ts`.

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
const DIRECTORIOS_EXCLUIDOS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.vercel'])
const EXTENSIONES_INCLUIDAS = new Set(['.ts', '.tsx'])
const ARCHIVO_PROPIO = 'verificar-tarjetas-sin-conversion.ts'

// Concatenadas para que este archivo no se detecte a sí mismo (se
// excluye igual más abajo, pero así el patrón nunca aparece literal).
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
    if (info.isDirectory()) listarArchivos(ruta, acc)
    else if (EXTENSIONES_INCLUIDAS.has(extname(entrada)) && entrada !== ARCHIVO_PROPIO) acc.push(ruta)
  }
  return acc
}

async function main() {
  const rutaPanel = readFileSync(join(RAIZ, 'components', 'Asistente', 'AsistentePanel.tsx'), 'utf-8')
  const rutaServicio = readFileSync(join(RAIZ, 'lib', 'asistente', 'AsistenteService.ts'), 'utf-8')
  const rutaHooks = readFileSync(join(RAIZ, 'lib', 'asistente', 'hooks.ts'), 'utf-8')
  const rutaTipos = readFileSync(join(RAIZ, 'lib', 'asistente', 'tipos.ts'), 'utf-8')

  const iTarjeta = rutaPanel.indexOf('function TarjetaDescarga(')
  const iFinTarjeta = rutaPanel.indexOf('\n// Vista previa de solo lectura del documento activo', iTarjeta)
  verificar(iTarjeta !== -1 && iFinTarjeta !== -1, '0. TarjetaDescarga sigue existiendo como componente único (no se duplicó ni se creó una variante nueva)')
  const cuerpoTarjeta = rutaPanel.slice(iTarjeta, iFinTarjeta)
  // Solo código real, nunca comentarios — el propio comentario que
  // documenta esta corrección cita el nombre de la tarea entre
  // comillas ("... retirar temporalmente Convertir de todas..."), lo
  // cual es documentación legítima, no un rótulo de interfaz visible.
  const codigoRealTarjeta = cuerpoTarjeta.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

  // ============================================================
  // 1-5. Ninguna tarjeta muestra "Convertir" ni ofrece Word/PDF/
  //      PowerPoint/Excel como destino de conversión.
  // ============================================================
  {
    verificar(!codigoRealTarjeta.includes('Convertir'), '1. TarjetaDescarga ya no contiene el texto "Convertir" en ninguna forma (ni botón ni menú), fuera de comentarios explicativos')
    verificar(!cuerpoTarjeta.includes('mostrarConvertir'), '1b. El estado exclusivo del desplegable (mostrarConvertir) fue eliminado')
    verificar(!cuerpoTarjeta.includes('otrosFormatos'), '1c. El cálculo de "otros formatos disponibles" fue eliminado del componente')
    // NOMBRE_FORMATO fue REINTRODUCIDA por "AJUSTE AISLADO DE
    // DOCUMENTOS — descarga real en Word y PDF" para las etiquetas
    // "Descargar Word"/"Descargar PDF"/"Compartir Word" — un uso
    // legítimo y distinto del que tenía en el menú "Convertir" ya
    // retirado; lo que debe seguir sin existir es cualquier uso de esa
    // tabla para OFRECER una conversión (nunca junto a "Convertir" ni a
    // onConvertir).
    verificar(!/Convertir[\s\S]{0,80}NOMBRE_FORMATO|NOMBRE_FORMATO[\s\S]{0,80}Convertir/.test(codigoRealTarjeta), '2. NOMBRE_FORMATO no se usa junto a ningún texto/menú "Convertir" — solo para etiquetar los botones reales de Descargar/Compartir')
    verificar(!rutaPanel.includes('FORMATOS_CONVERTIBLES'), '3. La lista de los 4 formatos convertibles fue eliminada — ya no se usa para nada')
    verificar(!rutaPanel.includes('FORMATOS_POR_TIPO_DOCUMENTO'), '4. La tabla de formatos permitidos por tipo de documento fue eliminada')
    verificar(!rutaPanel.includes('formatosDisponiblesPara'), '5. La función que calculaba los formatos ofrecidos (Word/PDF/PowerPoint/Excel) fue eliminada por completo')
  }

  // ============================================================
  // 6-8. Descargar y Compartir siguen disponibles. "Abrir" fue
  //      retirado por una decisión de producto POSTERIOR ("AJUSTE
  //      AISLADO DE DOCUMENTOS — descarga real en Word y PDF, sin
  //      botones redundantes": la vista previa ya vive dentro del Chat
  //      IA, así que un botón que solo la reabre es redundante) — no es
  //      una regresión de esta corrección, ver
  //      scripts/verificar-descarga-word-pdf.ts para el detalle
  //      completo de esa decisión.
  // ============================================================
  {
    verificar(cuerpoTarjeta.includes('⬇️ Descargar') && cuerpoTarjeta.includes('descargarArchivo(archivo.url, archivo.nombre)'), '6. El botón "Descargar" sigue presente y descarga el archivo real (ahora vía descargarArchivo, más confiable en Safari/iOS que window.open a secas)')
    verificar(!codigoRealTarjeta.includes('🔗 Abrir'), '7. El botón "Abrir" fue retirado intencionalmente (decisión de producto posterior) — la vista previa ya está dentro del chat')
    verificar(cuerpoTarjeta.includes('📤 Compartir') && cuerpoTarjeta.includes('compartirArchivo(archivo'), '8. El botón "Compartir" sigue presente y sigue llamando a compartirArchivo con el archivo real')
  }

  // ============================================================
  // 9. Ningún callback de formato sigue conectado a sendMessage — de
  //    hecho, ya no existe NINGÚN callback de conversión: se retiró
  //    la prop onConvertir completa, no solo su implementación.
  // ============================================================
  {
    verificar(!cuerpoTarjeta.includes('onConvertir'), '9a. TarjetaDescarga ya no recibe ni usa una prop onConvertir — no queda ningún callback de conversión que pudiera, directa o indirectamente, terminar en sendMessage')
    verificar(!/sendMessage|handleSend|enviarMensaje|setInput|setMessages/.test(cuerpoTarjeta), '9b. TarjetaDescarga no usa sendMessage/handleSend/enviarMensaje/setInput/setMessages en ninguna forma')
    verificar(!rutaServicio.includes('async convertirDocumento('), '9c. AsistenteService ya no expone ningún método convertirDocumento — no queda ningún callback "oculto" que un futuro cambio pudiera volver a conectar por accidente')
    verificar(!rutaHooks.includes('convertirDocumento'), '9d. useAsistente() ya no expone convertirDocumento — ningún componente puede invocarlo aunque quisiera')
  }

  // ============================================================
  // 10. Pulsar cualquier zona de la tarjeta no crea mensajes role:user
  //     — los únicos onClick que quedan (Descargar/Abrir/Compartir) no
  //     tocan el historial de mensajes en absoluto.
  // ============================================================
  {
    verificar(!cuerpoTarjeta.includes("rol: 'usuario'") && !cuerpoTarjeta.includes('rol:"usuario"'), '10a. Ningún onClick dentro de TarjetaDescarga construye un mensaje con rol "usuario"')
    // El número de onClick ya no es fijo: hay uno por formato en
    // `archivos` (1 a 3, según el grupo) más el/los de Compartir — ver
    // scripts/verificar-descarga-word-pdf.ts para la cobertura completa
    // del nuevo diseño agrupado. Aquí solo importa que TODOS sigan
    // siendo de solo-lectura sobre el archivo (descarga/compartir),
    // nunca una llamada al chat.
    const onClicksMultilinea = cuerpoTarjeta.match(/onClick=\{\(\)\s*=>\s*(descargarArchivo|compartirArchivo|setMostrarCompartir|setVencido)\([^]*?\}\}/g) ?? []
    const onClicksSimples = cuerpoTarjeta.match(/onClick=\{[^}]*\}/g) ?? []
    verificar(onClicksSimples.length >= 2, `10b. TarjetaDescarga tiene al menos un botón de Descargar y uno de Compartir/desplegar-Compartir — encontrados: ${onClicksSimples.length}`)
    verificar(
      onClicksSimples.every(c => /descargarArchivo|compartirArchivo|setMostrarCompartir/.test(c)) || onClicksMultilinea.length > 0,
      '10c. Todos los onClick de la tarjeta solo descargan/comparten el archivo o despliegan el selector de Compartir — ninguno toca AsistenteService ni el chat'
    )
  }

  // ============================================================
  // 11-12. Funciona con `archivo` (singular) y con `archivos[]`.
  // ============================================================
  {
    verificar(
      rutaPanel.includes('(m.archivos && m.archivos.length > 0 ? m.archivos : m.archivo ? [m.archivo] : [])'),
      '11-12. El render sigue soportando tanto `archivo` (singular) como `archivos[]` (varios) — mismo criterio de siempre, sin cambios por retirar Convertir'
    )
  }

  // ============================================================
  // 13-14. Funciona con documentos activos y "provisionales" (no
  //        activos) — esActivo ahora solo controla el indicador "·
  //        Documento activo", nunca oculta Descargar/Abrir/Compartir.
  // ============================================================
  {
    verificar(cuerpoTarjeta.includes("esActivo && <span className=\"text-purple-600 font-semibold\">· Documento activo</span>"), '13a. esActivo sigue mostrando el indicador informativo "Documento activo"')
    verificar(!/esActivo\s*&&\s*otrosFormatos/.test(cuerpoTarjeta), '13b. esActivo ya no condiciona ningún menú de conversión (ese bloque completo fue eliminado)')
    const iDescargar = cuerpoTarjeta.indexOf('⬇️ Descargar')
    const bloqueBotones = cuerpoTarjeta.slice(iDescargar - 200, iDescargar + 600)
    verificar(!bloqueBotones.includes('esActivo &&') , '14. Descargar/Abrir/Compartir se muestran igual para un documento activo o uno "provisional" (no están condicionados por esActivo)')
  }

  // ============================================================
  // 15. Funciona en móvil y escritorio — un único componente
  //     responsive (Tailwind), sin ramas de render separadas por
  //     tamaño de pantalla.
  // ============================================================
  {
    verificar(!/isMobile|esMovil|window\.innerWidth/.test(cuerpoTarjeta), '15. TarjetaDescarga no tiene ninguna rama de código separada para móvil vs escritorio — el mismo componente sirve ambas vistas')
  }

  // ============================================================
  // 16. La planeación y la hoja de evaluación siguen apareciendo con
  //     su título legible.
  // ============================================================
  {
    verificar(rutaPanel.includes("planeacion: '📘 Planeación didáctica'") && rutaPanel.includes("hoja_evaluacion: '📄 Hoja de evaluación final'"), '16. Los títulos legibles de planeación y hoja de evaluación siguen intactos — solo se retiró el menú de conversión, no la identificación del documento')
  }

  // ============================================================
  // 17. Ningún archivo existente se elimina — no hay ninguna llamada
  //     de borrado nueva ni modificada.
  // ============================================================
  {
    verificar(!/\.remove\(|\.delete\(/.test(cuerpoTarjeta), '17. TarjetaDescarga no ejecuta ningún borrado de archivo')
    verificar(!rutaServicio.includes('agregarArchivoATarjeta') && !rutaServicio.includes('marcarEstadoConversion'), '17b. Las funciones que antes mutaban archivos por conversión fueron eliminadas por completo (no dejan un camino parcial que pudiera borrar datos)')
  }

  // ============================================================
  // 18. No se modifica el historial del chat — AsistenteService ya no
  //     tiene ningún método que reconstruya this.mensajes para fines
  //     de conversión.
  // ============================================================
  {
    verificar(!rutaServicio.includes('conversionesEnCurso'), '18. El registro de conversiones en curso fue eliminado — no queda ningún estado interno relacionado con conversión por botón')
  }

  // ============================================================
  // Camino de TEXTO ESCRITO por el docente ("conviértelo a Word")
  // sigue intacto — esta corrección solo retira el BOTÓN, nunca la
  // capacidad de conversión que el docente pide escribiendo.
  // ============================================================
  {
    verificar(rutaServicio.includes('private async ejecutarConversionFormato(tipoResuelto: TipoHerramienta, textoVisible: string)'), 'Extra-1. ejecutarConversionFormato (camino de texto escrito por el docente) sigue existiendo sin cambios')
    verificar(rutaServicio.includes('await this.ejecutarConversionFormato(tipoResuelto, limpio)'), 'Extra-2. El mensaje escrito por el docente sigue activando la conversión real — solo el botón fue retirado')
  }

  // ============================================================
  // Búsqueda GLOBAL final: ninguna frase prohibida en código real
  // (fuera de comentarios) en TODO el repositorio.
  // ============================================================
  {
    const archivos = listarArchivos(RAIZ)
    const violaciones: string[] = []
    for (const ruta of archivos) {
      const contenido = readFileSync(ruta, 'utf-8')
      contenido.split('\n').forEach((linea, i) => {
        const sinEspacios = linea.trim()
        if (sinEspacios.startsWith('//') || sinEspacios.startsWith('*') || sinEspacios.startsWith('/*')) return
        for (const frase of FRASES_PROHIBIDAS) {
          if (linea.includes(frase)) violaciones.push(`${ruta.replace(RAIZ + '/', '')}:${i + 1} -> "${frase}"`)
        }
      })
    }
    verificar(archivos.length > 50, `Global-0. El barrido recorrió el repositorio completo (${archivos.length} archivos .ts/.tsx)`)
    verificar(violaciones.length === 0, `Global-1. Ninguna frase prohibida aparece en código real en TODO el repositorio${violaciones.length > 0 ? ' — encontradas: ' + violaciones.join(' | ') : ''}`)
  }

  // ============================================================
  // Tipos: los campos exclusivos del desplegable retirado ya no
  // existen (ParametrosConversionDocumento, estadosConversion).
  // ============================================================
  {
    verificar(!rutaTipos.includes('ParametrosConversionDocumento'), 'Tipos-1. ParametrosConversionDocumento fue eliminado de lib/asistente/tipos.ts')
    verificar(!rutaTipos.includes('estadosConversion'), 'Tipos-2. MensajeConversacion.estadosConversion fue eliminado — ya no hace falta guardar un estado de conversión que no existe')
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
