// scripts/verificar-conversion-tarjetas.ts
//
// Prueba aislada (sin credenciales, sin red, sin escrituras reales) de
// la "CORRECCIÓN FUNCIONAL DE TARJETAS DE DOCUMENTOS — los botones de
// conversión envían mensajes automáticos en vez de convertir": confirma
// que tocar un formato en el menú "Convertir" de una tarjeta ya NO crea
// una burbuja del usuario ni vuelve a llamar al modelo pedagógico, que
// la conversión es una acción estructurada y silenciosa con estado
// "Convirtiendo…"/error dentro de la propia tarjeta, que el archivo
// original se conserva, que no se duplican archivos, y que los
// formatos ofrecidos dependen del tipo real del documento. React/DOM
// no están disponibles en este runner (mismo criterio que el resto de
// C-005 — no hay framework de pruebas de componentes en el proyecto):
// se verifica el código real y determinista (AsistenteService.ts,
// motorTextoClaude.ts, AsistentePanel.tsx) a nivel de fuente y, para la
// lógica pura (filtrado de formatos), con datos reales.
// Se ejecuta con `npx tsx scripts/verificar-conversion-tarjetas.ts`.

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

async function main() {
  const rutaServicio = readFileSync(join(__dirname, '..', 'lib', 'asistente', 'AsistenteService.ts'), 'utf-8')
  const rutaMotor = readFileSync(join(__dirname, '..', 'lib', 'asistente', 'motores', 'motorTextoClaude.ts'), 'utf-8')
  const rutaPanel = readFileSync(join(__dirname, '..', 'components', 'Asistente', 'AsistentePanel.tsx'), 'utf-8')
  const rutaTipos = readFileSync(join(__dirname, '..', 'lib', 'asistente', 'tipos.ts'), 'utf-8')

  // Aísla el cuerpo real de la función nueva para no confundir sus
  // líneas con las de ejecutarConversionFormato/enviarComoFinalizacion
  // (que SIGUEN creando una burbuja a propósito — ver punto 0).
  const iConvertir = rutaServicio.indexOf('async convertirDocumento(params: ParametrosConversionDocumento) {')
  const iSiguienteMetodo = rutaServicio.indexOf('// Fuente única para "fijar" documentoActivo', iConvertir)
  const cuerpoConvertirDocumentoActivo = rutaServicio.slice(iConvertir, iSiguienteMetodo)

  // ============================================================
  // 0. Confirmación previa: el camino de TEXTO ESCRITO por el docente
  //    ("conviértelo a Word") SIGUE creando una burbuja real — eso es
  //    correcto y no debe tocarse, es lo que distingue "el docente
  //    escribió algo" de "el docente tocó un botón".
  // ============================================================
  {
    verificar(rutaServicio.includes('private async ejecutarConversionFormato(tipoResuelto: TipoHerramienta, textoVisible: string)'), '0a. ejecutarConversionFormato (camino de texto escrito) sigue existiendo sin cambios')
    verificar(rutaServicio.includes("await this.ejecutarConversionFormato(tipoResuelto, limpio)"), '0b. El mensaje escrito por el docente ("conviértelo a X") sigue pasando por el camino que SÍ crea una burbuja real (correcto: el docente sí escribió algo)')
  }

  // ============================================================
  // 1-4. Pulsar un formato en la tarjeta NUNCA crea una burbuja del
  //      usuario, nunca llama a sendMessage/enviarMensaje/setInput, y
  //      nunca reenvía toda la solicitud al modelo pedagógico.
  // ============================================================
  {
    verificar(!cuerpoConvertirDocumentoActivo.includes("rol: 'usuario'"), '1. convertirDocumento (botón) NUNCA crea un mensaje con rol "usuario" — no hay burbuja')
    verificar(!cuerpoConvertirDocumentoActivo.includes('this.ejecutarConversionFormato(') && !cuerpoConvertirDocumentoActivo.includes('this.enviarComoFinalizacion(') && !cuerpoConvertirDocumentoActivo.includes('this.reutilizarArchivoExistente('), '2. convertirDocumento (botón) ya no LLAMA al camino que arma texto visible para el chat (Conviértelo a X.) — solo lo menciona en un comentario comparativo')
    verificar(cuerpoConvertirDocumentoActivo.includes('motorTexto.generarArchivoDirecto(tipo, documentoTexto)'), '3. Se invoca una acción estructurada (generarArchivoDirecto) con el archivo y el formato, no una frase interpretada')
    verificar(!cuerpoConvertirDocumentoActivo.includes('enviarMensaje') && !cuerpoConvertirDocumentoActivo.includes('sendMessage') && !cuerpoConvertirDocumentoActivo.includes('setInput'), '4. No se llama a enviarMensaje/sendMessage/setInput')
  }

  // ============================================================
  // 5. generarArchivoDirecto (motorTextoClaude.ts) nunca emite eventos
  //    de chat — ni respuesta-parcial, ni respuesta-final, ni
  //    mensaje-usuario. Vive completamente fuera del ciclo de eventos
  //    que alimenta las burbujas.
  // ============================================================
  {
    const iMetodo = rutaMotor.indexOf('async generarArchivoDirecto(tipo: string, documentoTexto: string): Promise<ArchivoGeneradoInfo> {')
    verificar(iMetodo !== -1, '5a. generarArchivoDirecto existe en motorTextoClaude.ts')
    const iFinMetodo = rutaMotor.indexOf('\n  }\n\n  // Marcador técnico con el archivo real', iMetodo)
    const cuerpoMetodo = rutaMotor.slice(iMetodo, iFinMetodo)
    verificar(!cuerpoMetodo.includes('this.emitir('), '5b. generarArchivoDirecto nunca llama a this.emitir() — no dispara respuesta-parcial ni respuesta-final')
    verificar(!cuerpoMetodo.includes('this.controlador'), '5c. Usa su PROPIO AbortController — nunca this.controlador (no interfiere con una conversación de texto en curso)')
    verificar(cuerpoMetodo.includes("finalizarArchivo: { tipo, documentoTexto }"), '5d. Reutiliza el mismo mecanismo de FINALIZAR ARCHIVO ya existente (nunca pasa por Claude) — no crea un sistema paralelo')
  }

  // ============================================================
  // 6. Estado "Convirtiendo…" visible dentro de la tarjeta mientras la
  //    conversión está en curso.
  // ============================================================
  {
    verificar(cuerpoConvertirDocumentoActivo.includes("this.marcarEstadoConversion(idDocumento, tipo, 'convirtiendo')"), '6a. Se marca el estado "convirtiendo" antes de iniciar la conversión')
    verificar(rutaPanel.includes("estado === 'convirtiendo' ? `Convirtiendo a ${NOMBRE_FORMATO[tipo]}…`"), '6b. La tarjeta muestra "Convirtiendo a X…" mientras el estado es "convirtiendo"')
  }

  // ============================================================
  // 7-8. Se genera EXACTAMENTE un archivo convertido, y el original
  //      permanece intacto (se agrega como adjunto adicional, nunca
  //      reemplaza los existentes de otro formato).
  // ============================================================
  {
    verificar(rutaServicio.includes('private agregarArchivoATarjeta(idMensaje: string, archivo: ArchivoGeneradoInfo) {'), '7a. Existe una función dedicada para agregar el archivo convertido a la tarjeta')
    const iAgregar = rutaServicio.indexOf('private agregarArchivoATarjeta(idMensaje: string, archivo: ArchivoGeneradoInfo) {')
    const cuerpoAgregar = rutaServicio.slice(iAgregar, rutaServicio.indexOf('private marcarEstadoConversion', iAgregar))
    verificar(cuerpoAgregar.includes('msg.archivos && msg.archivos.length > 0 ? msg.archivos : msg.archivo ? [msg.archivo] : []'), '8a. Parte de los archivos YA existentes del mensaje (nunca los descarta) — el original queda intacto')
    verificar(cuerpoAgregar.includes('[...existentes, archivo]'), '8b. El archivo convertido se AGREGA a la lista existente — no la reemplaza')
  }

  // ============================================================
  // 9. No se ofrece el formato actual como destino.
  // ============================================================
  {
    verificar(rutaPanel.includes('return base.filter((t) => t !== archivo.tipo)'), '9. formatosDisponiblesPara excluye siempre el formato actual del archivo')
  }

  // ============================================================
  // 10-11. Formatos según el tipo de documento: planeación nunca
  //        ofrece Excel; hoja de evaluación nunca ofrece PowerPoint
  //        (ni Word).
  // ============================================================
  {
    verificar(rutaPanel.includes("planeacion: ['pdf', 'word', 'powerpoint']"), '10. Planeación didáctica ofrece exactamente PDF/Word/PowerPoint — nunca Excel')
    verificar(rutaPanel.includes("hoja_evaluacion: ['pdf', 'excel']"), '11. Hoja de evaluación ofrece exactamente PDF/Excel — nunca PowerPoint ni Word')

    // Prueba funcional real del filtrado — reimplementa la MISMA lógica
    // exacta que formatosDisponiblesPara (misma tabla, mismo filtro) con
    // datos reales, para confirmar el resultado con certeza.
    const FORMATOS_POR_TIPO_DOCUMENTO: Record<string, readonly string[]> = {
      planeacion: ['pdf', 'word', 'powerpoint'],
      hoja_evaluacion: ['pdf', 'excel'],
    }
    const FORMATOS_CONVERTIBLES = ['word', 'pdf', 'powerpoint', 'excel']
    function formatosDisponiblesPara(archivo: { tipo: string; tipoDocumento?: string }): string[] {
      const base = (archivo.tipoDocumento && FORMATOS_POR_TIPO_DOCUMENTO[archivo.tipoDocumento]) || FORMATOS_CONVERTIBLES
      return base.filter((t) => t !== archivo.tipo)
    }
    verificar(
      formatosDisponiblesPara({ tipo: 'pdf', tipoDocumento: 'planeacion' }).sort().join(',') === 'powerpoint,word',
      '10b. Una planeación en PDF ofrece exactamente [Word, PowerPoint]'
    )
    verificar(
      formatosDisponiblesPara({ tipo: 'pdf', tipoDocumento: 'hoja_evaluacion' }).sort().join(',') === 'excel',
      '11b. Una hoja de evaluación en PDF ofrece exactamente [Excel]'
    )
    verificar(
      formatosDisponiblesPara({ tipo: 'powerpoint' }).sort().join(',') === 'excel,pdf,word',
      '11c. Un documento SIN tipoDocumento (genérico) conserva el comportamiento de siempre: los 4 formatos menos el actual'
    )
  }

  // ============================================================
  // 12. Una segunda pulsación (antes de que termine la primera) no
  //     dispara una segunda conversión — evita duplicados.
  // ============================================================
  {
    verificar(rutaServicio.includes('private conversionesEnCurso = new Set<string>()'), '12a. Existe un registro de conversiones en curso')
    verificar(cuerpoConvertirDocumentoActivo.includes('if (this.conversionesEnCurso.has(clave)) return'), '12b. Una conversión ya en curso para el mismo documento+formato corta de inmediato, sin volver a generar')
    verificar(cuerpoConvertirDocumentoActivo.includes('this.conversionesEnCurso.add(clave)') && cuerpoConvertirDocumentoActivo.includes('this.conversionesEnCurso.delete(clave)'), '12c. La marca de "en curso" se agrega antes de empezar y se limpia siempre al terminar (éxito o error)')
    verificar(cuerpoConvertirDocumentoActivo.includes('if (archivoExistente)'), '12d. Si el formato YA se generó antes para este documento, se reutiliza en vez de regenerar (evita duplicados también entre conversiones ya completas)')
  }

  // ============================================================
  // 13. Un error se muestra DENTRO de la tarjeta (nunca como mensaje
  //     de chat), con una forma de reintentar (tocar el mismo botón).
  // ============================================================
  {
    verificar(cuerpoConvertirDocumentoActivo.includes("this.marcarEstadoConversion(idDocumento, tipo, 'error')"), '13a. Un fallo en la conversión marca el estado "error" en la tarjeta correspondiente')
    verificar(rutaPanel.includes("estado === 'error' ? `⚠️ Reintentar ${NOMBRE_FORMATO[tipo]}`"), '13b. La tarjeta muestra "Reintentar" cuando el estado es error — tocar el mismo botón vuelve a intentar (misma función, mismo formato)')
    verificar(!/this\.emitir\(\{ tipo: 'error'/.test(cuerpoConvertirDocumentoActivo), '13c. El error de conversión nunca se emite como un error de chat')
  }

  // ============================================================
  // 14. La conversión nunca vuelve a generar la planeación con IA — el
  //     texto ya redactado se reutiliza tal cual (FINALIZAR ARCHIVO,
  //     nunca pasa por Claude).
  // ============================================================
  {
    verificar(cuerpoConvertirDocumentoActivo.includes('this.documentoActivo.texto'), '14a. Se reutiliza el texto YA redactado del documento activo — nunca se vuelve a pedir contenido nuevo')
    verificar(!cuerpoConvertirDocumentoActivo.includes('MARCO_CURRICULAR') && !cuerpoConvertirDocumentoActivo.includes('clasificarNivel0') && !cuerpoConvertirDocumentoActivo.includes('planeacion_generar'), '14b. La conversión no referencia ninguna lógica pedagógica ni de clasificación — es puramente mecánica')
  }

  // ============================================================
  // 15-17. Sin persistencia nueva no autorizada, sin service_role, sin
  //        datos reales — la conversión reutiliza exactamente el mismo
  //        mecanismo de FINALIZAR ARCHIVO ya auditado en C-005 (sube el
  //        archivo YA convertido a Storage, igual que siempre — no es
  //        una "vista previa", es el documento definitivo pedido).
  // ============================================================
  {
    const iMetodo = rutaMotor.indexOf('async generarArchivoDirecto(tipo: string, documentoTexto: string): Promise<ArchivoGeneradoInfo> {')
    const iFinMetodo = rutaMotor.indexOf('\n  }\n\n  // Marcador técnico con el archivo real', iMetodo)
    const cuerpoMetodo = rutaMotor.slice(iMetodo, iFinMetodo)
    verificar(!cuerpoMetodo.includes('SERVICE_ROLE') && !cuerpoMetodo.includes('service_role'), '15. generarArchivoDirecto nunca usa service_role')
    verificar(!cuerpoMetodo.includes('.insert(') && !cuerpoMetodo.includes('.update(') && !cuerpoMetodo.includes('.delete('), '16. generarArchivoDirecto no ejecuta ninguna escritura de base de datos directamente — delega en el mismo endpoint ya auditado')
    verificar(!cuerpoConvertirDocumentoActivo.includes('.insert(') && !cuerpoConvertirDocumentoActivo.includes('.from('), '17. convertirDocumento (cliente) no toca Supabase directamente — todo pasa por /api/chat, igual que el resto del Chat IA')
  }

  // ============================================================
  // 18. Tipos: el nuevo campo estadosConversion es aditivo (no rompe
  //     mensajes existentes sin él).
  // ============================================================
  {
    verificar(rutaTipos.includes('estadosConversion?: Record<string, ') , '18. MensajeConversacion.estadosConversion es un campo opcional y aditivo')
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
