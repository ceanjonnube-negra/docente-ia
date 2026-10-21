// scripts/verificar-privacidad-embeddings.ts
//
// Privacidad del contexto RAG: el ÚNICO texto que sale hacia el proveedor
// de embeddings es una copia protegida del mensaje. Sin red ni llamadas
// facturables, con alumnos, CURP, correos y teléfonos 100% ficticios:
// 1. prepararConsultaEmbedding REAL (lib/asistente/consultaEmbedding.ts):
//    cobertura de nombres del roster del grupo activo, CURP, contacto y
//    fechas personales; omisiones fail-closed; sin falsos positivos en
//    texto académico.
// 2. El getter y el consumidor REALES de app/api/chat/route.ts más la
//    buscarContextoRAG REAL con OpenAI y la RPC simuladas: input EXACTO
//    enviado a embeddings, 0 llamadas cuando se omite, una sola llamada
//    cuando se envía, logs sin datos personales y mensaje original intacto.
//
// Ejecutar: npx tsx --tsconfig ./tsconfig.json scripts/verificar-privacidad-embeddings.ts
// Opcional: VERIFICAR_RAIZ (raíz alternativa a verificar, p. ej. un índice exportado).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    fallos++
    console.error(`✗ ${mensaje}`)
  }
}

const RAIZ = process.env.VERIFICAR_RAIZ || join(__dirname, '..')

// Roster ficticio del GRUPO ACTIVO (incluye hermanos con apellidos
// compartidos y un nombre que también es palabra común).
const GRUPO_A = [
  { alumno_id: 'a1', nombre_completo: 'Ficticia Ejemplo Ana Sofía' },
  { alumno_id: 'a2', nombre_completo: 'Prueba Inventado Luis Ángel' },
  { alumno_id: 'a3', nombre_completo: 'Muestra Simulada Rosa María' },
  { alumno_id: 'a4', nombre_completo: 'Gemelo Ficticio Carlos' },
  { alumno_id: 'a5', nombre_completo: 'Gemelo Ficticio Daniela' },
]
// Alumno de OTRO grupo (nunca se usa como roster activo).
const OTRO_GRUPO = 'Ajeno Externo Valentina'
const CURP_VALIDA = 'FIEA150312MDFCJNA9'

async function main() {
  const { prepararConsultaEmbedding } = await import(join(RAIZ, 'lib/asistente/consultaEmbedding.ts'))
  const { esMensajePuramenteSocial } = await import(join(RAIZ, 'lib/asistente/mensajeSocial.ts'))
  type Res = { enviar: boolean; texto?: string; motivo?: string; resumen: { nombres: number; curp: number; contacto: number; fechas: number } }
  const p = (texto: string, roster: unknown = GRUPO_A) => prepararConsultaEmbedding(texto, roster) as Res
  const enviaSin = (r: Res, ...prohibidos: string[]) => r.enviar && !!r.texto && prohibidos.every((x) => !r.texto!.toLowerCase().includes(x.toLowerCase()))

  console.log('\n— 1. prepararConsultaEmbedding (código real) —')
  const academico = '¿Qué dice el reglamento sobre el uso de uniforme en el ciclo 2024-2025 y el Acuerdo 12/05/23?'
  const rAcad = p(academico)
  verificar(rAcad.enviar && rAcad.texto === academico && Object.values(rAcad.resumen).every((n) => n === 0), 'texto académico sin datos personales → se envía EXACTAMENTE igual (sin falsos positivos, fechas curriculares conservadas)')
  const rCompleto = p('Estrategias de lectura para Ficticia Ejemplo Ana Sofía de tercer grado')
  verificar(rCompleto.texto === 'Estrategias de lectura para un alumno de tercer grado' && rCompleto.resumen.nombres === 1, 'nombre completo → "un alumno", intención pedagógica intacta')
  const rVariantes = p('¿cómo apoyo a FICTICIA   ejemplo ANA SOFIA en matemáticas?')
  verificar(enviaSin(rVariantes, 'ficticia', 'ejemplo', 'ana', 'sofia') && rVariantes.texto!.includes('un alumno') && rVariantes.texto!.includes('matemáticas'), 'variaciones de mayúsculas, acentos y espacios → protegido')
  const rFragmento = p('Ana Sofía y Luis Ángel no entregaron la tarea de Saberes')
  verificar(rFragmento.texto === 'un alumno y un alumno no entregaron la tarea de Saberes' && rFragmento.resumen.nombres === 2, 'fragmentos específicos (dos nombres) de dos alumnos distintos → ambos protegidos')
  const rApellidos = p('Prueba Inventado trae dificultades en lectura')
  verificar(rApellidos.texto === 'un alumno trae dificultades en lectura', 'fragmento de apellidos que solo pertenece a un alumno → protegido')
  const rAmbiguo = p('Los Gemelo Ficticio faltaron toda la semana')
  verificar(rAmbiguo.texto === 'Los un alumno faltaron toda la semana' && enviaSin(rAmbiguo, 'Gemelo', 'Ficticio'), 'fragmento ambiguo para IDENTIFICAR (apellidos de hermanos) → se elimina igual por completo y RAG se conserva')
  const rAmbiguoConPila = p('Gemelo Ficticio Carlos y su hermana Daniela')
  verificar(!rAmbiguoConPila.enviar, '…pero si además queda un nombre de pila del roster, NO se envía')
  const rPila = p('¿Cómo va Ana en matemáticas?')
  verificar(!rPila.enviar && rPila.motivo === 'privacidad', 'nombre de pila aislado del roster → no se sustituye y NO se envía (fail-closed)')
  const rApellidoSuelto = p('Necesito una estrategia para Simulada')
  verificar(!rApellidoSuelto.enviar, 'apellido suelto del roster → NO se envía')
  const rComunMinus = p('Actividad sobre la rosa de los vientos')
  const rComunMayus = p('Rosa necesita apoyo con la lectura')
  verificar(rComunMinus.enviar && rComunMinus.texto === 'Actividad sobre la rosa de los vientos' && !rComunMayus.enviar, 'nombre que también es palabra común: en minúsculas se conserva; con mayúscula (posible nombre) NO se envía')
  const rFragmentoComun = p('Rosa María y Muestra Simulada')
  verificar(rFragmentoComun.texto === 'un alumno y un alumno', 'fragmento con palabra común + nombre identificador → protegido')
  const rVarios = p('Ficticia Ejemplo Ana Sofía, Prueba Inventado Luis Ángel y Muestra Simulada Rosa María presentarán el proyecto')
  verificar(rVarios.texto === 'un alumno, un alumno y un alumno presentarán el proyecto' && rVarios.resumen.nombres === 3, 'varios alumnos en una consulta → todos protegidos')
  const rOtroGrupo = p(`La alumna ${OTRO_GRUPO} no trae material`)
  verificar(!rOtroGrupo.enviar && rOtroGrupo.motivo === 'privacidad', 'alumna de OTRO grupo (no está en el roster activo) en consulta individual → NO se envía; nunca se consulta otro grupo')
  // Detector de consultas individuales: falsos positivos y negativos.
  const generales = [
    '¿Cómo apoyar a un alumno con TDAH según la SEP?',
    '¿Qué dice la Ley General de Educación sobre el estudiante con discapacidad?',
    'Proyecto sobre la Ciudad de México para mis alumnos',
    'Estrategias para niños con rezago en Lenguajes durante el Consejo Técnico de enero',
    '¿Cómo evalúo a los estudiantes con una rúbrica?',
  ]
  verificar(generales.every((t) => p(t).enviar && p(t).texto === t), 'preguntas pedagógicas generales con alumno/estudiante/niños y nombres institucionales → se envían iguales (RAG conservado)')
  const fueraRoster = ['Los alumnos Fulano Inventado y Mengana Simulada no entregaron', '¿Cómo va Fulano Inventado en lectura?', 'El niño Perengano no trae material', 'Mis alumnas llamadas Zutana y Mengana']
  verificar(fueraRoster.every((t) => !p(t).enviar), 'nombres fuera del roster: varios alumnos (plural), nombre y apellido sin indicio, o nombre tras alumno(s)/niño(s) → NO se envía')
  verificar(!p('Mi alumna Fulana Inventada no avanza', []).enviar && !p('Vive en Calle Inventada 123', []).enviar, 'sin grupo activo: los mismos indicios aplican (también un domicilio con nombre propio de dos palabras)')
  const limiteUnaPalabra = p('¿Cómo va Valentina en lectura?')
  verificar(limiteUnaPalabra.enviar && limiteUnaPalabra.texto === '¿Cómo va Valentina en lectura?', 'LIMITACIÓN documentada: un solo nombre fuera del roster, sin indicio, se envía (no se distingue con certeza de otras palabras)')
  const rCurp = p(`La CURP ${CURP_VALIDA} tiene un error`)
  verificar(rCurp.texto === 'La CURP una CURP tiene un error' && rCurp.resumen.curp === 1, 'CURP válida → "una CURP"')
  const rCurpMala = p('Revisa la CURP FIEA151399MZZCJNA9 por favor')
  verificar(enviaSin(rCurpMala, 'FIEA151399') && rCurpMala.resumen.curp === 1, 'CURP con errores de validación (mes 13, entidad inexistente) pero estructura característica → protegida igual')
  const separadas = ['Su CURP es FIEA-150312-MDFCJN-A9', 'Su CURP es FIEA 150312 MDFCJN A9', 'Su CURP es FIEA150312 MDFCJNA9', 'Su CURP es FIEA-151399-MZZCJN-A9', 'Su CURP es FIEA 159931 HQQBBB 07', 'Su CURP es fiea-150312-mdfcjn-a9'].map((t) => p(t))
  verificar(separadas.every((r) => r.texto === 'Su CURP es una CURP' && r.resumen.curp === 1), 'CURP con guiones o espacios — válida, con fecha/entidad/consonantes inválidas o en minúsculas → protegida por su ESTRUCTURA (no depende de la validación oficial)')
  const codigos = ['El código ABCD-123456-ZZZZZZ-99 del inventario', 'Folio ESC-202401-001 del archivo', 'CCT 15EPR0123X y clave 15-EPR-0123', 'Lote ABCD 123456 789']
  verificar(codigos.every((t) => p(t).texto === t), 'códigos escolares con guiones o espacios sin la estructura de CURP (sin H/M/X en la posición 11) → sin cambios')
  const noCurp = 'El CCT 15EPR0123X, la NEM2022 y el folio AB12CD34 son códigos escolares'
  verificar(p(noCurp).texto === noCurp, 'códigos escolares parecidos (CCT, siglas con números, folios cortos) → sin cambios')
  const rContacto = p('Escríbele a ana.ficticia@correo.prueba o llama al 55 1234 5678 o al +52 (55) 8765-4321')
  verificar(rContacto.texto === 'Escríbele a un correo o llama al un teléfono o al un teléfono' && rContacto.resumen.contacto === 3, 'correo y teléfonos de 10 dígitos (con o sin +52) → protegidos')
  const rNoTelefono = p('El ciclo 2024-2025 tiene 190 días, el acuerdo 592 se publicó en 2011 y el folio 12 345 6789 es del archivo')
  verificar(rNoTelefono.texto === 'El ciclo 2024-2025 tiene 190 días, el acuerdo 592 se publicó en 2011 y el folio 12 345 6789 es del archivo' && rNoTelefono.resumen.contacto === 0, 'años, ciclos, números de acuerdo y un folio de 9 dígitos con forma de teléfono → no se confunden con teléfonos (solo 10 dígitos, o 12 con 52)')
  const rFechas = p('Nació el 12/03/2015 y su cumpleaños es el 4 de mayo; la junta es el 05/09/2025')
  verificar(rFechas.texto === 'Nació el una fecha y su cumpleaños es el una fecha; la junta es el 05/09/2025' && rFechas.resumen.fechas === 2, 'fechas personales (nacimiento, cumpleaños) → protegidas; fechas escolares → conservadas')
  const rSinGrupo = p(`Estrategias de lectura, CURP ${CURP_VALIDA}, correo ana.ficticia@correo.prueba`, [])
  verificar(rSinGrupo.texto === 'Estrategias de lectura, CURP una CURP, correo un correo', 'sin grupo activo (roster vacío): se aplican las protecciones estructurales y RAG sigue')
  const rSinGrupoNombre = p(`Estrategias para ${GRUPO_A[0].nombre_completo}`, [])
  verificar(!rSinGrupoNombre.enviar && rSinGrupoNombre.motivo === 'privacidad', 'sin grupo activo: un nombre de 2+ palabras con mayúscula (sin roster para sustituirlo) → NO se envía')
  const rSinGrupoIndividual = p('Mi alumna Fulana Inventada no avanza en lectura', null)
  verificar(!rSinGrupoIndividual.enviar && rSinGrupoIndividual.motivo === 'privacidad', 'sin grupo activo + consulta individual con nombre propio → NO se envía')
  const rSinGrupoAcad = p('¿Qué propone el Programa Analítico para Lenguajes en primaria?', [])
  verificar(rSinGrupoAcad.enviar && rSinGrupoAcad.texto === '¿Qué propone el Programa Analítico para Lenguajes en primaria?', 'sin grupo activo + consulta académica con mayúsculas curriculares → se envía igual')
  const hostil = [{ alumno_id: 'x', get nombre_completo(): string { throw new Error('fallo ficticio') } }]
  const rError = p('Estrategias para el grupo', hostil)
  verificar(!rError.enviar && rError.motivo === 'error', 'fallo de sanitización → { enviar: false, motivo: error }, nunca el texto original')
  const rosterCopia = JSON.stringify(GRUPO_A)
  const original = 'Estrategias para Ficticia Ejemplo Ana Sofía'
  const copiaOriginal = original
  p(original)
  verificar(JSON.stringify(GRUPO_A) === rosterCopia && original === copiaOriginal, 'la función es pura: no modifica el roster ni el mensaje')

  // ===== 2. Getter + consumidor + buscarContextoRAG REALES =====
  console.log('\n— 2. Recorrido real en app/api/chat/route.ts (OpenAI y RPC simulados) —')
  const fuente = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf8')
  const ts = (await import('typescript')).default
  const pDecl = fuente.indexOf('  let consultaRAGPreparada: ConsultaEmbedding | null = null')
  const pGetter = fuente.indexOf('  const obtenerContextoRAGPromise = (): Promise<string> => {')
  const finGetter = fuente.indexOf('\n  }\n', pGetter) + 4
  const pConsumo = fuente.indexOf('obtenerContextoRAGPromise(), TIMEOUT_RAG_MS')
  const iniConsumo = fuente.lastIndexOf('  const consultaRAGTurno = esTurnoFichaDescriptiva', pConsumo)
  const finConsumo = fuente.indexOf('\n', fuente.indexOf(".catch(() => '')", pConsumo))
  const iniFn = fuente.indexOf('async function buscarContextoRAG(')
  let kFn = fuente.indexOf('{', fuente.indexOf(')', fuente.indexOf('institucionId: string | null)', iniFn))), dFn = 0
  for (; kFn < fuente.length; kFn++) { if (fuente[kFn] === '{') dFn++; else if (fuente[kFn] === '}') { dFn--; if (dFn === 0) break } }
  verificar(pDecl > 0 && pGetter > pDecl && iniConsumo > finGetter && iniFn > 0, 'tramos reales localizados (consulta protegida, getter, consumidor, buscarContextoRAG)')
  const codigo = `${fuente.slice(iniFn, kFn + 1)}\nasync function __tramo(env: any) { const { mensaje, sesion, supabaseUser, conLimiteDeTiempo, TIMEOUT_RAG_MS, esTurnoFichaDescriptiva, console, prepararConsultaEmbedding, esMensajePuramenteSocial } = env\n${fuente.slice(pDecl, finGetter)}\n${fuente.slice(iniConsumo, finConsumo)}\n return { contextoRAG, rag } }`
  const js = ts.transpileModule(codigo, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText
  const correr = async (mensaje: string, roster: unknown, extra: Record<string, unknown> = {}) => {
    const embeddings: { model: string; input: string }[] = []
    const rpcs: unknown[] = []
    const logs: string[] = []
    const openaiRAG = { embeddings: { create: async (args: { model: string; input: string }) => { embeddings.push(args); return { data: [{ embedding: [0.1, 0.2] }] } } } }
    const supabaseUser = { rpc: async (nombre: string, args: unknown) => { rpcs.push([nombre, args]); return { data: [{ categoria: 'Reglamentos', nombre_archivo: 'reglamento-ficticio.pdf', chunk_texto: 'Texto ficticio del reglamento.' }], error: null } } }
    const tramo = new Function('openaiRAG', 'TIMEOUT_RAG_MS', `${js}; return __tramo`)(openaiRAG, 50) as (env: Record<string, unknown>) => Promise<{ contextoRAG: string; rag: string }>
    const conLimiteDeTiempo = <T,>(promesa: Promise<T>) => promesa
    const env = { mensaje, sesion: { institucion_id: 'inst-ficticia', alumnos_del_grupo_activo: roster }, supabaseUser, conLimiteDeTiempo, TIMEOUT_RAG_MS: 50, esTurnoFichaDescriptiva: false, console: { log: (m: string) => logs.push(m), error: (m: string) => logs.push(String(m)) }, prepararConsultaEmbedding, esMensajePuramenteSocial, ...extra }
    const r = await tramo(env)
    return { ...r, embeddings, rpcs, logs, env }
  }
  const mensajeNombre = 'Estrategias para Ficticia Ejemplo Ana Sofía y su CURP FIEA150312MDFCJNA9'
  const conNombre = await correr(mensajeNombre, GRUPO_A)
  verificar(conNombre.embeddings.length === 1 && conNombre.embeddings[0].input === 'Estrategias para un alumno y su CURP una CURP' && conNombre.embeddings[0].model === 'text-embedding-3-small', `input EXACTO enviado a embeddings: «${conNombre.embeddings[0]?.input}»`)
  verificar(conNombre.rpcs.length === 1 && conNombre.contextoRAG.includes('Texto ficticio del reglamento.') && conNombre.rag === 'ejecutado', 'una sola llamada a embeddings y una RPC; el contexto recuperado llega igual que siempre')
  verificar(conNombre.env.mensaje === mensajeNombre, 'el mensaje original (el que sigue a Sonnet y al historial) queda intacto')
  const omitido = await correr('¿Cómo va Ana en matemáticas?', GRUPO_A)
  verificar(omitido.embeddings.length === 0 && omitido.rpcs.length === 0 && omitido.contextoRAG === '' && omitido.rag === 'omitido_privacidad', 'identidad no protegible → 0 llamadas a embeddings, RAG vacío y el turno continúa')
  const conError = await correr('Estrategias para el grupo', [{ alumno_id: 'x', get nombre_completo(): string { throw new Error('fallo ficticio') } }])
  verificar(conError.embeddings.length === 0 && conError.contextoRAG === '' && conError.rag === 'omitido_error', 'fallo de sanitización → 0 llamadas a embeddings (nunca el texto original)')
  const lanza = await correr('Estrategias para el grupo', GRUPO_A, { prepararConsultaEmbedding: () => { throw new Error('fallo ficticio externo') } })
  verificar(lanza.embeddings.length === 0 && lanza.contextoRAG === '' && lanza.rag === 'omitido_error', 'aunque la preparación lanzara una excepción, el turno no se rompe y no se envía nada')
  const academicoRuta = await correr(academico, GRUPO_A)
  verificar(academicoRuta.embeddings.length === 1 && academicoRuta.embeddings[0].input === academico && academicoRuta.rag === 'ejecutado', 'consulta académica → input idéntico al mensaje (precisión de recuperación intacta)')
  const sinGrupo = await correr(`Estrategias, CURP ${CURP_VALIDA}`, [])
  verificar(sinGrupo.embeddings.length === 1 && !sinGrupo.embeddings[0].input.includes(CURP_VALIDA), 'sin grupo activo → solo protecciones estructurales y RAG normal')
  const todosLogs = [conNombre, omitido, conError, lanza, academicoRuta, sinGrupo].flatMap((r) => r.logs)
  verificar(todosLogs.length >= 6 && todosLogs.every((l) => /^\[RAG_USO\] estado=(ejecutado|omitido_privacidad|omitido_error)( nombres=\d+ curp=\d+ contacto=\d+ fechas=\d+)?$/.test(l)), `logs: solo estado y conteos (${todosLogs.length} líneas) — nunca nombres, CURP ni texto`)
  verificar(todosLogs.every((l) => !/Ficticia|Ejemplo|Ana|FIEA|Estrategias|matem/i.test(l)), 'ningún log contiene nombres, CURP ni fragmentos del mensaje')

  // ===== 3. Estructura =====
  console.log('\n— 3. Estructura —')
  const fnRag = fuente.slice(iniFn, kFn + 1)
  verificar((fuente.match(/buscarContextoRAG\(supabaseUser, /g) || []).length === 1 && fuente.includes('buscarContextoRAG(supabaseUser, consulta.texto, sesion.institucion_id)') && !/buscarContextoRAG\(supabaseUser, mensaje/.test(fuente), 'buscarContextoRAG recibe SOLO la copia protegida (consulta.texto), nunca el mensaje')
  verificar(/input: pregunta,/.test(fnRag) && (fuente.match(/embeddings\.create\(/g) || []).length === 1, 'la única llamada a embeddings del Chat IA usa ese texto')
  const modulo = readFileSync(join(RAIZ, 'lib/asistente/consultaEmbedding.ts'), 'utf8')
  verificar(!/anthropic|openai|fetch\(|supabase|\.from\(|\.rpc\(|console\./i.test(modulo.replace(/^\/\/.*$/gm, '')), 'el módulo es puro: sin IA, sin red, sin Supabase y sin logs')
  verificar(/import \{ construirPatronNombreCompleto \} from '\.\.\/programaAnalitico\/sanitizarContextoIndividual'/.test(modulo) && !/validarEstructuraCurp/.test(modulo.replace(/^\/\/.*$/gm, '')), 'reutiliza el patrón de nombre completo existente; la protección de CURP no depende de la validación oficial (que dejaba pasar CURP con errores)')
  const reasignaciones = fuente.split('\n').filter((l) => /(^|[^.\w])mensaje\s*(=|\+=)(?!=)/.test(l) && !/\b(const|let|var)\s+mensaje\s*=/.test(l))
  verificar(/const \{ mensaje, historial, contexto,/.test(fuente) && reasignaciones.length === 0, `el mensaje del docente es const y nunca se reasigna en la ruta${reasignaciones.length ? ' → ' + reasignaciones.length : ''}`)

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR DEL VERIFICADOR:', e instanceof Error ? `${e.name}: ${e.message}` : 'desconocido')
  process.exit(1)
})
