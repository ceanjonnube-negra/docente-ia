// scripts/verificar-logs-sin-datos-personales.ts
//
// Privacidad de logs — Etapa A. Sin red ni llamadas facturables, con
// datos 100% ficticios. Comprueba que los logs del servidor no registran
// nombres de alumnos, correos del docente ni respuestas completas de RPC,
// conservando indicadores técnicos útiles:
// 1. Escaneo estático de todos los console.* de app/api/** y lib/**
//    (módulos de servidor) contra interpolaciones de datos personales.
// 2. Las plantillas REALES de los logs corregidos, evaluadas con datos
//    ficticios: solo indicadores (presente/ausente, candidatos=N, id).
// 3. aplicarCorreccionAlumno REAL ante una respuesta inesperada de la RPC
//    con valores ficticios: el log no contiene ningún valor.
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

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR DEL VERIFICADOR:', e)
  process.exit(1)
})
