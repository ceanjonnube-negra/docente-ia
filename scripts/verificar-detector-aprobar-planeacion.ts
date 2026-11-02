// scripts/verificar-detector-aprobar-planeacion.ts
//
// Detector determinista de la orden de aprobar/guardar la planeación
// (lib/planeacion/detectarAprobarPlaneacion.ts) y su uso en el cliente:
// con un documentoActivo, una orden inequívoca NO se envuelve como
// edición de documento (enviarComoEdicion) — se manda como mensaje
// normal para que el flujo de aprobación de /api/chat la atienda.
//
// Prueba funcional sin red, sin credenciales y sin llamar al modelo: se
// sustituyen únicamente los envíos al motor y la persistencia local.
//
// Se ejecuta con `npx tsx scripts/verificar-detector-aprobar-planeacion.ts`.

import { detectarAprobarPlaneacion } from '../lib/planeacion/detectarAprobarPlaneacion'
import { esBorradorPlaneacion } from '../lib/planeacion/extraerBorrador'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const CON_PLANEACION = { hayBorradorPlaneacion: true }
const SIN_PLANEACION = { hayBorradorPlaneacion: false }

const BORRADOR_PLANEACION = '📋 PLANEACIÓN DIDÁCTICA\n\nProyecto: Los insectos\n…\n\n📎 RESUMEN PARA GUARDAR\nNombre: Los insectos\nFecha de inicio: 2026-11-03\nFecha de fin: 2026-11-07'
const EXAMEN = '📝 EXAMEN DE CIENCIAS\n\n1. ¿Qué es un insecto?\n…'

async function main() {
  // 1. Órdenes inequívocas con borrador de planeación activo.
  const positivas = [
    'Apruébala.',
    'Apruébala y guárdala',
    'Apruébala y guárdala.',
    'Guarda esta planeación.',
    'Aprueba la planeación',
    'Aprueba y guarda la planeación.',
    'Guárdala y apruébala',
    'Sí, apruébala.',
    'Por favor, apruébala',
    'apruebala y guardala por favor!',
    '  APRUÉBALA  ',
  ]
  for (const t of positivas) verificar(detectarAprobarPlaneacion(t, CON_PLANEACION), `1. Positiva: ${JSON.stringify(t)}`)

  // 2. Negaciones, preguntas, condicionales y secuencias — nunca.
  const negativas = [
    'No la apruebes.',
    'No apruebes la planeación',
    '¿Puedes aprobarla?',
    'Puedes aprobarla?',
    '¿Qué pasa si la apruebo?',
    'Corrige la planeación antes de aprobarla.',
    'Apruébala después',
    'Primero corrige y luego apruébala',
    '¿Apruébala?',
    'Guarda este texto en Word.',
    'Guarda esta planeación en Word',
    'Guárdala en PDF',
    'Apruébala mañana',
    'Quiero aprobar la planeación',
    'Aprobada',
    'Agrega una actividad y apruébala',
    'Implementa la planeación.',
    'Guárdala',
    'Apruébala pero cambia el título',
    'Guarda los cambios',
    'Guárdala con otro nombre',
    'Aprueba la planeación con estos cambios',
    'Revisa la planeación y apruébala',
    '¿La apruebo o la corrijo?',
    'Nunca la apruebes sin revisarla',
    '',
  ]
  for (const t of negativas) verificar(!detectarAprobarPlaneacion(t, CON_PLANEACION), `2. Negativa: ${JSON.stringify(t)}`)

  // 3. Pronombre sin planeación activa (otro documento): ambiguo — no
  //    se reconoce; las explícitas sí, porque nombran la planeación.
  verificar(!detectarAprobarPlaneacion('Apruébala', SIN_PLANEACION), '3a. "Apruébala" con otro documento activo no se reconoce')
  verificar(!detectarAprobarPlaneacion('Apruébala y guárdala', SIN_PLANEACION), '3b. "Apruébala y guárdala" con otro documento activo no se reconoce')
  verificar(detectarAprobarPlaneacion('Aprueba la planeación', SIN_PLANEACION), '3c. "Aprueba la planeación" nombra la planeación explícitamente')

  // 4. esBorradorPlaneacion.
  verificar(esBorradorPlaneacion(BORRADOR_PLANEACION), '4a. Un borrador con bloque de resumen es planeación')
  verificar(!esBorradorPlaneacion(EXAMEN), '4b. Un examen no es planeación')

  // 5. Enrutamiento real del cliente (AsistenteService.enviarMensaje).
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:1'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'clave-ficticia'
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = AsistenteService as any

  const llamadas: { via: string; texto: string; esEdicion?: boolean }[] = []
  svc.persistirConversacion = () => {}
  svc.asegurarMotor = async () => {}
  svc.sincronizarHistorialTexto = () => {}
  svc.ejecutarConversionFormato = async (_tipo: string, texto: string) => { llamadas.push({ via: 'conversion', texto }) }
  svc.motorDeContenido = async () => ({
    enviarTexto: async (texto: string, _adj: unknown, _fin: unknown, esEdicion?: boolean) => {
      llamadas.push({ via: esEdicion ? 'edicion' : 'normal', texto, esEdicion })
    },
  })

  async function enviarCon(documento: string, texto: string) {
    llamadas.length = 0
    svc.mensajes = [{ id: 'doc', rol: 'asistente', texto: documento, creadoEn: 1 }]
    svc.documentoActivo = null
    svc.actualizarDocumentoActivo('doc', documento)
    svc.conversacionActivaId = 'conv-prueba'
    svc.turnoAbierto = 'doc'
    svc.editandoDocumentoId = null
    svc.documentoFinalizandoId = null
    svc.ultimoIntentoEdicion = null
    svc.generando = false
    await svc.enviarMensaje(texto)
    return llamadas[0]
  }

  let r = await enviarCon(BORRADOR_PLANEACION, 'Apruébala y guárdala')
  verificar(r?.via === 'normal' && r.texto === 'Apruébala y guárdala', '5a. Con planeación activa, "Apruébala y guárdala" se envía como mensaje normal (sin envoltorio de edición)')
  verificar(svc.editandoDocumentoId === null, '5b. No queda estado de edición')
  verificar(svc.mensajes[svc.mensajes.length - 1].texto === 'Apruébala y guárdala', '5c. La burbuja del docente se muestra')
  verificar(svc.documentoActivo?.id === 'doc', '5d. documentoActivo se conserva')

  r = await enviarCon(BORRADOR_PLANEACION, 'Guarda esta planeación.')
  verificar(r?.via === 'normal', '5e. "Guarda esta planeación." se envía como mensaje normal')

  r = await enviarCon(BORRADOR_PLANEACION, 'Agrega una actividad de cierre')
  verificar(r?.via === 'edicion' && r.texto !== 'Agrega una actividad de cierre', '5f. Una edición real sigue envolviéndose como edición')

  r = await enviarCon(BORRADOR_PLANEACION, 'Corrige la planeación antes de aprobarla.')
  verificar(r?.via === 'edicion', '5g. "Corrige… antes de aprobarla" sigue siendo edición')

  r = await enviarCon(BORRADOR_PLANEACION, 'Pásalo a Word')
  verificar(r?.via === 'conversion', '5h. La conversión a Word sigue igual')

  r = await enviarCon(EXAMEN, 'Apruébala')
  verificar(r?.via === 'edicion', '5i. Con un examen activo, "Apruébala" sigue siendo edición')

  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
    process.exit(0)
  }
}

main()
