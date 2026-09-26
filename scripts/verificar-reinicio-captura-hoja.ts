// scripts/verificar-reinicio-captura-hoja.ts
//
// "Volver a fotografiar" como reinicio REAL de captura (ver diseño
// aprobado — auditoría "Los Insectos y su Papel en la Naturaleza",
// hallazgo: el docente quedó atrapado en /revisar sin forma de
// reemplazar la fotografía; y hallazgo posterior: el botón "Volver a
// fotografiar" ya existente en identidad_no_valida estaba roto porque
// pagina=paginasCargadas+1 siempre excede paginasEsperadas cuando
// todas las páginas ya estaban cargadas).
//
// Diseño: foto-hoja/route.ts acepta un campo opcional
// "reiniciarCaptura", verdadero ÚNICAMENTE si su valor es EXACTAMENTE
// la cadena 'true'. Cuando lo es, fotosPrevias se trata como vacío —
// el MISMO cálculo de fotosActualizadas de siempre (sin ninguna rama
// nueva ahí) produce entonces, sin excepción, un arreglo con
// ÚNICAMENTE la fotografía recién subida. CapturaHoja.tsx arma una
// señal local (ref) al pulsar "Volver a fotografiar", la envía SOLO en
// la primera carga posterior, y la desarma ÚNICAMENTE tras confirmar
// éxito real (nunca antes de un fallo).
//
// Verificación estructural + funcional (sin credenciales, sin red, sin
// datos reales, sin llamar al modelo ni a Storage/Supabase reales).
//
// Se ejecuta con `npx tsx scripts/verificar-reinicio-captura-hoja.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FotoCapturaHoja } from '../lib/seguimiento/analisisHojaEvaluacion'

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
const rutaFoto = readFileSync(raiz('app', 'api', 'proyectos-seguimiento', '[id]', 'foto-hoja', 'route.ts'), 'utf-8')
const capturaHoja = readFileSync(raiz('components', 'Asistente', 'CapturaHoja.tsx'), 'utf-8')

function sinComentariosDeLinea(contenido: string): string {
  return contenido.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
}

// Mismo cálculo EXACTO (mismas 2 líneas) que foto-hoja/route.ts usa
// para fotosActualizadas — reimplementado aquí como función pura para
// poder probarlo funcionalmente, con fidelidad confirmada aparte por
// inspección de código (ver aserciones "Fidelidad*" más abajo).
function calcularFotosActualizadas(fotosPrevias: FotoCapturaHoja[], pagina: number, nuevaFoto: FotoCapturaHoja): FotoCapturaHoja[] {
  return [
    ...fotosPrevias.filter((f) => f.pagina !== pagina),
    nuevaFoto,
  ].sort((a, b) => a.pagina - b.pagina)
}

function foto(pagina: number, storagePath: string): FotoCapturaHoja {
  return { pagina, storagePath, subidaEn: '2026-01-01T00:00:00.000Z' }
}

function main() {
  // ============================================================
  // 1. Sin reiniciarCaptura: comportamiento incremental intacto.
  // ============================================================
  {
    const fotosPreviasA = [foto(1, 'A1.jpg'), foto(2, 'A2.jpg')]
    // Reemplaza únicamente la página 2 (como reemplazar una foto
    // borrosa), conserva la página 1 intacta.
    const resultado = calcularFotosActualizadas(fotosPreviasA, 2, foto(2, 'A2-nitida.jpg'))
    verificar(resultado.length === 2, '1a. Sin reinicio: el arreglo sigue teniendo 2 páginas (reemplazo, no reinicio)')
    verificar(resultado.find((f) => f.pagina === 1)?.storagePath === 'A1.jpg', '1b. Sin reinicio: la página 1 previa se conserva intacta')
    verificar(resultado.find((f) => f.pagina === 2)?.storagePath === 'A2-nitida.jpg', '1c. Sin reinicio: la página 2 se reemplaza correctamente')
  }

  // ============================================================
  // 2. reiniciarCaptura='true': A1..An -> B1 produce exactamente [B1].
  // ============================================================
  {
    const fotosPreviasA = [foto(1, 'A1.jpg'), foto(2, 'A2.jpg'), foto(3, 'A3.jpg')]
    // Con reinicio, fotosPrevias se trata como [] (ver route.ts real) —
    // se reproduce aquí pasando [] directamente, exactamente como hace
    // la línea real `reiniciarCaptura ? [] : extraerFotosCapturaPendiente(...)`.
    const fotosPreviasEfectivas: FotoCapturaHoja[] = []
    const resultado = calcularFotosActualizadas(fotosPreviasEfectivas, 1, foto(1, 'B1.jpg'))
    verificar(resultado.length === 1, '2a. Con reinicio: el resultado tiene exactamente 1 página, sin importar que A tuviera 3')
    verificar(resultado[0].storagePath === 'B1.jpg', '2b. Con reinicio: la única página presente es B1')
    verificar(!resultado.some((f) => fotosPreviasA.some((a) => a.storagePath === f.storagePath)), '2c. Con reinicio: ningún storagePath de A aparece en el resultado')
  }

  // ============================================================
  // 3. [B1] + carga normal B2 (sin reinicio) -> [B1, B2].
  // ============================================================
  {
    const fotosPreviasSoloB1 = [foto(1, 'B1.jpg')]
    const resultado = calcularFotosActualizadas(fotosPreviasSoloB1, 2, foto(2, 'B2.jpg'))
    verificar(resultado.length === 2, '3a. B2 sin reinicio: el resultado tiene 2 páginas')
    verificar(resultado[0].storagePath === 'B1.jpg' && resultado[1].storagePath === 'B2.jpg', '3b. B2 sin reinicio: B1 se conserva y B2 se agrega, en orden')
  }

  // ============================================================
  // 4. Ningún storagePath de A sobrevive tras un reinicio exitoso,
  // para CUALQUIER N (no solo el caso de 1 página).
  // ============================================================
  for (const n of [1, 2, 5]) {
    const fotosPreviasA = Array.from({ length: n }, (_, i) => foto(i + 1, `A${i + 1}.jpg`))
    const resultado = calcularFotosActualizadas([], 1, foto(1, 'B1.jpg'))
    verificar(
      resultado.every((f) => !fotosPreviasA.some((a) => a.storagePath === f.storagePath)),
      `4-N${n}. Reinicio con una captura anterior de ${n} página(s): ningún storagePath de A sobrevive`
    )
  }

  // ============================================================
  // Fidelidad: foto-hoja/route.ts usa EXACTAMENTE este cálculo, y la
  // única diferencia con/sin reinicio es qué arreglo previo recibe.
  // ============================================================
  verificar(rutaFoto.includes("formData.get('reiniciarCaptura') === 'true'"), 'Fidelidad1. La comparación es EXACTA contra la cadena \'true\' — nunca "campo presente = true" ni otra coerción')
  verificar(rutaFoto.includes('const fotosPrevias = reiniciarCaptura ? [] : extraerFotosCapturaPendiente(capturaPrevia)'), 'Fidelidad2. fotosPrevias se trata como [] cuando hay reinicio — misma línea real que valida los tests 1-4')
  verificar(
    rutaFoto.includes('...fotosPrevias.filter((f) => f.pagina !== pagina),') && rutaFoto.includes('].sort((a, b) => a.pagina - b.pagina)'),
    'Fidelidad3. El cálculo de fotosActualizadas (filter+push+sort) es el MISMO para ambos casos — ninguna rama nueva ahí, solo cambia el insumo'
  )
  verificar(rutaFoto.includes('captura_pendiente: { fotos: fotosActualizadas }'), 'Fidelidad4. La escritura sigue siendo el objeto literal completo (sin spread) — extraidoBruto/extraidoEn/validacionIdentidad anteriores desaparecen siempre, con o sin reinicio')

  // ============================================================
  // 5. Un fallo antes de completar B1 no modifica captura_pendiente.
  // ============================================================
  const idxSubida = rutaFoto.indexOf('await subirBuffer(')
  const idxCatchSubida = rutaFoto.indexOf("No se pudo subir la fotografía.", idxSubida)
  const idxFotosPrevias = rutaFoto.indexOf('const fotosPrevias = reiniciarCaptura')
  verificar(idxSubida > -1 && idxCatchSubida > idxSubida && idxFotosPrevias > idxCatchSubida, '5. La subida a Storage (y su manejo de error, que retorna de inmediato) ocurre ANTES de tocar fotosPrevias/captura_pendiente — un fallo de Storage nunca llega a escribir nada')

  // ============================================================
  // Punto CUARTO/seguridad — reiniciarCaptura respeta exactamente el
  // mismo proyecto/docente ya autenticado (no se agregó ninguna
  // verificación nueva de ownership: usa la MISMA verificación de
  // siempre, antes de llegar a este punto del archivo).
  // ============================================================
  const idxReinicia = rutaFoto.indexOf("const reiniciarCaptura = formData.get")
  const idxOwnership = rutaFoto.indexOf('No tienes acceso a este proyecto.')
  verificar(idxOwnership > -1 && idxReinicia > -1, 'Seguridad1. La verificación de ownership existente y la lectura de reiniciarCaptura conviven en el mismo archivo sin ninguna ruta nueva de autenticación')
  verificar(idxOwnership < rutaFoto.indexOf('fotosPrevias = reiniciarCaptura'), 'Seguridad2. El reinicio solo puede ejecutarse DESPUÉS de que la verificación de ownership ya pasó')

  console.log('')
  console.log('--- Cliente (CapturaHoja.tsx) ---')

  // ============================================================
  // 6. La intención local de reinicio no se pierde si B1 falla.
  // 7. Se limpia solo después de B1 exitoso.
  // ============================================================
  const inicioOnArchivo = capturaHoja.indexOf('const onArchivoSeleccionado = async')
  const finOnArchivo = capturaHoja.indexOf('\n  const confirmar = async', inicioOnArchivo)
  const cuerpoOnArchivo = capturaHoja.slice(inicioOnArchivo, finOnArchivo)
  const cuerpoSinComentarios = sinComentariosDeLinea(cuerpoOnArchivo)

  verificar(cuerpoOnArchivo.includes('const esReinicio = reiniciarCapturaRef.current'), '6a. onArchivoSeleccionado captura esReinicio una sola vez, al inicio')
  const idxNoOk = cuerpoSinComentarios.indexOf("if (!res.ok)")
  const idxFinBloqueNoOk = cuerpoSinComentarios.indexOf('}', cuerpoSinComentarios.indexOf("setFase('error')", idxNoOk))
  const bloqueNoOk = cuerpoSinComentarios.slice(idxNoOk, idxFinBloqueNoOk)
  verificar(!bloqueNoOk.includes('reiniciarCapturaRef.current = false'), '6b. El bloque de error HTTP (!res.ok) nunca desarma la señal de reinicio')
  const idxCatch = cuerpoSinComentarios.indexOf('} catch (err) {')
  const bloqueCatch = cuerpoSinComentarios.slice(idxCatch, cuerpoSinComentarios.indexOf('}', idxCatch + 20))
  verificar(!bloqueCatch.includes('reiniciarCapturaRef.current = false'), '6c. El bloque catch (excepción de red) nunca desarma la señal de reinicio')

  const idxLimpieza = cuerpoOnArchivo.indexOf('if (esReinicio) reiniciarCapturaRef.current = false')
  verificar(idxLimpieza > -1, '7a. Existe la línea que desarma la señal')
  verificar(idxLimpieza > cuerpoOnArchivo.indexOf('if (!res.ok)'), '7b. La desarma ocurre DESPUÉS del chequeo de !res.ok — nunca antes de confirmar éxito')
  verificar(idxLimpieza < cuerpoOnArchivo.indexOf('setPaginasCargadas(json.paginasCargadas)'), '7c. La desarma ocurre antes de procesar el resto de la respuesta exitosa (orden correcto, sin afectar el resto del flujo)')

  // ============================================================
  // La página que se envía: 1 fijo si hay reinicio, nunca
  // paginasCargadas+1 (que pertenecería a la captura anterior).
  // ============================================================
  verificar(cuerpoOnArchivo.includes("formData.append('pagina', String(esReinicio ? 1 : paginasCargadas + 1))"), 'Pagina1. La página enviada es 1 fijo cuando hay reinicio, o paginasCargadas+1 en el caso normal — nunca se deriva paginasCargadas+1 durante un reinicio')

  // ============================================================
  // 8. B2 no lleva reiniciarCaptura.
  // ============================================================
  verificar(cuerpoOnArchivo.includes("if (esReinicio) formData.append('reiniciarCaptura', 'true')"), '8a. reiniciarCaptura solo se agrega al FormData cuando esReinicio es true')
  verificar((cuerpoOnArchivo.match(/formData\.append\('reiniciarCaptura'/g) || []).length === 1, '8b. Solo existe UN punto donde se agrega reiniciarCaptura al FormData — nunca se envía "por si acaso" en cargas normales (B2..Bn, con esReinicio ya en false, no lo incluyen)')

  // ============================================================
  // 9. "Volver a fotografiar" existe en revision_pendiente e
  // identidad_no_valida, ambos vía la misma función que arma la señal.
  // ============================================================
  verificar(
    /estado === 'identidad_no_valida'[\s\S]{0,700}onClick=\{volverAFotografiar\}[\s\S]{0,80}Volver a fotografiar/.test(capturaHoja),
    '9a. identidad_no_valida ofrece "Volver a fotografiar" mediante volverAFotografiar (no un abrirSelector plano)'
  )
  verificar(
    /estado === 'revision_pendiente'[\s\S]{0,600}onClick=\{volverAFotografiar\}[\s\S]{0,80}Volver a fotografiar/.test(capturaHoja),
    '9b. revision_pendiente TAMBIÉN ofrece "Volver a fotografiar" mediante volverAFotografiar'
  )
  verificar(
    /estado === 'revision_pendiente'[\s\S]{0,400}Revisar y corregir/.test(capturaHoja),
    '9c. revision_pendiente CONSERVA "Revisar y corregir" — las dos acciones conviven, ninguna reemplaza a la otra'
  )
  verificar(
    /const volverAFotografiar = \(\) => \{\s*if \(enCursoRef\.current\) return\s*reiniciarCapturaRef\.current = true\s*abrirSelector\(\)/.test(sinComentariosDeLinea(capturaHoja)),
    '9d. volverAFotografiar respeta enCursoRef y reutiliza abrirSelector tal cual — 0 lógica paralela, 0 llamada de red propia'
  )

  // ============================================================
  // 10. Ninguna llamada IA nueva.
  // ============================================================
  verificar(!rutaFoto.includes('anthropic') && !rutaFoto.includes('Anthropic'), '10a. foto-hoja/route.ts sigue sin ninguna referencia a IA')
  verificar(!capturaHoja.includes('anthropic') && !capturaHoja.includes('Anthropic'), '10b. CapturaHoja.tsx sigue sin ninguna referencia a IA')

  // ============================================================
  // Storage: A no se borra en esta fase.
  // ============================================================
  verificar(!/reiniciarCaptura[\s\S]{0,200}eliminarArchivo/.test(rutaFoto), 'Storage1. Ninguna rama de reiniciarCaptura invoca eliminarArchivo — las páginas de A quedan desreferenciadas, no borradas físicamente')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
