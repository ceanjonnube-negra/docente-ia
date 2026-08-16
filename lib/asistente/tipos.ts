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
//
// tipoDocumento/descripcion (corrección "el adjunto de planeación abre
// la hoja de evaluación"): campos opcionales y aditivos, solo los usan
// los documentos de planeación/hoja de evaluación — cuando están
// presentes, la tarjeta muestra un título legible ("📘 Planeación
// didáctica") en vez del nombre técnico del archivo. tipoDocumento
// además viaja como parámetro explícito en la URL de vista previa
// (nunca se infiere solo de a qué ruta se llegó ni del nombre del
// archivo) — cada ruta de vista previa lo valida server-side antes de
// generar nada, para que un documento nunca pueda servir el contenido
// del otro.
export type TipoDocumentoPlaneacion = 'planeacion' | 'hoja_evaluacion'
export type ArchivoGeneradoInfo = {
  tipo: string
  nombre: string
  url: string
  tamanoBytes?: number
  tipoDocumento?: TipoDocumentoPlaneacion
  descripcion?: string
  // urlVer (CORRECCIÓN AISLADA — "separar 'Ver PDF' de 'Descargar
  // PDF'"): URL alterna EXCLUSIVA para visualización en línea de un
  // PDF (Content-Disposition: inline) — solo presente cuando el
  // documento es planeación/hoja de evaluación en PDF. `url` sigue
  // siendo, sin ningún cambio, la ruta de DESCARGA forzada (la que ya
  // usaba TarjetaDescarga antes de este ajuste). Un pdf sin urlVer
  // (documento genérico de FINALIZAR ARCHIVO fuera de
  // planeación/hoja) sigue mostrando el botón único de siempre.
  urlVer?: string
  // Id real de la fila en assets_visuales (ver lib/assetsVisuales.ts)
  // — solo presente cuando tipo==='imagen' (ver "Implementar en
  // Docente IA la capacidad de generar imágenes...", Fase 0+1). El
  // cliente lo guarda en materialVisualActivo para poder "regenerar"
  // más adelante conservando el versionado.
  assetId?: string
}

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

// Corrección individual de UN campo de UN alumno desde el Chat IA —
// ver "PASO 2: corrección individual segura". Por ahora acotado a los
// 3 campos ya soportados por la trazabilidad real (ver migración
// correcciones_alumno) y por consultar_dato_alumno de solo lectura;
// ampliar esta lista requiere tocar también esos dos lugares a la vez,
// nunca solo uno.
export type CampoAlumnoCorregible = 'curp' | 'sexo' | 'fecha_nacimiento'

// Propuesta de corrección detectada — comparación 100% determinista
// (nunca decidida por el modelo) entre el valor real ya consultado en
// Supabase (valorActual) y el valor que el docente propuso en el
// mensaje o que el asistente extrajo de un turno anterior confirmado
// (ver lib/asistente/herramientasModulo.ts). `fuente` en esta fase
// SIEMPRE es 'texto' (el docente lo escribió/dijo él mismo) — otras
// fuentes (imagen, documento) se agregan en una fase posterior, no
// aquí.
export type DiferenciaAlumno = {
  alumnoId: string
  alumnoNombre: string
  campo: CampoAlumnoCorregible
  valorActual: string | null
  valorNuevo: string
  fuente: 'texto'
}

export type MensajeConversacion = {
  id: string
  rol: RolMensaje
  texto: string
  creadoEn: number
  archivo?: ArchivoGeneradoInfo
  // Varios archivos generados en ESTE mismo turno (ej. planeación +
  // hoja de evaluación en la misma respuesta) — campo nuevo y aditivo,
  // mismo criterio que `imagenes` más abajo: nunca reemplaza a
  // `archivo` (singular), que sigue siendo exactamente el mismo campo
  // que usan todos los flujos de un solo documento (Word/PDF/PPT/Excel
  // de "FINALIZAR ARCHIVO", ficha_descriptiva...) sin ningún cambio.
  // `archivos` solo se llena cuando el turno trae 2 o más adjuntos a
  // la vez — cuando trae exactamente uno, sigue viajando únicamente en
  // `archivo`, igual que siempre.
  archivos?: ArchivoGeneradoInfo[]
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
  // Corrección de dato de alumno pendiente de confirmar con los
  // botones "Corregir"/"Cancelar" — mismo criterio que
  // datosAccionCalendario/datosAccionNavegacion: viaja pegada al
  // mensaje, nunca a un "proceso activo" en el servidor.
  datosAccionAlumno?: DiferenciaAlumno
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
  // Solo lo emite MotorOpenAIRealtime — dos únicos valores reales (ver
  // "Rediseñar el modo voz como conversación continua": la máquina de
  // estados expuesta a la interfaz se simplificó a propósito, toda la
  // detección de turnos/pausas queda encapsulada dentro del motor).
  // 'escuchando': la sesión está captando audio, sin importar si el
  // docente está hablando en este instante o en una pausa natural
  // entre frases — nunca se distingue eso visualmente. 'hablando': se
  // está reproduciendo la respuesta (ver reproducirRespuestaEnVoz).
  | { tipo: 'estado-escucha'; estado: 'escuchando' | 'hablando' }
  | { tipo: 'transcripcion-parcial'; texto: string }
  | { tipo: 'mensaje-usuario'; texto: string }
  | { tipo: 'respuesta-parcial'; texto: string }
  // contenidoOriginal: solo presente cuando el servidor generó el
  // archivo Y redactó el contenido en el mismo turno (CASO 3 de
  // FINALIZAR ARCHIVO, ver app/api/chat/route.ts) — el texto real que
  // nunca se muestra en pantalla, para que AsistenteService pueda
  // seguir usándolo como fuente si el docente pide otro formato
  // después ("ahora en PDF").
  // perfilActualizado: true cuando el turno escribió en
  // perfiles_docentes (ver actualizar_perfil_docente en
  // app/api/chat/route.ts) — AsistenteService lo usa como señal para
  // recargar EstadoAsistente.perfil, la única fuente que consumen el
  // menú lateral, /dashboard/inicio y el resto de la interfaz.
  | { tipo: 'respuesta-final'; texto: string; archivo?: ArchivoGeneradoInfo; archivos?: ArchivoGeneradoInfo[]; contenidoOriginal?: string; acciones?: AccionMensaje[]; datosAccionCalendario?: DiferenciaCalendario[]; accionNavegacion?: AccionNavegacion; datosAccionAlumno?: DiferenciaAlumno; perfilActualizado?: boolean }
  | { tipo: 'llamada-herramienta'; nombre: string; argumentos: Record<string, unknown> }
  | { tipo: 'error'; mensaje: string }
  // Solo lo emite MotorOpenAIRealtime, un paso a la vez, para el panel de
  // diagnóstico ?voiceDebug=1 (ver AsistentePanel). Siempre se emite —
  // barato y sin efecto en la interfaz normal, que simplemente no lo
  // renderiza si el panel no está activo. Nunca incluye tokens ni claves,
  // solo estados/códigos/mensajes de error reales.
  | { tipo: 'debug-paso'; paso: string; resultado: 'ok' | 'error' | 'info'; detalle?: string; ms: number }
  // Panel técnico TEMPORAL (ver "Capturar el error real de arranque de
  // voz directamente desde el iPhone") — a diferencia de 'debug-paso'
  // (que solo se ve con ?voiceDebug=1), esto se muestra SIEMPRE que
  // arrancar la sesión de voz falla, sin flag ni configuración previa,
  // porque el objetivo es diagnosticar en el propio dispositivo sin
  // depender de que alguien recuerde agregar el parámetro a la URL.
  // Quitar este panel (y esta variante) en cuanto deje de hacer falta.
  | { tipo: 'diagnostico-arranque-voz'; datos: DiagnosticoArranqueVoz }
  // Panel técnico TEMPORAL (ver "diagnóstico roundtrip de comparación de
  // CURP sin depender de vercel logs") — mismo criterio exacto que
  // 'diagnostico-arranque-voz': solo se emite cuando el propio cliente
  // generó un debugRequestId (gate NEXT_PUBLIC_DIAGNOSTICO_CURP_ACTIVO,
  // ver AsistenteService.enviarMensaje) — nunca en uso normal. Quitar
  // esta variante junto con el resto del diagnóstico.
  | { tipo: 'diagnostico-curp'; datos: TrazaDiagnosticoCurp }

// Todos los campos son indicadores técnicos listos para mostrarse tal
// cual — NUNCA la CURP completa, el nombre del alumno, el roster ni el
// contenido de una imagen/documento. Ver "diagnóstico roundtrip de
// comparación de CURP" — quitar este tipo junto con el resto del
// diagnóstico temporal.
export type TrazaDiagnosticoCurp = {
  debugRequestId: string
  resultado: 'ok' | 'error'
  etapa: string
  // --- Servidor (null si resultado='error' y nunca llegó respuesta) ---
  mensajeLongitud: number | null
  intencionPrincipal: string | null
  accionCorreccionAlumno: string | null
  modoOperacionAlumno: string | null
  alumnoDetectado: boolean | null
  campo: string | null
  valorPropuestoPresente: boolean | null
  valorLongitud: number | null
  datosFaltantes: string[] | null
  herramientaEjecutada: string | null
  documentoPresente: boolean | null
  tamanoPayloadVisual: number | null
  // --- Pipeline visual, por etapa (ver diseño — varias colapsan al
  // mismo indicador dentro del alcance de archivos autorizado) ---
  imagenSeleccionada: boolean | null
  imagenPreparada: boolean | null
  imagenEnAsistente: boolean | null
  imagenEnMotor: boolean | null
  imagenEnFetch: boolean | null
  imagenRecibidaServidor: boolean | null
  imagenEntregadaVision: boolean | null
  // --- Solo si resultado='error' ---
  statusHttp: number | null
  tipoError: string | null
  // --- TIEMPOS (ver "instrumentación temporal de tiempos y consumo") —
  // duraciones relativas en ms, NUNCA timestamps sensibles. null cuando
  // esa etapa nunca se alcanzó — nunca se inventa una duración. ---
  msClienteAntesFetch: number | null
  msFetchHastaRespuesta: number | null
  msTotalCliente: number | null
  clasificacionEjecutada: boolean
  msClasificacion: number | null
  consultaDatosEjecutada: boolean
  msConsultaDatos: number | null
  msHerramienta: number | null
  msAntesNivel4: number | null
  nivel4Ejecutado: boolean
  msTotalServidor: number | null
  // --- LLAMADAS A IA / COSTO — una entrada por llamada real al
  // proveedor, nunca inventada. usageDisponible=false cuando la
  // arquitectura actual no expone tokens para esa llamada (ver
  // clasificarNivel0 — vive fuera de los archivos autorizados de esta
  // ronda, así que su duración se mide desde afuera pero sus tokens
  // quedan como no disponibles). ---
  llamadasIA: LlamadaIA[]
  numeroLlamadasIA: number
  numeroLlamadasAnthropic: number
  numeroLlamadasOpenAI: number
  // --- CANCELACIÓN — ver limitación documentada: si el cliente aborta
  // ANTES de que el servidor responda, el servidor nunca puede avisarle
  // qué pasó después — estos campos servidor-side solo llegan cuando el
  // servidor SÍ logra responder (éxito o error HTTP controlado).
  // clienteAbortado se llena del lado cliente cuando de verdad ocurre. ---
  clienteAbortado: boolean | null
  servidorRecibioRequest: boolean | null
  servidorInicioProveedor: boolean | null
  servidorTerminoProveedor: boolean | null
  respuestaServidorTerminada: boolean | null
  // --- DEPURACIÓN DE esComparacionVisualDeAlumno (ver "instrumentación
  // diagnóstica mínima para confirmar qué cláusula da false") —
  // exposición directa, sin ningún ?? ni fallback que pueda enmascarar
  // un campo null detrás de otro (a diferencia de trazaDebug.campo, que
  // sí usa "campo_alumno_corregir ?? campo_alumno_solicitado" y por eso
  // no basta para diagnosticar esto). Nunca CURP/valores reales, solo
  // nombres de campo y booleanos. null cuando el gate diagnóstico está
  // apagado o el predicado nunca se calculó (nivel_ejecucion===1 sin
  // instrumentación activa, etc.). Preview-only, retirar junto con el
  // resto del diagnóstico. ---
  esComparacionVisualAlumno: boolean | null
  campoAlumnoCorregir: string | null
  campoAlumnoCorregirPresente: boolean | null
  campoAlumnoSolicitado: string | null
  campoAlumnoSolicitadoPresente: boolean | null
  alumnoAmbiguo: boolean | null
  valorAlumnoPropuestoAusente: boolean | null
}

// Una llamada real a un proveedor de IA dentro de esta petición — nunca
// prompts ni respuestas completas, solo metadatos técnicos y métricas
// de uso ya entregadas por el proveedor (nunca una llamada extra para
// obtenerlas). Ver TrazaDiagnosticoCurp.llamadasIA.
export type LlamadaIA = {
  proveedor: 'anthropic' | 'openai' | 'otro'
  modelo: string | null
  finalidad: 'clasificacion' | 'razonamiento' | 'respuesta' | 'imagen' | 'otra'
  ms: number | null
  usageDisponible: boolean
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
}

// Todos los campos son texto simple listos para mostrarse tal cual —
// nunca tokens ni claves reales, solo etapas/estados/códigos/mensajes.
export type DiagnosticoArranqueVoz = {
  buildId: string
  etapa: string
  ultimoCheckpoint: string | null
  errorName: string
  errorMessage: string
  httpStatus: string | null
  responseBody: string | null
  connectionState: string
  iceConnectionState: string
  dataChannelState: string
}

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
  // canal: "voz" cuando el turno viene del modo voz (ver "Diagnóstico y
  // Plan de Optimización del Pipeline de Voz" — Fase 1) — MotorTextoClaude
  // lo manda como channel:"voice" a /api/chat para que Claude ajuste el
  // estilo de la respuesta SOLO ese turno, sin tocar el prompt general
  // del chat escrito. Opcional y al final: ningún motor ni llamador
  // existente tiene que cambiar, salvo para ignorarlo.
  // turnId/voiceDebug: ver "Medir con precisión el pipeline de voz antes
  // de optimizar" — se reenvían a /api/chat solo para correlacionar los
  // logs de telemetría temporal del servidor con los del cliente
  // (?voiceDebug=1). turnId nunca contiene datos del docente ni del
  // alumno, es un identificador corto generado localmente.
  // regenerarImagen (ver "Implementar en Docente IA la capacidad de
  // generar imágenes...", Fase 0+1): solo lo manda
  // AsistenteService.enviarRegeneracionImagen — le dice a /api/chat
  // que este turno es "regenerar la imagen activa con este prompt ya
  // combinado", acción mecánica que nunca pasa por Claude (mismo
  // criterio que finalizarArchivo).
  enviarTexto(texto: string, adjunto?: AdjuntoImagen, finalizarArchivo?: FinalizarArchivoInfo, esEdicionDocumento?: boolean, adjuntos?: AdjuntoImagen[], canal?: 'texto' | 'voz', turnId?: string, voiceDebug?: boolean, regenerarImagen?: { assetIdAnterior: string }): Promise<void>
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
