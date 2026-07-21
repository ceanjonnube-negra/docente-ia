// lib/asistente/tipos.ts
//
// Interfaces núcleo del Asistente IA de Docente IA. Ningún módulo de la
// aplicación (Lista, Asistencias, Planeaciones, Fichas, memoria,
// herramientas) debe importar un SDK de un proveedor de IA directamente.
// Todo pasa por estas interfaces. Un proveedor (OpenAI, Claude, Gemini...)
// es una implementación intercambiable de MotorConversacional; cambiar de
// proveedor significa escribir una clase nueva que la implemente y
// cambiar qué motor se instancia — nada más en la aplicación se entera.

export type RolMensaje = 'usuario' | 'asistente' | 'herramienta'

// Archivo real generado por una de las 7 herramientas (ver
// lib/asistente/documentos.ts TipoHerramienta y lib/documentGen/
// herramientas.ts) — cuando está presente, la burbuja del mensaje
// muestra un botón de descarga real en vez de la tarjeta de borrador.
// tamanoBytes es opcional: los archivos generados antes de este campo
// (ya guardados en conversaciones existentes) siguen restaurándose sin
// él — la tarjeta universal simplemente no muestra el tamaño si falta.
export type ArchivoGeneradoInfo = { tipo: string; nombre: string; url: string; tamanoBytes?: number }

// Botón de acción sobre un mensaje del asistente (ver "Mejora del flujo
// inteligente de actualización del Calendario Escolar") — el docente
// confirma con un toque, sin tener que escribir. `estilo` decide el
// color del botón (primario = verde, la acción recomendada; secundario
// = gris, cancelar/alternativa). Genérico a propósito: cualquier flujo
// futuro que necesite "proponer → confirmar con un botón" reutiliza
// este mismo tipo en vez de inventar otro.
export type AccionMensaje = { id: string; etiqueta: string; estilo: 'primario' | 'secundario' }

// Acción de navegación que el Chat IA puede proponer o ejecutar sobre
// otro módulo de la aplicación (ver "Integración de comandos verbales
// con navegación y consulta interna") — hoy solo cubre lo que
// realmente existe como pantalla navegable: Lista (con sus pestañas
// reales, ver Pestana en app/dashboard/lista/[alumnoId]/page.tsx —
// tipado aquí como string suelto para no importar un tipo de un
// archivo "page.tsx", nunca idiomático en Next.js). Calendario e
// Historial quedan para una siguiente etapa.
export type ModuloNavegable = 'lista'
export type TipoAccionNavegacion = 'abrir_modulo' | 'abrir_registro' | 'resaltar_registro'
export type AccionNavegacion = {
  modulo: ModuloNavegable
  accion: TipoAccionNavegacion
  alumnoId?: string
  pestana?: string
  filtros?: Record<string, string>
  // true = navegar de inmediato ("Abre a Sergio en la lista"); false =
  // solo ofrecer el botón "Abrir en Lista" sin cambiar de pantalla
  // ("Muéstrame a Sergio en la lista") — ver DIFERENCIA ENTRE
  // CONSULTAR Y NAVEGAR del RFC.
  automatica: boolean
}

export type TipoAccionCalendario = 'agregar' | 'corregir' | 'eliminar'

// Una diferencia detectada entre la foto del calendario oficial y
// calendario_eventos real — ver lib/calendario/analisisCalendario.ts.
// `id` identifica la fila real a modificar/eliminar (ausente en
// 'agregar', obligatorio en 'corregir'/'eliminar' — así nunca hace
// falta re-adivinar qué fila es cuál al aplicar los cambios).
export type DiferenciaCalendario = {
  accion: TipoAccionCalendario
  id?: string
  evento: { titulo: string; fecha: string; tipo: string; color: string; descripcion: string }
  motivo: string
}

export type MensajeConversacion = {
  id: string
  rol: RolMensaje
  texto: string
  creadoEn: number
  archivo?: ArchivoGeneradoInfo
  // Adjunto (foto o documento) que el docente agregó a ESTE mensaje —
  // ver AdjuntoImagen más abajo. Se guarda junto con el mensaje para
  // que la burbuja lo siga mostrando después de restaurar la
  // conversación (ver lib/asistente/persistencia.ts), no solo mientras
  // dura la sesión.
  imagen?: AdjuntoImagen
  // Varias fotos en ESTE mismo mensaje ("Compara estas dos listas",
  // "revisa estas cuatro evidencias"...) — campo nuevo y aditivo, ver
  // "Implementar soporte completo para múltiples fotografías". Nunca
  // reemplaza a `imagen` (singular): un mensaje con una sola foto
  // sigue usando exactamente el mismo camino que ya existía (ver
  // AsistenteService.enviarMensaje) para no arriesgar ningún flujo ya
  // probado — `imagenes` solo se llena cuando el docente selecciona
  // 2 o más fotos a la vez.
  imagenes?: AdjuntoImagen[]
  // Botones de confirmación sobre este mensaje (ver AccionMensaje) y,
  // una vez que el docente toca uno, qué id eligió — con esto la
  // burbuja deja de mostrar los botones y nunca se puede confirmar dos
  // veces el mismo mensaje (ver confirmarAccionCalendario en
  // AsistenteService.ts).
  acciones?: AccionMensaje[]
  accionElegida?: string
  // Diferencias de calendario pendientes de confirmar, calculadas por
  // /api/calendario/analizar — viajan pegadas al mensaje (no a un
  // "proceso activo" en el servidor) para no interferir con el
  // mecanismo genérico de "proceso activo en curso" que ya usa la
  // generación de documentos largos.
  datosAccionCalendario?: DiferenciaCalendario[]
  // Acción de navegación pendiente de confirmar con el botón "Abrir en
  // Lista" — presente solo cuando la consulta NO fue automática (ver
  // AccionNavegacion.automatica). Igual que datosAccionCalendario,
  // viaja pegada al mensaje.
  datosAccionNavegacion?: AccionNavegacion
}

// Contexto de lo que el docente tiene abierto en este momento. Cada
// pantalla se registra aquí (ver useContextoAsistente) para que el
// asistente nunca tenga que volver a preguntar algo que ya está frente al
// usuario.
export type ContextoAplicacion = {
  pantalla: string
  alumnoId?: string
  alumnoNombre?: string
  grupoId?: string
  documentoId?: string
  datosAdicionales?: Record<string, unknown>
}

export const CONTEXTO_VACIO: ContextoAplicacion = { pantalla: 'inicio' }

// Resultado de ejecutar una herramienta — siempre texto plano (lo que el
// motor conversacional le dice al docente), nunca un objeto crudo, para
// que cualquier proveedor pueda leerlo igual.
export type ResultadoHerramienta = {
  exito: boolean
  mensaje: string
  datos?: Record<string, unknown>
}

// Esquema de parámetros en formato JSON Schema — es el formato que tanto
// OpenAI como Claude (y la mayoría de proveedores con function-calling)
// aceptan de forma nativa o casi idéntica, así que una Herramienta se
// describe una sola vez y cada motor la traduce a su propio formato.
export type EsquemaParametros = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export type Herramienta = {
  nombre: string
  descripcion: string
  parametros: EsquemaParametros
  ejecutar: (argumentos: Record<string, unknown>, contexto: ContextoAplicacion) => Promise<ResultadoHerramienta>
}

export type EstadoMotor = 'inactivo' | 'conectando' | 'activo' | 'error'

// Eventos que cualquier motor conversacional puede emitir. Un motor de
// solo texto (MotorTextoClaude, hoy) usa un subconjunto; un motor de voz
// en tiempo real (futuro MotorVozOpenAIRealtime) usa el resto también.
export type EventoMotor =
  | { tipo: 'estado'; estado: EstadoMotor }
  // Solo lo emiten motores de voz, apenas el VAD detecta que el docente
  // empezó a hablar — mucho antes de que exista texto transcrito. Sirve
  // para que AsistenteService nunca deje que una respuesta del asistente
  // se muestre antes de que la burbuja del docente exista (ver
  // 'mensaje-usuario' más abajo): la transcripción del habla del
  // docente y la respuesta del modelo son dos procesos async
  // independientes en la Realtime API, y el segundo puede terminar
  // primero.
  | { tipo: 'inicio-turno-usuario' }
  // Solo lo emite MotorOpenAIRealtime, para que el botón de voz muestre
  // un estado discreto en vez de solo parpadear sin explicar qué pasa —
  // ver deteccionFinTurno.ts. "confirmando" debe durar muy poco (unos
  // cientos de ms a 2-3s como mucho); "pensando" cubre desde que se pidió
  // la respuesta hasta que empieza a llegar el primer contenido.
  | { tipo: 'estado-escucha'; estado: 'escuchando' | 'confirmando' | 'pensando' }
  | { tipo: 'transcripcion-parcial'; texto: string }
  | { tipo: 'mensaje-usuario'; texto: string }
  | { tipo: 'respuesta-parcial'; texto: string }
  // contenidoOriginal: solo presente cuando el servidor generó el
  // archivo Y redactó el contenido en el mismo turno (CASO 3 de
  // FINALIZAR ARCHIVO, ver app/api/chat/route.ts) — el texto real que
  // nunca se muestra en pantalla, para que AsistenteService pueda
  // seguir usándolo como fuente si el docente pide otro formato
  // después ("ahora en PDF").
  | { tipo: 'respuesta-final'; texto: string; archivo?: ArchivoGeneradoInfo; contenidoOriginal?: string; acciones?: AccionMensaje[]; datosAccionCalendario?: DiferenciaCalendario[]; accionNavegacion?: AccionNavegacion }
  | { tipo: 'llamada-herramienta'; nombre: string; argumentos: Record<string, unknown> }
  | { tipo: 'error'; mensaje: string }
  // Solo lo emite MotorOpenAIRealtime, un paso a la vez, para el panel de
  // diagnóstico ?voiceDebug=1 (ver AsistentePanel). Siempre se emite —
  // barato y sin efecto en la interfaz normal, que simplemente no lo
  // renderiza si el panel no está activo. Nunca incluye tokens ni claves,
  // solo estados/códigos/mensajes de error reales.
  | { tipo: 'debug-paso'; paso: string; resultado: 'ok' | 'error' | 'info'; detalle?: string; ms: number }

export type DesuscribirFn = () => void

// Interfaz que implementa cada motor conversacional (un proveedor de IA
// conectado). El resto de la aplicación solo conoce esta interfaz.
//
// A pesar del nombre (histórico — nació solo para fotos), también
// carga documentos (PDF/Word/Excel/PowerPoint) desde el menú de
// adjuntos del Chat IA — ver RFC-CHAT-ADJUNTOS-003. `tipo` es el MIME
// real del archivo; `nombreArchivo` solo se usa para mostrarlo en la
// vista previa y el historial, nunca para decidir cómo procesarlo.
export type AdjuntoImagen = { base64: string; tipo: string; nombreArchivo?: string }

// Instrucción de finalizar el documento activo como archivo real (ver
// TipoHerramienta en lib/asistente/documentos.ts) — solo la implementa
// MotorTextoClaude (POST directo a /api/chat, sin pasar por el modelo).
// Un motor de voz simplemente ignora este parámetro si no lo declara.
export type FinalizarArchivoInfo = { tipo: string; documentoTexto: string }

export interface MotorConversacional {
  readonly id: string
  iniciar(contexto: ContextoAplicacion, herramientas: Herramienta[]): Promise<void>
  detener(): Promise<void>
  // esEdicionDocumento: true cuando `texto` no es lo que escribió el
  // maestro sino un prompt interno (ver construirPromptEdicion en
  // AsistenteService.ts) que envuelve su instrucción de edición junto
  // con el documento activo — le dice a /api/chat que NUNCA debe
  // interpretar este mensaje como una solicitud de archivo (ver
  // tipoHerramientaSolicitado en app/api/chat/route.ts), sin importar
  // qué palabras traiga el texto de la plantilla.
  // adjuntos: varias fotos en un mismo mensaje (ver
  // MensajeConversacion.imagenes) — parámetro nuevo, al final y
  // opcional, para que ningún motor existente tenga que cambiar su
  // firma salvo para ignorarlo (ver MotorOpenAIRealtime, que hace lo
  // mismo con `adjunto` desde antes).
  enviarTexto(texto: string, adjunto?: AdjuntoImagen, finalizarArchivo?: FinalizarArchivoInfo, esEdicionDocumento?: boolean, adjuntos?: AdjuntoImagen[]): Promise<void>
  // Opcional: solo los motores con entrada de audio (voz en tiempo real)
  // lo implementan. Un motor de solo texto puede omitirlo.
  enviarAudio?(fragmento: ArrayBuffer): void
  // Interrumpe una respuesta en curso (barge-in) — solo tiene efecto real
  // en motores que soportan streaming de salida; en un motor de solo
  // texto es un no-op seguro.
  interrumpir(): void
  actualizarContexto(contexto: ContextoAplicacion): void
  suscribir(callback: (evento: EventoMotor) => void): DesuscribirFn
}
