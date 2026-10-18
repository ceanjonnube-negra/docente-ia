// scripts/verificar-logs-sin-datos-personales.ts
//
// Privacidad de logs — Etapas A, B y C. Sin red ni llamadas facturables, con
// datos 100% ficticios. Comprueba que los logs del servidor no registran
// nombres de alumnos, correos del docente ni respuestas completas de RPC,
// conservando indicadores técnicos útiles:
// 1. Escaneo estático de todos los console.* de app/api/** y lib/**
//    (módulos de servidor) contra interpolaciones de datos personales.
// 2. Las plantillas REALES de los logs corregidos, evaluadas con datos
//    ficticios: solo indicadores (presente/ausente, candidatos=N, id).
// 3. aplicarCorreccionAlumno REAL ante una respuesta inesperada de la RPC
//    con valores ficticios: el log no contiene ningún valor.
// 8. Etapa C: clasificarNivel0 REAL ante respuestas mal formadas (Anthropic
//    simulado, sin red), errores de documentos/Storage con rutas ficticias,
//    actualizar_perfil_docente y el trabajo asíncrono de documentos
//    ejecutado con su código real.
// 9. trabajos_documento.error: solo se persisten, por coincidencia exacta,
//    los errores conocidos de /api/chat (idénticos byte a byte a sus
//    originales); cualquier otra falla se guarda como null.
// 10. Trabajo durable del Programa Analítico: su callback REAL de after()
//    nunca persiste ni registra el mensaje de una excepción inesperada.
//
// Ejecutar: npx tsx --tsconfig ./tsconfig.json scripts/verificar-logs-sin-datos-personales.ts
// Opcional: VERIFICAR_RAIZ (raíz alternativa a verificar, p. ej. un índice exportado).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

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

// Módulos que se ejecutan en el NAVEGADOR (sus console.* no llegan a los
// logs del servidor) — fuera del alcance de esta etapa.
const SOLO_CLIENTE = [/^lib\/asistente\/AsistenteService\.ts$/, /^lib\/asistente\/motores\//, /^lib\/asistente\/persistencia\.ts$/]

function archivos(dir: string): string[] {
  const salida: string[] = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) salida.push(...archivos(p))
    else if (/\.(ts|tsx)$/.test(n)) salida.push(p)
  }
  return salida
}

// Llamadas console.* completas (con sus argumentos), respetando paréntesis anidados.
function llamadasConsole(fuente: string): { linea: number; texto: string }[] {
  const res: { linea: number; texto: string }[] = []
  const re = /console\.(log|error|warn|info)\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(fuente))) {
    let d = 0, k = m.index + m[0].length - 1
    for (; k < fuente.length; k++) {
      if (fuente[k] === '(') d++
      else if (fuente[k] === ')') { d--; if (d === 0) break }
    }
    res.push({ linea: fuente.slice(0, m.index).split('\n').length, texto: fuente.slice(m.index, k + 1) })
  }
  return res
}

// Interpolaciones/argumentos prohibidos en un log de servidor.
const PROHIBIDOS: [RegExp, string][] = [
  [/alumno_nombre_detectado(?!\s*\?\s*'presente')/, 'nombre detectado de un alumno'],
  [/opciones_alumno_ambiguo(?!\.length)/, 'nombres de candidatos de una ambigüedad'],
  [/\bnombre_completo\b/, 'nombre completo de un alumno'],
  [/\bnombreReal\b/, 'nombre real de un alumno'],
  [/\.email\b/, 'correo'],
  [/\$\{[^}]*\bcurp\b[^}]*\}/i, 'CURP'],
  [/\$\{[^}]*fecha_nacimiento[^}]*\}/, 'fecha de nacimiento'],
  [/\$\{[^}]*\b(valorAnterior|valorNuevo|valorActual|valor_anterior|valor_nuevo|valor_alumno_propuesto|valorProporcionado)\b[^}]*\}/, 'valor de un dato personal'],
  // Etapa B — nombres de archivo solo a través de archivoSeguro()/formatoArchivoSeguro().
  [/\$\{(?![^}]*(archivoSeguro|formatoArchivoSeguro)\()[^}]*(\bnombre\b|\.nombre\b|\bnombreArchivo\b)[^}]*\}/, 'nombre de archivo'],
  // Etapa B — texto libre de una incidencia/ilustración: solo presencia o longitud.
  [/\$\{\s*descripcion\s*\}|descripcion\.slice\(/, 'descripción en texto libre'],
  // (resultado.error crudo se comprueba POR FLUJO en FLUJOS_ETAPA_B/C — una
  // prohibición global marcaría sitios fuera del alcance auditado.)
  // Etapa B — nunca message/details/hint de un error en el texto del log.
  [/\$\{[^}]*\b(e|err|error)\.(message|details|hint)\b[^}]*\}/, 'mensaje o detalle crudo de un error'],
]

// Etapa B — en estos flujos (importación, corrección, registro escolar,
// almacenamiento de documentos) ningún objeto de error se pasa crudo a la
// consola: solo errorSeguro(), que deja tipo, código/categoría y status.
const FLUJOS_ETAPA_B: [string, RegExp | null][] = [
  ['app/api/alumnos/aplicar-correccion/route.ts', null],
  ['app/api/importar-alumnos/route.ts', null],
  ['app/api/importar-alumnos/comparar/route.ts', null],
  ['lib/documentGen/herramientas.ts', null],
  ['lib/motorContexto.ts', /\[(CORRECCION_ALUMNO|REGISTRO_ESCOLAR)\]/],
  ['lib/asistente/herramientasModulo.ts', /(consultar|corregir)_dato_alumno|consultar_incidencias_alumno/],
  ['app/api/chat/route.ts', /\[REGISTRO_ESCOLAR\] error ejecutando|marcar_asistencia_individual|registrar_incidencia/],
  ['app/api/upload-documento/route.ts', null],
  ['app/api/asistencia-guardar/route.ts', null],
  ['lib/emparejarAlumno.ts', null],
  ['app/api/generar-ficha-descriptiva/route.ts', null],
]

// Etapa C — logs que registraban crudo un SyntaxError de JSON.parse, la
// cadena de error de Supabase de actualizar_perfil_docente, errores de
// documentos/Storage ya protegidos en herramientas.ts y el trabajo
// asíncrono de documentos. [archivo, filtro, número exacto de logs].
const FLUJOS_ETAPA_C: [string, RegExp | null, number][] = [
  ['lib/clasificadorNivel0.ts', /Clasificador de Nivel 0, usando fallback/, 1],
  ['app/api/chat/route.ts', /actualizar_perfil_docente — (Supabase rechazó|excepción)|\[CHAT:adjunto-documento\] Falló|\[IMAGEN_EXPORT\] Error regenerando|Error ejecutando herramienta de documento|\[LISTA_ALUMNOS\] Error generando el archivo|\[CONVERTIR_DOCUMENTO\] Error recuperando|Herramienta no disponible|en un solo paso/, 9],
  ['app/api/chat/trabajo-documento/route.ts', /\[TRABAJO_DOCUMENTO\] (Fallo creando|Falló el trabajo)/, 2],
  ['app/api/chat/route.ts', /\[PROGRAMA_ANALITICO_TRABAJO\] trabajoId=\$\{trabajoPaId\} requestId=\$\{requestIdPa\} fallo|\[PROGRAMA_ANALITICO\] requestId=\$\{requestIdPa\} grupoId=\$\{sesion\.grupo_activo_id\} excepción/, 2],
]

async function main() {
  // ===== 1. Escaneo estático =====
  console.log('\n— 1. Escaneo estático de logs del servidor —')
  const lista = [...archivos(join(RAIZ, 'app/api')), ...archivos(join(RAIZ, 'lib'))]
    .map((p) => ({ p, rel: relative(RAIZ, p) }))
    .filter(({ rel }) => !SOLO_CLIENTE.some((re) => re.test(rel)))
  let totalLlamadas = 0
  const hallazgos: string[] = []
  for (const { p, rel } of lista) {
    const fuente = readFileSync(p, 'utf8')
    for (const { linea, texto } of llamadasConsole(fuente)) {
      totalLlamadas++
      for (const [re, motivo] of PROHIBIDOS) if (re.test(texto)) hallazgos.push(`${rel}:${linea} (${motivo})`)
    }
  }
  verificar(totalLlamadas > 100 && hallazgos.length === 0, `ningún log de servidor interpola nombres, correos, CURP, fechas de nacimiento ni valores personales (${totalLlamadas} llamadas en ${lista.length} archivos)${hallazgos.length ? ' → ' + hallazgos.join('; ') : ''}`)

  const motor = readFileSync(join(RAIZ, 'lib/motorContexto.ts'), 'utf8')
  const fnCorreccion = motor.slice(motor.indexOf('export async function aplicarCorreccionAlumno('), motor.indexOf('\n}\n', motor.indexOf('export async function aplicarCorreccionAlumno(')))
  const logsCorreccion = llamadasConsole(fnCorreccion).map((l) => l.texto)
  verificar(logsCorreccion.length >= 2 && logsCorreccion.every((t) => !/,\s*(data|respuesta)\s*\)$/.test(t)), 'aplicarCorreccionAlumno nunca vuelca el objeto de respuesta de la RPC (data/respuesta)')

  for (const [rel, filtro] of FLUJOS_ETAPA_B) {
    const llamadas = llamadasConsole(readFileSync(join(RAIZ, rel), 'utf8')).filter((l) => !filtro || filtro.test(l.texto))
    const crudas = llamadas.filter((l) => /,\s*(e|err|error|resultado\.error)\s*\)$/.test(l.texto) || /^console\.\w+\(\s*(e|err|error)\s*\)$/.test(l.texto) || /\.(message|details|hint)\b/.test(l.texto))
    verificar(llamadas.length > 0 && crudas.length === 0, `${rel}: ${llamadas.length} log(s) del flujo sin objetos de error crudos ni message/details/hint${crudas.length ? ' → líneas ' + crudas.map((c) => c.linea).join(',') : ''}`)
  }

  for (const [rel, filtro, esperados] of FLUJOS_ETAPA_C) {
    const llamadas = llamadasConsole(readFileSync(join(RAIZ, rel), 'utf8')).filter((l) => !filtro || filtro.test(l.texto))
    const crudas = llamadas.filter((l) => /,\s*(e|err|error|resultado\.error)\s*\)$/.test(l.texto) || /\.(message|details|hint)\b/.test(l.texto) || /\$\{[^}]*\b(detalle|mensajeError)\b[^}]*\}/.test(l.texto) || !/errorSeguro\(|error=\$\{typeof resultado\.error === 'string' && resultado\.error \? 'presente' : 'ausente'\}/.test(l.texto))
    verificar(llamadas.length === esperados && crudas.length === 0, `Etapa C — ${rel}: ${llamadas.length}/${esperados} log(s) solo con errorSeguro() o error=presente|ausente${crudas.length ? ' → líneas ' + crudas.map((c) => c.linea).join(',') : ''}`)
  }
  const fuenteTrabajo = readFileSync(join(RAIZ, 'app/api/chat/trabajo-documento/route.ts'), 'utf8')
  verificar(llamadasConsole(fuenteTrabajo).every((l) => !/\bdetalle\b|mensajeError/.test(l.texto)), 'trabajo-documento: ningún log interpola el cuerpo de la respuesta interna ni el mensaje persistido')

  // ===== 2. Plantillas reales evaluadas con datos ficticios =====
  console.log('\n— 2. Plantillas reales de los logs corregidos —')
  const chat = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf8')
  const plantilla = (fuente: string, marca: string): string => {
    const i = fuente.indexOf(marca)
    const ini = fuente.lastIndexOf('`', i)
    let k = ini + 1, d = 0
    for (; k < fuente.length; k++) {
      const ch = fuente[k]
      if (ch === '\\') { k++; continue }
      if (d === 0 && ch === '`') break
      if (ch === '$' && fuente[k + 1] === '{') { d++; k++; continue }
      if (d > 0 && ch === '{') d++
      else if (d > 0 && ch === '}') d--
    }
    return fuente.slice(ini, k + 1)
  }
  const NOMBRE = 'Alumna Ficticia de Prueba'
  const CANDIDATOS = ['Candidato Ficticio Uno', 'Candidato Ficticio Dos']
  const ent = (nombre: string | null, opciones: string[] = []) => ({ alumno_id: nombre ? '00000000-0000-4000-8000-0000000000aa' : null, alumno_nombre_detectado: nombre, alumno_ambiguo: opciones.length > 0, opciones_alumno_ambiguo: opciones })
  const tplNivel0 = plantilla(chat, '[NIVEL0] intencion=')
  const evalNivel0 = (e: ReturnType<typeof ent>) => new Function('clasificacion', 'sesion', `return ${tplNivel0}`)({ intencion_principal: 'ficha_descriptiva', nivel_ejecucion: 4, entidades_resueltas: e, datos_faltantes: [], accion_planeacion_generar: null }, { ciclo_escolar_id: 'ciclo-ficticio' }) as string
  const conNombre = evalNivel0(ent(NOMBRE)), sinNombre = evalNivel0(ent(null))
  verificar(!conNombre.includes(NOMBRE) && /alumno_detectado=presente /.test(conNombre) && /alumno_detectado=ausente /.test(sinNombre), '[NIVEL0]: alumno_detectado=presente|ausente, nunca el nombre')
  verificar(/alumno_id=00000000-0000-4000-8000-0000000000aa/.test(conNombre) && /intencion=ficha_descriptiva nivel=4/.test(conNombre) && /datos_faltantes=\[\]/.test(conNombre), '[NIVEL0]: se conserva el diagnóstico técnico (intención, nivel, alumno_id, datos faltantes)')
  const tplAmbiguo = plantilla(chat, ' — alumno ambiguo: ')
  const ambiguo = new Function('clasificacion', `return ${tplAmbiguo}`)({ intencion_principal: 'consultar_dato_alumno', entidades_resueltas: ent(null, CANDIDATOS) }) as string
  verificar(CANDIDATOS.every((c) => !ambiguo.includes(c)) && /alumno ambiguo: candidatos=2$/.test(ambiguo), 'ambigüedad: solo el número de candidatos, nunca sus nombres')
  const rt = readFileSync(join(RAIZ, 'app/api/realtime-token/route.ts'), 'utf8')
  const tplVoz = plantilla(rt, '[VOZ][token-endpoint] sesión válida')
  const voz = new Function('user', 'MODELO_REALTIME', 'voz', 'VOZ_DEFECTO', 'instrucciones', `return ${tplVoz}`)({ id: '00000000-0000-4000-8000-0000000000dd', email: 'docente.ficticio@prueba.local' }, 'modelo', 'voz', 'voz', 'x') as string
  verificar(!voz.includes('docente.ficticio@prueba.local') && !voz.includes('@') && /usuario=00000000-0000-4000-8000-0000000000dd/.test(voz), 'token de voz: identificador técnico del usuario, nunca su correo')

  // ===== 3. aplicarCorreccionAlumno REAL ante una respuesta inesperada =====
  console.log('\n— 3. Respuesta inesperada de la RPC de corrección —')
  const CURP_ANT = 'XEXX010101MNEXXXA8', CURP_NUEVA = 'XAXX020202HNEXXXB5'
  let respuestaRpc: unknown = null
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/rest/v1/rpc/confirmar_correccion_alumno')) return new Response(JSON.stringify(respuestaRpc), { status: 200, headers: { 'content-type': 'application/json' } })
    throw new Error('RED BLOQUEADA EN LA PRUEBA: ' + url)
  }) as typeof fetch
  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient('http://supabase.prueba.local', 'anon-prueba')
  const motorMod = await import(join(RAIZ, 'lib/motorContexto.ts'))
  const propuesta = { v: 1, propuestaId: '00000000-0000-4000-8000-0000000000p1'.replace('p', 'a'), docenteId: '00000000-0000-4000-8000-0000000000d1', conversacionId: '00000000-0000-4000-8000-0000000000c1', alumnoId: '00000000-0000-4000-8000-0000000000a1', alumnoNombre: NOMBRE, campo: 'curp', valorAnterior: CURP_ANT, valorNuevo: CURP_NUEVA, generadoEn: new Date().toISOString() }
  const capturar = async (resp: unknown) => {
    respuestaRpc = resp
    const errores: string[] = []
    const original = console.error
    console.error = (...a: unknown[]) => { errores.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
    let r: { exito: boolean } | null = null
    try { r = await motorMod.aplicarCorreccionAlumno(sb, propuesta, 'texto') } finally { console.error = original }
    return { r, log: errores.join('\n') }
  }
  const casos: [string, unknown, string][] = [
    ['propuesta_id distinta', { resultado: 'actualizado', propuesta_id: 'otra', valor_anterior: CURP_ANT, valor_nuevo: CURP_NUEVA }, 'resultado=actualizado propuesta_coincide=false'],
    ['resultado desconocido', { resultado: 'raro', valor: CURP_ANT, nombre: NOMBRE }, 'resultado=desconocido propuesta_coincide=false'],
    ['respuesta nula', null, 'resultado=ausente propuesta_coincide=false'],
  ]
  for (const [n, resp, esperado] of casos) {
    const { r, log } = await capturar(resp)
    verificar(r?.exito === false && !log.includes(CURP_ANT) && !log.includes(CURP_NUEVA) && !log.includes(NOMBRE) && log.includes(esperado), `${n}: el log solo trae «${esperado}» (sin CURP ni nombre) y el resultado sigue siendo fallo`)
  }
  const ok = await capturar({ resultado: 'actualizado', propuesta_id: propuesta.propuestaId, valor_anterior: CURP_ANT, valor_nuevo: CURP_NUEVA })
  verificar(ok.r?.exito === true && ok.log === '', 'respuesta válida: mismo resultado de siempre y ningún log de error')

  // ===== 4. Etapa B: helpers de log seguro con datos ficticios =====
  console.log('\n— 4. archivoSeguro / errorSeguro —')
  const seg = await import(join(RAIZ, 'lib/logSeguro.ts'))
  const ARCHIVO = 'FICHA_DESCRIPTIVA_Alumna_Ficticia_de_Prueba.docx'
  verificar(seg.archivoSeguro(ARCHIVO, 12345) === 'formato=docx bytes=12345' && seg.archivoSeguro('Citatorio Alumno Ficticio.PDF') === 'formato=pdf' && seg.archivoSeguro('Alumna.raro', -1) === 'formato=otro' && seg.archivoSeguro(undefined) === 'formato=desconocido',
    'archivoSeguro: solo formato (lista cerrada) y bytes válidos; nunca el nombre del archivo')
  const pg23505 = { code: '23505', message: 'duplicate key value violates unique constraint "alumnos_nombre_docente_id_key"', details: `Key (nombre, docente_id)=(${NOMBRE}, 00000000-0000-4000-8000-0000000000d1) already exists.`, hint: `Revisa ${NOMBRE}` }
  const r23505 = seg.errorSeguro(pg23505)
  verificar(r23505 === 'tipo=objeto codigo=23505 categoria=violacion_unicidad' && !r23505.includes(NOMBRE) && !/Key \(|duplicate|alumnos_nombre/.test(r23505), 'PostgreSQL 23505 con details/hint ficticios → solo código y categoría (sin nombre, details, hint ni restricción)')
  const casosError: [string, unknown, string][] = [
    ['código desconocido', { code: 'XX999', message: `fallo con ${CURP_ANT}` }, 'tipo=objeto codigo=otro'],
    ['error de Storage', { name: 'StorageApiError', statusCode: '400', message: `The resource ${ARCHIVO} already exists` }, 'tipo=StorageApiError status=400'],
    ['error del SDK de IA', Object.assign(new Error(`prompt con ${NOMBRE}`), { name: 'BadRequestError', status: 400 }), 'tipo=BadRequestError status=400'],
    ['Error genérico', new Error(`no se encontró ${NOMBRE} ${CURP_ANT}`), 'tipo=Error'],
    ['clase desconocida', Object.assign(new Error('x'), { name: `Clase${NOMBRE}` }), 'tipo=Error'],
    ['cadena', `error con ${CURP_ANT}`, 'tipo=string'],
    ['nulo', null, 'tipo=nulo'],
    ['código PostgREST', { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: NOMBRE }, 'tipo=objeto codigo=PGRST116 categoria=sin_filas'],
  ]
  for (const [n, e, esperado] of casosError) {
    const r = seg.errorSeguro(e)
    verificar(r === esperado && !r.includes(NOMBRE) && !r.includes(CURP_ANT) && !r.includes(ARCHIVO), `errorSeguro (${n}) → «${esperado}»`)
  }
  verificar(seg.errorSeguro({ message: 'STALE_CURRENT_VALUE' }, ['STALE_CURRENT_VALUE']) === 'tipo=objeto codigo_sistema=STALE_CURRENT_VALUE' && seg.errorSeguro({ message: NOMBRE }, ['STALE_CURRENT_VALUE']) === 'tipo=objeto', 'solo los códigos de sistema de una lista cerrada explícita pueden registrarse tal cual')

  // ===== 5. Flujo real: error 23505 de la RPC de corrección =====
  console.log('\n— 5. Error 23505 de la RPC en aplicarCorreccionAlumno —')
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/rest/v1/rpc/confirmar_correccion_alumno')) return new Response(JSON.stringify(pg23505), { status: 409, headers: { 'content-type': 'application/json' } })
    throw new Error('RED BLOQUEADA EN LA PRUEBA: ' + url)
  }) as typeof fetch
  const errores: string[] = []
  const original = console.error
  console.error = (...a: unknown[]) => { errores.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
  let r409: { exito: boolean; definitivo?: boolean } | null = null
  try { r409 = await motorMod.aplicarCorreccionAlumno(sb, propuesta, 'texto') } finally { console.error = original }
  const log409 = errores.join('\n')
  verificar(r409?.exito === false && /codigo=23505 categoria=violacion_unicidad/.test(log409) && !log409.includes(NOMBRE) && !/Key \(|duplicate key/.test(log409), 'RPC con 23505 y details ficticios → el log trae código y categoría, nunca el nombre ni el detalle; el resultado sigue siendo fallo')

  // ===== 6. Etapa B ampliada: incidencias, escrituras, PostgreSQL, SyntaxError, hostiles =====
  console.log('\n— 6. Incidencias, escrituras y errores con datos ficticios —')
  const DESCRIPCION = `${NOMBRE} golpeó a un compañero ficticio durante el recreo`
  const tplInc = plantilla(chat, 'registrar_incidencia sin alumno_id')
  const inc = (d: string | null) => new Function('alumnoId', 'descripcion', 'grupoId', `return ${tplInc}`)(null, d, 'g') as string
  verificar(!inc(DESCRIPCION).includes(DESCRIPCION) && !inc(DESCRIPCION).includes(NOMBRE) && /descripcion_presente=true /.test(inc(DESCRIPCION)) && /descripcion_presente=false /.test(inc(null)), 'incidencia sin datos completos: descripcion_presente=true|false, nunca el texto')
  for (const marca of ['marcar_asistencia_individual — Supabase rechazó la escritura', 'registrar_incidencia — Supabase rechazó la escritura']) {
    const tpl = plantilla(chat, marca)
    const linea = (err: unknown) => new Function('alumnoId', 'resultado', `return ${tpl}`)('00000000-0000-4000-8000-0000000000aa', { exito: false, error: err }) as string
    verificar(!linea(`Failing row contains (${NOMBRE}, ${DESCRIPCION})`).includes(NOMBRE) && /error=presente$/.test(linea('x')) && /error=ausente$/.test(linea(undefined)), `${marca.split(' — ')[0]}: la cadena de error devuelta nunca se registra (error=presente|ausente)`)
  }
  for (const marca of ['marcar_asistencia_individual — excepción escribiendo', 'registrar_incidencia — excepción escribiendo']) {
    const tpl = plantilla(chat, marca)
    const linea = new Function('alumnoId', 'errorSeguro', 'e', `return ${tpl}`)('a1', seg.errorSeguro, { code: '23514', details: `Failing row contains (${NOMBRE}, ${DESCRIPCION})` }) as string
    verificar(/codigo=23514 categoria=violacion_check$/.test(linea) && !linea.includes(NOMBRE), `${marca.split(' — ')[0]}: excepción → código y categoría, sin la fila`)
  }
  const pgCasos: [string, Record<string, unknown>, string][] = [
    ['23514 check', { code: '23514', message: 'new row for relation "incidencias" violates check constraint "incidencias_tipo_check"', details: `Failing row contains (1, ${NOMBRE}, otro, ${DESCRIPCION}).` }, 'tipo=objeto codigo=23514 categoria=violacion_check'],
    ['23502 not null', { code: '23502', message: 'null value in column "descripcion" violates not-null constraint', details: `Failing row contains (2, ${NOMBRE}, conducta, null).` }, 'tipo=objeto codigo=23502 categoria=valor_nulo'],
    ['23505 unique', { code: '23505', message: 'duplicate key', details: `Key (nombre, docente)=(${NOMBRE}, d1) already exists.` }, 'tipo=objeto codigo=23505 categoria=violacion_unicidad'],
  ]
  for (const [n, e, esperado] of pgCasos) {
    const r = seg.errorSeguro(e)
    verificar(r === esperado && !r.includes(NOMBRE) && !r.includes('Failing row'), `PostgreSQL ${n} con fila ficticia → «${esperado}»`)
  }
  let errSintaxis: unknown = null
  try { JSON.parse(`${NOMBRE} mostró avances en lectura`) } catch (e) { errSintaxis = e }
  const rSintaxis = seg.errorSeguro(errSintaxis)
  verificar(String((errSintaxis as Error).message).includes(NOMBRE.slice(0, 5)) && rSintaxis === 'tipo=SyntaxError' && !rSintaxis.includes(NOMBRE.slice(0, 5)), 'SyntaxError de JSON.parse con fragmento personal → solo tipo=SyntaxError (el fragmento existía en message)')
  const revocable = Proxy.revocable({}, {}); revocable.revoke()
  const hostiles: unknown[] = [Object.defineProperty({}, 'code', { get() { throw new Error('boom') } }), Object.defineProperty({}, 'name', { get() { throw new Error('boom') } }), revocable.proxy, Object.create(null), { code: 23505 }, Symbol('x'), BigInt(10)]
  let sinExcepcion = true
  const salidas = hostiles.map((h) => { try { return seg.errorSeguro(h) } catch { sinExcepcion = false; return 'LANZÓ' } })
  const salidasArchivo = [revocable.proxy, Object.defineProperty({}, 'length', { get() { throw new Error('boom') } }), Symbol('x')].map((h) => { try { return seg.archivoSeguro(h, h) } catch { sinExcepcion = false; return 'LANZÓ' } })
  verificar(sinExcepcion && salidas[0] === 'tipo=no_inspeccionable' && salidas[1] === 'tipo=no_inspeccionable' && salidas[2] === 'tipo=no_inspeccionable' && salidas[4] === 'tipo=objeto codigo=otro' && salidasArchivo.every((x) => /^formato=(desconocido|no_inspeccionable)$/.test(x)), `getters hostiles, Proxy revocado y entradas inesperadas → nunca lanza, indicador constante (${salidas.join(' | ')})`)
  verificar(seg.errorSeguro({}) === 'tipo=objeto' && seg.errorSeguro(new (class ErrorPropio extends Error {})('x')) === 'tipo=Error', 'errores desconocidos → tipo genérico controlado')
  const herr = readFileSync(join(RAIZ, 'lib/documentGen/herramientas.ts'), 'utf8')
  const tplIlus = plantilla(herr, '[PIPELINE IMAGEN-DOC:generacion] Falló generando la ilustración')
  const ilus = new Function('orden', 'descripcion', 'errorSeguro', 'err', `return ${tplIlus}`)(2, `Retrato de ${NOMBRE} leyendo`, seg.errorSeguro, new Error(`fallo con ${NOMBRE}`)) as string
  verificar(!ilus.includes(NOMBRE) && /longitud_descripcion=\d+\): tipo=Error$/.test(ilus), 'ilustración fallida: solo la longitud de la descripción y el tipo de error')

  // ===== 7. Flujo real: generar-ficha-descriptiva con salida no-JSON del modelo =====
  console.log('\n— 7. /api/generar-ficha-descriptiva ante salida no-JSON —')
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.prueba.local'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-prueba'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-prueba'
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const json = (c: unknown, status = 200) => new Response(JSON.stringify(c), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('/rest/v1/rpc/contexto_alumno')) return json({ datos_personales: { nombre: NOMBRE } })
    if (url.startsWith('https://api.anthropic.com/')) return json({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: `${NOMBRE} mostró avances notables en lectura.` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
    throw new Error('RED BLOQUEADA EN LA PRUEBA: ' + url)
  }) as typeof fetch
  const rutaFicha = await import(join(RAIZ, 'app/api/generar-ficha-descriptiva/route.ts'))
  const capt: string[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { capt.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
  let resFicha: Response | null = null
  try { resFicha = await rutaFicha.POST({ json: async () => ({ alumno_id: 'a1', ciclo_escolar_id: 'c1', access_token: 't' }) } as never) } finally { console.error = orig }
  const cuerpoFicha = resFicha ? await resFicha.json() : null
  verificar(resFicha?.status === 500 && cuerpoFicha?.error === 'La IA no devolvió un formato válido. Intenta de nuevo.', 'respuesta HTTP y mensaje al docente sin cambios (500, mismo texto)')
  verificar(capt.join('\n') === 'Error en generar-ficha-descriptiva: tipo=SyntaxError' && !capt.join('').includes(NOMBRE.slice(0, 5)), 'el log del error de formato no contiene ningún fragmento de la ficha generada')


  // ===== 8. Etapa C =====
  console.log('\n— 8. Etapa C: clasificador, documentos/Storage, perfil y trabajo asíncrono —')
  // 8a. clasificarNivel0 REAL con Anthropic simulado (fetch bloqueado para cualquier otra URL).
  let respuestaModelo: () => Response = () => new Response('{}', { status: 500 })
  let llamadasAnthropic = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://api.anthropic.com/')) { llamadasAnthropic++; return respuestaModelo() }
    throw new Error('RED BLOQUEADA EN LA PRUEBA: ' + url)
  }) as typeof fetch
  const mensajeModelo = (texto: string) => () => new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: texto }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  const { clasificarNivel0 } = await import(join(RAIZ, 'lib/clasificadorNivel0.ts'))
  const sesionFicticia = { docente_id: 'd1', institucion_id: 'i1', ciclo_escolar_id: 'c1', grupo_activo_id: 'g1', grado: '3', grupo: 'A', nivel_educativo: 'primaria', fecha_actual: '2026-01-15', alumnos_del_grupo_activo: [{ alumno_id: 'a1', inscripcion_id: 'i1', nombre_completo: NOMBRE }], periodo_evaluacion_actual: null } as never
  const MENSAJE_DOCENTE = `¿Cómo va ${NOMBRE} en comprensión lectora este mes?`
  const FALLBACK_REAL = await clasificarNivel0('   ', sesionFicticia)
  const clasificarCapturando = async (respuesta: () => Response) => {
    respuestaModelo = respuesta
    const antes = llamadasAnthropic
    const capturados: string[] = []
    const origError = console.error, origLog = console.log
    console.error = (...a: unknown[]) => { capturados.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
    console.log = () => {}
    try {
      const r = await clasificarNivel0(MENSAJE_DOCENTE, sesionFicticia)
      return { r, capturados, llamadas: llamadasAnthropic - antes }
    } finally { console.error = origError; console.log = origLog }
  }
  const PROSA = `${NOMBRE} necesita apoyo en lectura; no pude generar el JSON.`
  let mensajeCrudo = ''
  try { JSON.parse(PROSA) } catch (e) { mensajeCrudo = (e as Error).message }
  const prosa = await clasificarCapturando(mensajeModelo(PROSA))
  verificar(prosa.llamadas === 1 && mensajeCrudo.includes(NOMBRE.slice(0, 6)), `clasificador: la prueba llega al modelo simulado y el SyntaxError crudo SÍ contenía el fragmento («${mensajeCrudo.slice(0, 40)}…»)`)
  verificar(prosa.capturados.length === 1 && prosa.capturados[0] === 'Error en Clasificador de Nivel 0, usando fallback: tipo=SyntaxError' && !prosa.capturados[0].includes(NOMBRE.slice(0, 6)), `clasificador ante prosa con nombre ficticio → log exacto «tipo=SyntaxError», sin fragmento (${prosa.capturados.join(' | ')})`)
  verificar(prosa.r === FALLBACK_REAL, 'clasificador ante respuesta mal formada → el MISMO objeto FALLBACK de siempre')
  const objetoRoto = await clasificarCapturando(mensajeModelo(`Claro: {"intencion_principal": "consultar_dato_alumno", "alumno": "${NOMBRE}" "x": 1}`))
  verificar(objetoRoto.r === FALLBACK_REAL && objetoRoto.capturados.length === 1 && /^Error en Clasificador de Nivel 0, usando fallback: tipo=SyntaxError$/.test(objetoRoto.capturados[0]) && !objetoRoto.capturados[0].includes(NOMBRE.slice(0, 6)), 'clasificador ante objeto JSON embebido inválido (segundo intento de parseo) → FALLBACK y solo tipo=SyntaxError')
  const api400 = await clasificarCapturando(() => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `contenido inválido cerca de «${NOMBRE}»` } }), { status: 400, headers: { 'content-type': 'application/json' } }))
  verificar(api400.r === FALLBACK_REAL && api400.capturados.length === 1 && /^Error en Clasificador de Nivel 0, usando fallback: tipo=(BadRequestError|Error) status=400$/.test(api400.capturados[0]) && !api400.capturados[0].includes(NOMBRE.slice(0, 6)), `clasificador ante error 400 del proveedor → FALLBACK; el log conserva tipo y status, sin el mensaje (${api400.capturados.join(' | ')})`)
  const valido = await clasificarCapturando(mensajeModelo(JSON.stringify({ intencion_principal: 'conversacion_general', entidades_resueltas: { alumno_id: null, alumno_nombre_detectado: null, alumno_ambiguo: false, opciones_alumno_ambiguo: [] }, nivel_confianza: 0.9, datos_faltantes: [] })))
  verificar(valido.r !== FALLBACK_REAL && valido.r.intencion_principal === 'conversacion_general' && valido.capturados.length === 0, 'clasificador con JSON válido → clasificación normal, sin logs de error (comportamiento intacto)')

  // 8b. Documentos/Storage: las 7 plantillas reales con rutas ficticias.
  const RUTA_FICTICIA = `00000000-0000-4000-8000-0000000000dd/1700000000000-Ficha_${NOMBRE.replace(/ /g, '_')}.docx`
  const erroresDoc: [string, unknown, string][] = [
    ['Error plano de almacenamiento', new Error(`Error subiendo archivo a Storage: Invalid key: ${RUTA_FICTICIA}`), 'tipo=Error'],
    ['StorageApiError', Object.assign(new Error(`Invalid key: ${RUTA_FICTICIA}`), { name: 'StorageApiError', status: 400 }), 'tipo=StorageApiError status=400'],
    ['URL firmada', new Error(`Error generando URL de descarga: Object not found ${RUTA_FICTICIA}`), 'tipo=Error'],
  ]
  const marcasDoc: [string, string | null][] = [
    ['[CHAT:adjunto-documento] Falló la extracción de texto', null],
    ['[IMAGEN_EXPORT] Error regenerando la imagen', 'IMAGEN-SUBIDA'],
    ['Error ejecutando herramienta de documento [', 'DOCX-SUBIDA'],
    ['[LISTA_ALUMNOS] Error generando el archivo', 'XLSX-URL'],
    ['[CONVERTIR_DOCUMENTO] Error recuperando/ejecutando la conversión', null],
    ['Herramienta no disponible: ${errorSeguro', null],
    ['Error generando y finalizando documento en un solo paso', 'PDF-SUBIDA'],
  ]
  for (const [marca, codigo] of marcasDoc) {
    const tpl = plantilla(chat, marca)
    const lineas = erroresDoc.map(([, err]) => new Function('codigo', 'errorSeguro', 'err', `return ${tpl}`)(codigo, seg.errorSeguro, err) as string)
    const ok = lineas.every((l, i) => l.endsWith(`: ${erroresDoc[i][2]}`) && !l.includes('Ficticia') && !l.includes('Invalid key') && !l.includes('00000000-0000-4000-8000-0000000000dd') && (!codigo || l.includes(`[${codigo}]`)))
    verificar(tpl.length > 0 && ok, `documentos — «${marca.replace(': ${errorSeguro', '')}»: sin ruta ni nombre de archivo; ${codigo ? `conserva [${codigo}] y ` : ''}tipo/status (${lineas[1]})`)
  }

  // 8c. actualizar_perfil_docente.
  const tplPerfilRechazo = plantilla(chat, 'actualizar_perfil_docente — Supabase rechazó la escritura')
  const perfil = (err: unknown) => new Function('resultado', `return ${tplPerfilRechazo}`)({ exito: false, error: err, anterior: { grado: null, grupo: null } }) as string
  const ERROR_PERFIL = `invalid input syntax for type integer: "${NOMBRE}"`
  verificar(!perfil(ERROR_PERFIL).includes(NOMBRE) && !perfil(ERROR_PERFIL).includes('invalid input') && /escritura: error=presente$/.test(perfil(ERROR_PERFIL)) && /escritura: error=ausente$/.test(perfil(undefined)), 'actualizar_perfil_docente rechazado: error=presente|ausente, nunca la cadena de Supabase')
  const tplPerfilExc = plantilla(chat, 'actualizar_perfil_docente — excepción escribiendo')
  const perfilExc = new Function('errorSeguro', 'e', `return ${tplPerfilExc}`)(seg.errorSeguro, { code: '22P02', message: ERROR_PERFIL }) as string
  verificar(/excepción escribiendo: tipo=objeto codigo=22P02 categoria=formato_invalido$/.test(perfilExc) && !perfilExc.includes(NOMBRE), 'actualizar_perfil_docente excepción → código y categoría, sin el valor')

  // 8d. trabajo-documento: el callback REAL de after(), transpilado y ejecutado con dependencias simuladas.
  const iniAfter = fuenteTrabajo.indexOf('after(async () => {')
  let kAfter = fuenteTrabajo.indexOf('{', iniAfter), dAfter = 0
  for (; kAfter < fuenteTrabajo.length; kAfter++) { if (fuenteTrabajo[kAfter] === '{') dAfter++; else if (fuenteTrabajo[kAfter] === '}') { dAfter--; if (dAfter === 0) break } }
  const cuerpoAfter = fuenteTrabajo.slice(fuenteTrabajo.indexOf('{', iniAfter) + 1, kAfter)
  // Lista cerrada + errorPersistible (nivel de módulo, código REAL).
  const iniAyudantes = fuenteTrabajo.indexOf('const ERRORES_PERSISTIBLES')
  let kAyud = fuenteTrabajo.indexOf('{', fuenteTrabajo.indexOf('function errorPersistible(')), dAyud = 0
  for (; kAyud < fuenteTrabajo.length; kAyud++) { if (fuenteTrabajo[kAyud] === '{') dAyud++; else if (fuenteTrabajo[kAyud] === '}') { dAyud--; if (dAyud === 0) break } }
  const ayudantes = iniAyudantes > 0 ? fuenteTrabajo.slice(iniAyudantes, kAyud + 1) : ''
  const tsc = (await import('typescript')).default
  const jsAfter = tsc.transpileModule(`${ayudantes}\nasync function __trabajo(env: any) { const { auth, trabajoId, baseUrl, fetch, mensaje, historial, contexto, institucionId, userIdCliente, accessToken, zonaHoraria, regenerarImagen, conversacionIdSolicitada, marcarGenerando, marcarCompletado, marcarFallido, extraerArchivosDeRespuesta, errorSeguro, console } = env\n${cuerpoAfter}\n}`, { compilerOptions: { target: tsc.ScriptTarget.ES2020, module: tsc.ModuleKind.None } }).outputText
  const trabajo = new Function(`${jsAfter}; return __trabajo`)() as (env: Record<string, unknown>) => Promise<void>
  const correrTrabajo = async (fetchSimulado: () => Promise<Response>, completar?: () => Promise<void>) => {
    const logs: string[] = []
    const fallidos: unknown[][] = []
    const completados: unknown[][] = []
    await trabajo({
      auth: { supabase: { cliente: 'ficticio' } }, trabajoId: 't-ficticio-1', baseUrl: 'http://interno.prueba.local', fetch: fetchSimulado,
      mensaje: 'm', historial: [], contexto: null, institucionId: null, userIdCliente: 'u1', accessToken: 'tok', zonaHoraria: null, regenerarImagen: false, conversacionIdSolicitada: null,
      marcarGenerando: async () => {}, marcarCompletado: async (...a: unknown[]) => { completados.push(a); if (completar) await completar() }, marcarFallido: async (...a: unknown[]) => { fallidos.push(a) },
      extraerArchivosDeRespuesta: (c: string) => ({ texto: c, archivos: [], contenidoOriginal: null }), errorSeguro: seg.errorSeguro,
      console: { error: (...a: unknown[]) => logs.push(a.map(String).join(' ')), log: () => {} },
    })
    return { logs, fallidos, completados }
  }
  const CUERPO_INTERNO = JSON.stringify({ error: `No pude leer "Ficha ${NOMBRE}.docx". Verifica que no esté dañado o protegido con contraseña.` })
  const t500 = await correrTrabajo(async () => new Response(CUERPO_INTERNO, { status: 500 }))
  verificar(t500.logs.length === 1 && t500.logs[0] === '[TRABAJO_DOCUMENTO] Falló el trabajo t-ficticio-1: estado_interno=500 tipo=Error' && !t500.logs[0].includes(NOMBRE), `trabajo-documento ante 500 interno con nombre ficticio en el cuerpo → solo trabajoId, estado_interno=500 y tipo (${t500.logs.join(' | ')})`)
  verificar(t500.fallidos.length === 1 && t500.fallidos[0][1] === 't-ficticio-1' && t500.fallidos[0][2] === null, 'trabajo-documento ante 500 con datos ficticios → marcarFallido(…, null): estado fallido, sin guardar el cuerpo')
  const tRed = await correrTrabajo(async () => { throw new TypeError('fetch failed') })
  verificar(tRed.logs.length === 1 && tRed.logs[0] === '[TRABAJO_DOCUMENTO] Falló el trabajo t-ficticio-1: tipo=TypeError' && tRed.fallidos.length === 1 && tRed.fallidos[0][2] === null, 'trabajo-documento ante falla de red → sin estado_interno, tipo=TypeError; error persistido = null')
  const tStorage = await correrTrabajo(async () => new Response('ok', { status: 200 }), async () => { throw Object.assign(new Error(`Invalid key: ${RUTA_FICTICIA}`), { name: 'StorageApiError', status: 400 }) })
  verificar(tStorage.logs.length === 1 && tStorage.logs[0] === '[TRABAJO_DOCUMENTO] Falló el trabajo t-ficticio-1: tipo=StorageApiError status=400' && !tStorage.logs[0].includes('Ficticia'), 'trabajo-documento ante error de Storage con ruta ficticia → sin ruta, con tipo y status')
  const tOk = await correrTrabajo(async () => new Response('documento listo', { status: 200 }))
  verificar(tOk.logs.length === 0 && tOk.fallidos.length === 0 && tOk.completados.length === 1, 'trabajo-documento exitoso → marcarCompletado una vez, sin logs de error (flujo intacto)')
  const tplCrear = plantilla(fuenteTrabajo, '[TRABAJO_DOCUMENTO] Fallo creando el trabajo')
  const crear = new Function('errorSeguro', 'e', `return ${tplCrear}`)(seg.errorSeguro, new Error(`Error creando el trabajo de documento: duplicate key ${NOMBRE}`)) as string
  verificar(crear === '[TRABAJO_DOCUMENTO] Fallo creando el trabajo: tipo=Error', 'trabajo-documento al crear el trabajo → solo tipo de error')

  // ===== 9. trabajos_documento.error: lista cerrada exacta =====
  console.log('\n— 9. trabajos_documento.error: solo errores conocidos, exactos —')
  const herrDoc = readFileSync(join(RAIZ, 'lib/documentGen/herramientas.ts'), 'utf8')
  const servicio = readFileSync(join(RAIZ, 'lib/asistente/AsistenteService.ts'), 'utf8')
  const literal = (re: RegExp, fuente: string) => fuente.match(re)?.[1] ?? null
  const originalDocumento = literal(/^const MENSAJE_ERROR_DOCUMENTO = '([^']+)'$/m, chat)
  const originalGenerico = literal(/^const MENSAJE_ERROR_GENERICO = '([^']+)'$/m, chat)
  const originalImagen = literal(/return NextResponse\.json\(\{ error: '(No fue posible generar la imagen[^']*)' \}, \{ status: 502 \}\)/, chat)
  const plantillaNoDisponible = literal(/throw new HerramientaNoDisponibleError\(`([^`]+)`\)/, herrDoc)
  const tiposNoDisponibles = herrDoc.match(/if \(tipo === '(\w+)' \|\| tipo === '(\w+)'\) \{\n\s+console\.error\(`\[PIPELINE \$\{ETIQUETA_MODULO\[tipo\]\}:deteccion\] Herramienta solicitada pero no implementada/)?.slice(1, 3) ?? []
  const originales = [originalDocumento, originalGenerico, originalImagen, ...tiposNoDisponibles.map((t) => plantillaNoDisponible?.replace('${tipo}', t) ?? null)]
  verificar(originales.length === 5 && originales.every((m) => typeof m === 'string' && m.length > 20) && JSON.stringify(tiposNoDisponibles) === '["audio","video"]', `originales extraídos del código real: MENSAJE_ERROR_DOCUMENTO, MENSAJE_ERROR_GENERICO, imagen y HerramientaNoDisponible (${tiposNoDisponibles.join('/')})`)
  const ayud = new Function(`${tsc.transpileModule(ayudantes, { compilerOptions: { target: tsc.ScriptTarget.ES2020, module: tsc.ModuleKind.None } }).outputText}; return { ERRORES_PERSISTIBLES, errorPersistible }`)() as { ERRORES_PERSISTIBLES: Set<string>; errorPersistible: (c: string) => string | null }
  const listaCerrada = [...ayud.ERRORES_PERSISTIBLES]
  verificar(listaCerrada.length === 5 && originales.every((m) => ayud.ERRORES_PERSISTIBLES.has(m as string)) && listaCerrada.every((m) => originales.includes(m)), 'la lista cerrada coincide EXACTAMENTE (byte a byte, 5 = 5) con los mensajes originales de /api/chat y herramientas.ts')
  // Toda respuesta de error de /api/chat es de una forma conocida (si aparece otra, se revisa antes de ampliar la lista).
  const respuestasError = [...chat.matchAll(/NextResponse\.json\(\{ error: ([^}]+?) \}, \{ status: (\d{3}) \}\)/g)].map((m) => m[1])
  const formaConocida = (x: string) => ['MENSAJE_ERROR_DOCUMENTO', 'MENSAJE_ERROR_GENERICO', `'${originalImagen}'`, 'err.message'].includes(x) || /^`No (encontré texto legible|pude leer) en? ?"\$\{nombreArchivo/.test(x) || /^`No pude leer "\$\{nombreArchivo/.test(x)
  verificar(respuestasError.length >= 8 && respuestasError.every(formaConocida), `las ${respuestasError.length} respuestas de error de /api/chat son de formas conocidas${respuestasError.filter((x) => !formaConocida(x)).length ? ' → desconocidas: ' + respuestasError.filter((x) => !formaConocida(x)).join(' | ') : ''}`)
  const errMessage = [...chat.matchAll(/return NextResponse\.json\(\{ error: err\.message \}, \{ status: 502 \}\)/g)].map((m) => { const antes = chat.slice(Math.max(0, m.index! - 1200), m.index!); return antes.slice(antes.lastIndexOf('catch (err) {')) })
  verificar(errMessage.length === 3 && errMessage.every((antes) => antes.startsWith('catch (err) {') && /^catch \(err\) \{\s+if \(err instanceof HerramientaNoDisponibleError\) \{/.test(antes)), 'err.message solo se responde para HerramientaNoDisponibleError (sus 2 textos están en la lista)')
  const cuerpoReenviado = fuenteTrabajo.slice(fuenteTrabajo.indexOf('body: JSON.stringify({'), fuenteTrabajo.indexOf('}),', fuenteTrabajo.indexOf('body: JSON.stringify({')))
  verificar(cuerpoReenviado.length > 0 && !/nombreArchivo|imagenBase64|imagenesBase64/.test(cuerpoReenviado), 'los errores con nombre de archivo (route.ts:735/745) no son alcanzables: el trabajo no reenvía nombreArchivo ni adjuntos')
  // Coincidencia exacta: los 5 originales sí; cualquier variación, no.
  verificar(originales.every((m) => ayud.errorPersistible(JSON.stringify({ error: m })) === m) && ayud.errorPersistible(JSON.stringify({ error: originalDocumento, extra: NOMBRE })) === originalDocumento, 'los 5 mensajes permitidos se persisten exactos (un campo adicional del cuerpo nunca se guarda)')
  const variaciones = originales.flatMap((m) => [`${m} `, ` ${m}`, (m as string).slice(0, -1), `${m} ${NOMBRE}`, (m as string).toUpperCase(), (m as string).normalize('NFD')].filter((v) => v !== m))
  const cuerposRaros = [JSON.stringify([originalDocumento]), JSON.stringify(originalDocumento), JSON.stringify({ error: [originalDocumento] }), JSON.stringify({ error: { texto: originalDocumento } }), JSON.stringify({ mensaje: originalDocumento }), JSON.stringify(null), originalDocumento as string, `<html>${originalDocumento}</html>`, '', `{"error":"${originalDocumento}"`]
  verificar(variaciones.every((v) => ayud.errorPersistible(JSON.stringify({ error: v })) === null) && cuerposRaros.every((c) => ayud.errorPersistible(c) === null), `${variaciones.length} variaciones parciales (espacios, recortes, añadidos, mayúsculas, NFD) y ${cuerposRaros.length} cuerpos inválidos → null`)
  // Ejecución real del callback.
  const CUERPO_VERCEL = JSON.stringify({ protection: { vercel_auth_enabled: true, password_enabled: false, vercel_auth_callback: 'https://vercel.com/sso-api?url=https%3A%2F%2Fproyecto-ficticio.vercel.app&nonce=ficticio', auto_vercel_auth_redirect: true } })
  const t401 = await correrTrabajo(async () => new Response(CUERPO_VERCEL, { status: 401, headers: { 'content-type': 'application/json' } }))
  verificar(t401.fallidos.length === 1 && t401.fallidos[0][2] === null && t401.logs[0] === '[TRABAJO_DOCUMENTO] Falló el trabajo t-ficticio-1: estado_interno=401 tipo=Error', 'HTTP 401 con JSON de infraestructura (protección de Vercel) → error=null; el log conserva estado_interno=401')
  const t504 = await correrTrabajo(async () => new Response('An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT\n\niad1::ficticio', { status: 504 }))
  verificar(t504.fallidos[0]?.[2] === null && /estado_interno=504 tipo=Error$/.test(t504.logs[0] ?? ''), 'respuesta no JSON (504 de la plataforma) → error=null')
  const permitidos = await Promise.all(originales.map((m) => correrTrabajo(async () => new Response(JSON.stringify({ error: m }), { status: 502, headers: { 'content-type': 'application/json' } }))))
  verificar(permitidos.every((r, i) => r.fallidos.length === 1 && r.fallidos[0][2] === originales[i] && r.completados.length === 0), 'cada mensaje permitido (502) → marcarFallido con el texto EXACTO; estado fallido igual que siempre')
  // Lo que verá el docente y el reintento por límite permanente (código real del cliente).
  const reLimite = new RegExp(literal(/const esLimitePermanente = \/(.+)\/i\.test\(mensajeError\)/, servicio) ?? '^$', 'i')
  const fallbackCliente = literal(/this\.manejarEventoMotor\(\{ tipo: 'error', mensaje: trabajo\.error \|\| '(No fue posible generar el documento\. Intenta de nuevo\.)' \}\)/, servicio)
  verificar(reLimite.source === 'todavía no está disponible' && fallbackCliente !== null, 'cliente: el reintento reconoce el límite permanente con /todavía no está disponible/ y ante error=null muestra su mensaje genérico de siempre')
  const visible = (e: unknown) => (e as string | null) || fallbackCliente
  verificar(permitidos.every((r, i) => (reLimite.test(visible(r.fallidos[0][2]) as string)) === (i >= 3)) && !reLimite.test(visible(null) as string) && !reLimite.test(visible(t401.fallidos[0][2]) as string), 'límite permanente: audio/video se siguen reconociendo (no se reintentan); los demás y error=null siguen siendo reintentables')

  // ===== 10. Trabajo durable del Programa Analítico =====
  console.log('\n— 10. Trabajo durable del Programa Analítico —')
  const iniPa = chat.indexOf('after(async () => {', chat.indexOf('const trabajoPaId = trabajoPa.id'))
  let kPa = chat.indexOf('{', iniPa), dPa = 0
  for (; kPa < chat.length; kPa++) { if (chat[kPa] === '{') dPa++; else if (chat[kPa] === '}') { dPa--; if (dPa === 0) break } }
  const cuerpoPa = iniPa > 0 ? chat.slice(chat.indexOf('{', iniPa) + 1, kPa) : ''
  verificar(cuerpoPa.includes('manejarTurnoProgramaAnalitico(') && cuerpoPa.includes('await marcarFallido(supabaseUser, trabajoPaId, mensajeErrorPa)'), 'callback real del trabajo durable del Programa Analítico localizado')
  const jsPa = tsc.transpileModule(`async function __trabajoPa(env: any) { const { supabaseUser, client, trabajoPaId, requestIdPa, sesionParaTrabajoPa, accionParaTrabajoPa, mensajeParaTrabajoPa, adjuntoParaTrabajoPa, assistantMessageIdParaTrabajoPa, conversacionIdParaTrabajoPa, userIdParaTrabajoPa, manejarTurnoProgramaAnalitico, marcarGenerando, marcarCompletado, marcarFallido, errorSeguro, Buffer, console } = env\n${cuerpoPa}\n}`, { compilerOptions: { target: tsc.ScriptTarget.ES2020, module: tsc.ModuleKind.None } }).outputText
  const trabajoPa = new Function(`${jsPa}; return __trabajoPa`)() as (env: Record<string, unknown>) => Promise<void>
  const correrPa = async (turno: () => Promise<{ texto: string; llamadasIa: number }>, errorUpsert: unknown = null) => {
    const logs: string[] = [], errores: string[] = [], fallidos: unknown[][] = [], completados: unknown[][] = [], upserts: unknown[] = []
    await trabajoPa({
      supabaseUser: { from: (t: string) => ({ upsert: async (fila: unknown) => { upserts.push([t, fila]); return { error: errorUpsert } } }) }, client: {}, trabajoPaId: 'pa-ficticio-1', requestIdPa: 'req-ficticio',
      sesionParaTrabajoPa: { grupo_activo_id: 'g-ficticio' }, accionParaTrabajoPa: 'gestionar', mensajeParaTrabajoPa: 'm', adjuntoParaTrabajoPa: null,
      assistantMessageIdParaTrabajoPa: { id: 'msg-ficticio', timestamp: 1700000000000 }, conversacionIdParaTrabajoPa: 'conv-ficticia', userIdParaTrabajoPa: 'u-ficticio',
      manejarTurnoProgramaAnalitico: turno, marcarGenerando: async () => {}, marcarCompletado: async (...a: unknown[]) => { completados.push(a) }, marcarFallido: async (...a: unknown[]) => { fallidos.push(a) },
      errorSeguro: seg.errorSeguro, Buffer, console: { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')), error: (...a: unknown[]) => errores.push(a.map(String).join(' ')) },
    })
    return { logs, errores, fallidos, completados, upserts }
  }
  const PREFIJO_PA = '[PROGRAMA_ANALITICO_TRABAJO] trabajoId=pa-ficticio-1 requestId=req-ficticio fallo: '
  const paProveedor = await correrPa(async () => { throw Object.assign(new Error(`529 {"type":"error","error":{"type":"overloaded_error","message":"contexto de ${NOMBRE}"}}`), { name: 'InternalServerError', status: 529 }) })
  verificar(paProveedor.fallidos.length === 1 && paProveedor.fallidos[0][1] === 'pa-ficticio-1' && paProveedor.fallidos[0][2] === null && paProveedor.completados.length === 0, 'Programa Analítico ante error de proveedor → estado fallido con error=null (nada arbitrario persistido)')
  verificar(paProveedor.errores.length === 1 && paProveedor.errores[0] === `${PREFIJO_PA}tipo=InternalServerError status=529` && !paProveedor.errores[0].includes(NOMBRE), `log del proveedor: trabajoId, requestId, tipo y status, sin el mensaje (${paProveedor.errores[0]})`)
  const paSupabase = await correrPa(async () => { throw { code: '23505', message: 'duplicate key value violates unique constraint', details: `Key (nombre)=(${NOMBRE}) already exists.`, hint: null } })
  verificar(paSupabase.fallidos[0]?.[2] === null && paSupabase.errores[0] === `${PREFIJO_PA}tipo=objeto codigo=23505 categoria=violacion_unicidad` && !paSupabase.errores.join('').includes(NOMBRE), 'Programa Analítico ante error de Supabase con fila ficticia → error=null; log con código y categoría, sin la fila')
  const paTipo = await correrPa(async () => { throw new TypeError(`Cannot read properties of undefined (reading '${NOMBRE}')`) })
  verificar(paTipo.fallidos[0]?.[2] === null && paTipo.errores[0] === `${PREFIJO_PA}tipo=TypeError`, 'Programa Analítico ante excepción de programación → error=null; log solo tipo=TypeError')
  const paOk = await correrPa(async () => ({ texto: 'Propuesta ficticia lista para revisión.', llamadasIa: 1 }))
  const textoCompletado = (paOk.completados[0]?.[2] as { mensaje?: string } | undefined)?.mensaje ?? ''
  verificar(paOk.fallidos.length === 0 && paOk.errores.length === 0 && paOk.completados.length === 1 && textoCompletado.startsWith('Propuesta ficticia lista para revisión.\n\n[[MENSAJE_ASISTENTE_PERSISTIDO:') && paOk.upserts.length === 1 && /estado=completado llamadaIa=true$/.test(paOk.logs[0] ?? ''), 'Programa Analítico exitoso → mensaje persistido (upsert + marcador) y marcarCompletado una vez, sin cambios')
  const paOkSinMarcador = await correrPa(async () => ({ texto: 'Propuesta ficticia.', llamadasIa: 0 }), { code: '42501' })
  verificar(paOkSinMarcador.completados.length === 1 && (paOkSinMarcador.completados[0][2] as { mensaje: string }).mensaje === 'Propuesta ficticia.' && paOkSinMarcador.fallidos.length === 0, 'si el upsert del mensaje falla, el trabajo se completa igual que siempre (sin marcador)')
  const fallbackPa = literal(/this\.manejarEventoMotor\(\{ tipo: 'error', mensaje: trabajo\.error \|\| '(No fue posible generar tu Programa Analítico\. Intenta de nuevo\.)' \}\)/, servicio)
  verificar(fallbackPa !== null && /if \(trabajo\.estado === 'fallido'\) \{ this\.manejarTrabajoProgramaAnaliticoFallido\(trabajo\); return \}/.test(servicio) && !reLimite.test(fallbackPa), 'docente: ante error=null el cliente muestra su mensaje seguro de siempre («No fue posible generar tu Programa Analítico. Intenta de nuevo.»); la recuperación por polling solo depende de estado=fallido y no es límite permanente')
  const rutaTrabajoGet = readFileSync(join(RAIZ, 'app/api/chat/trabajo-documento/[trabajoId]/route.ts'), 'utf8')
  verificar(/error: trabajo\.error,/.test(rutaTrabajoGet) && /if \(trabajo\.docenteId !== auth\.user\.id\)/.test(rutaTrabajoGet), 'la consulta del trabajo devuelve el error persistido tal cual (ahora null) solo a su docente')
  const tplPaExc = plantilla(chat, '[PROGRAMA_ANALITICO] requestId=${requestIdPa} grupoId=${sesion.grupo_activo_id} excepción')
  const paExc = new Function('requestIdPa', 'sesion', 'errorSeguro', 'e', `return ${tplPaExc}`)('req-ficticio', { grupo_activo_id: 'g-ficticio' }, seg.errorSeguro, new Error(`Error creando el trabajo de documento: duplicate key ${NOMBRE}`)) as string
  verificar(paExc === '[PROGRAMA_ANALITICO] requestId=req-ficticio grupoId=g-ficticio excepción: tipo=Error', 'Programa Analítico (camino síncrono / creación del trabajo) → excepción con solo tipo de error')

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR DEL VERIFICADOR:', e)
  process.exit(1)
})
