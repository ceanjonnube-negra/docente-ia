// scripts/verificar-borrador-vigente-planeacion.ts
//
// Selección determinista del borrador VIGENTE de planeación dentro del
// historial de la conversación actual (seleccionarBorradorVigente en
// lib/planeacion/extraerBorrador.ts), y el atajo determinista del
// servidor que lleva una orden inequívoca de aprobar directo a la
// aprobación sin pasar por el clasificador (clasificacionAprobarPlaneacion).
//
// Sin red, sin credenciales, sin llamar al modelo.
//
// Se ejecuta con `npx tsx scripts/verificar-borrador-vigente-planeacion.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seleccionarBorradorVigente, PREFIJO_CONFIRMACION_APROBACION } from '../lib/planeacion/extraerBorrador'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

function borrador(nombre: string, fechaFin = '2026-11-07'): string {
  return `📋 PLANEACIÓN DIDÁCTICA\n\nProyecto: ${nombre}\nDía 1…\n\n📎 RESUMEN PARA GUARDAR\nNombre: ${nombre}\nFecha de inicio: 2026-11-03\nFecha de fin: ${fechaFin}\n\n¿Deseas corregir algo o aprobarla para guardarla?`
}
const A = borrador('Los insectos')
const B = borrador('Las plantas de mi escuela')
const ERROR = 'No fue posible guardar la planeación en este momento. Intenta de nuevo en unos segundos.'
const SIN_BORRADOR = 'No encontré un borrador de planeación listo para guardar en esta conversación. ¿Quieres que prepare uno?'
const u = (content: string) => ({ role: 'user', content })
const a = (content: string) => ({ role: 'assistant', content })

function nombreDe(s: ReturnType<typeof seleccionarBorradorVigente>): string | null {
  return s.estado === 'listo' ? s.resumen.nombre : null
}

// 1. Borrador seguido de error.
{
  const s = seleccionarBorradorVigente([a(A), u('Apruébala'), a(ERROR)], 'Apruébala')
  verificar(nombreDe(s) === 'Los insectos', '1a. Borrador seguido de error de guardado: se recupera')
  verificar(s.estado === 'listo' && s.contenido === A, '1b. Se devuelve el contenido completo del turno del borrador (para Word/PDF)')
  verificar(nombreDe(seleccionarBorradorVigente([a(A), u('Apruébala'), a(ERROR), u('Apruébala'), a(SIN_BORRADOR)])) === 'Los insectos', '1c. Varios errores seguidos (incluido "No encontré un borrador…"): se recupera')
}

// 2. Borrador seguido de aclaración.
verificar(nombreDe(seleccionarBorradorVigente([a(A), u('¿Cuántos días son?'), a('Son 5 días efectivos.')])) === 'Los insectos', '2. Borrador seguido de aclaración: se recupera')

// 3. Dos borradores.
{
  const historial = [a(A), u('Mejor de plantas'), a(B), u('Apruébala'), a(ERROR)]
  verificar(nombreDe(seleccionarBorradorVigente(historial, 'Apruébala')) === 'Las plantas de mi escuela', '3a. Dos borradores: se elige el vigente (el más reciente)')
  verificar(nombreDe(seleccionarBorradorVigente(historial, 'Aprueba la planeación Las plantas de mi escuela')) === 'Las plantas de mi escuela', '3b. Referencia explícita al vigente: se acepta')
  const ref = seleccionarBorradorVigente(historial, 'Aprueba la planeación de los insectos')
  verificar(ref.estado === 'referencia_no_vigente' && ref.nombreVigente === 'Las plantas de mi escuela', '3c. Referencia explícita a un borrador anterior: no se aprueba ese ni el vigente')
  verificar(nombreDe(seleccionarBorradorVigente([a(A), u('ajústala'), a(borrador('Los insectos', '2026-11-10'))])) === 'Los insectos' && (seleccionarBorradorVigente([a(A), u('ajústala'), a(borrador('Los insectos', '2026-11-10'))]) as { resumen: { fechaFin: string } }).resumen.fechaFin === '2026-11-10', '3d. Dos versiones con el mismo nombre: se usa la última versión')
}

// 4. Borrador ya aprobado.
{
  const confirmacion = `${PREFIJO_CONFIRMACION_APROBACION}Los insectos para 5 días efectivos, del 2026-11-03 al 2026-11-07. Ya aparece en Planeación…`
  verificar(seleccionarBorradorVigente([a(A), u('Apruébala'), a(confirmacion)]).estado === 'ya_aprobado', '4a. Confirmación de aprobación después del borrador: ya aprobado')
  verificar(seleccionarBorradorVigente([a(A), u('Apruébala'), a(confirmacion), u('¿Y ahora?'), a('Puedes imprimir la hoja.')]).estado === 'ya_aprobado', '4b. Aunque haya mensajes después de la confirmación')
  verificar(nombreDe(seleccionarBorradorVigente([a(A), u('Apruébala'), a(confirmacion), u('Ahora una de plantas'), a(B)])) === 'Las plantas de mi escuela', '4c. Un borrador nuevo después de la aprobación sí es vigente')
  const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
  verificar(ruta.includes('const mensajeVoz = `${PREFIJO_CONFIRMACION_APROBACION}${p.nombre}'), '4d. El servidor confirma la aprobación con el mismo prefijo que se reconoce')
}

// 5. Conversación sin borrador.
verificar(seleccionarBorradorVigente([]).estado === 'sin_borrador', '5a. Historial vacío: sin borrador')
verificar(seleccionarBorradorVigente([u('Hola'), a('Hola, ¿en qué te ayudo?')]).estado === 'sin_borrador', '5b. Conversación sin borrador')

// 6. Mensajes de otros documentos.
verificar(seleccionarBorradorVigente([a(A), u('Hazme un examen'), a('📝 EXAMEN DE CIENCIAS\n\n1. ¿Qué es un insecto?')]).estado === 'otro_documento', '6a. Otro documento después del borrador: no hay certeza')
verificar(nombreDe(seleccionarBorradorVigente([a('📝 EXAMEN DE CIENCIAS\n\n1. …'), u('Ahora la planeación'), a(A)])) === 'Los insectos', '6b. Otro documento ANTES del borrador no estorba')
verificar(seleccionarBorradorVigente([a('📝 EXAMEN DE CIENCIAS\n\n1. …')]).estado === 'sin_borrador', '6c. Solo otros documentos: sin borrador')

// 7. Referencias ambiguas y borrador incompleto.
{
  const vigenteLargo = borrador('Los insectos y su hábitat')
  const historial = [a(A), u('amplíala'), a(vigenteLargo)]
  verificar(nombreDe(seleccionarBorradorVigente(historial, 'Aprueba la planeación Los insectos y su hábitat')) === 'Los insectos y su hábitat', '7a. Nombrar el vigente aunque contenga el nombre de uno anterior: se acepta')
  verificar(seleccionarBorradorVigente(historial, 'Aprueba la de los insectos').estado === 'referencia_no_vigente', '7b. Nombre que coincide con uno anterior y no con el vigente: ambiguo, no se aprueba')
  verificar(seleccionarBorradorVigente([a(A), u('ajústala'), a('📋 PLANEACIÓN\n\n📎 RESUMEN PARA GUARDAR\nNombre: Los insectos\nFecha de inicio: 2026-11-03')]).estado === 'incompleto', '7c. Vigente incompleto: no se recurre a uno anterior completo')
}

// 8. Atajo determinista del servidor.
{
  const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
  verificar(/const ordenAprobarPlaneacion = !esEdicionDocumento && detectarAprobarPlaneacion\(/.test(ruta), '8a. El servidor usa el mismo detector que el cliente (nunca para un prompt de edición)')
  verificar(ruta.includes('? clasificacionAprobarPlaneacion()') && ruta.includes(': await clasificarNivel0(mensaje, sesion, historialMensajes.slice(-4))'), '8b. Con orden detectada no se llama al clasificador; sin ella, igual que antes')
  verificar(ruta.includes("aprobarBorradorPlaneacion(supabaseUser, sesion, historialMensajes, esEdicionDocumento ? '' : String(mensaje ?? ''))"), '8c. La aprobación recibe el historial de esta conversación y el mensaje del docente')
}

async function main() {
  // El módulo crea su cliente al importarse; esta prueba nunca lo usa.
  process.env.ANTHROPIC_API_KEY ||= 'clave-ficticia'
  const { clasificacionAprobarPlaneacion } = await import('../lib/clasificadorNivel0')
  const c = clasificacionAprobarPlaneacion()
  verificar(c.intencion_principal === 'planeacion_generar' && c.accion_planeacion_generar === 'aprobar', '8d. La clasificación determinista va a la rama de aprobación')
  verificar(c.datos_faltantes.length === 0 && c.entidades_resueltas.alumno_ambiguo === false, '8e. Sin datos faltantes ni alumnos ambiguos que la desvíen')

  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
    process.exit(0)
  }
}

main()
