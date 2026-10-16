// scripts/verificar-ficha-sin-datos-personales.ts
//
// P0 — minimización de datos personales en los prompts de ficha
// descriptiva. Ejecuta el código REAL de:
// - proyectarContextoAlumnoParaIA / contextoPedagogicoAlumno
//   (lib/motorContexto.ts),
// - /api/generar-ficha-descriptiva (ruta completa),
// - el tramo de app/api/chat/route.ts que arma los bloques A–D de la
//   ficha (extraído del archivo real y transpilado),
// con fetch interceptado: Supabase y Anthropic simulados, sin red y con
// datos 100% ficticios. Comprueba que ningún campo excluido llega al
// prompt y que los datos pedagógicos permitidos siguen presentes.
//
// Ejecutar: npx tsx --tsconfig ./tsconfig.json scripts/verificar-ficha-sin-datos-personales.ts

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

const RAIZ = join(__dirname, '..')

// --- Datos ficticios (ningún dato real) ---
const ALUMNO_ID = '00000000-0000-4000-8000-00000000f001'
const CICLO_ID = '00000000-0000-4000-8000-00000000f002'
const GRUPO_ID = '00000000-0000-4000-8000-00000000f003'
const DOCENTE_ID = '00000000-0000-4000-8000-00000000f004'
const INSTITUCION_ID = '00000000-0000-4000-8000-00000000f005'
const INSCRIPCION_ID = '00000000-0000-4000-8000-00000000f006'
const NOMBRE = 'Alumna Ficticia de Prueba'
const CURP = 'XEXX010101MNEXXXA8'
const FECHA_NAC = '2016-02-29'
const SENSIBLES: Record<string, string> = {
  curp: CURP,
  fecha_nacimiento: FECHA_NAC,
  alumno_id: ALUMNO_ID,
  ciclo_id: CICLO_ID,
  grupo_id: GRUPO_ID,
  docente_id: DOCENTE_ID,
  institucion_id: INSTITUCION_ID,
  inscripcion_id: INSCRIPCION_ID,
  telefono_desconocido: '5550001234',
  observaciones: 'OBSERVACION_LIBRE_FICTICIA',
  nota: 'NOTA_LIBRE_FICTICIA',
  perfil: 'PERFIL_LIBRE_FICTICIO',
  fecha_inscripcion: '2025-08-25T08:00:00',
}
const CLAVES_EXCLUIDAS = ['curp', 'fecha_nacimiento', 'sexo', 'numero_lista', 'institucion_id', 'docente_id', 'grupo_id', 'ciclo_escolar_id', 'creado_en', 'telefono', 'observaciones', 'notas_recientes', 'perfil_resumen', 'inscripcion_activa', 'datos_personales', 'fecha_inscripcion', 'fecha_baja']

const contextoCrudo = {
  datos_personales: {
    id: ALUMNO_ID, nombre: NOMBRE, institucion_id: INSTITUCION_ID, docente_id: DOCENTE_ID, creado_en: '2025-08-01T00:00:00',
    grupo_id: GRUPO_ID, numero_lista: 17, curp: CURP, sexo: 'M', fecha_nacimiento: FECHA_NAC,
    telefono: SENSIBLES.telefono_desconocido,
  },
  inscripcion_activa: {
    id: INSCRIPCION_ID, alumno_id: ALUMNO_ID, grupo_id: GRUPO_ID, ciclo_escolar_id: CICLO_ID, numero_lista: 17, estatus: 'activo',
    fecha_inscripcion: SENSIBLES.fecha_inscripcion, fecha_baja: null, observaciones: SENSIBLES.observaciones, docente_id: DOCENTE_ID,
  },
  asistencia_resumen: { faltas: 3, retardos: 2, justificadas: 1, dias_registrados: 41 },
  perfil_resumen: { texto: SENSIBLES.perfil },
  notas_recientes: [{ id: INSCRIPCION_ID, alumno_id: ALUMNO_ID, docente_id: DOCENTE_ID, fuente_modulo: 'chat', tipo: 'observacion', contenido: SENSIBLES.nota, generado_por: 'docente_explicito', estado: 'confirmado', fecha: '2025-09-01T00:00:00Z' }],
  campo_futuro_desconocido: { curp_tutor: 'XAXX010101HNEXXXA4' },
}

const INDICADOR = 'Indicador ficticio de lectura'
const INCIDENCIA = 'Incidencia ficticia registrada por el docente'
const resultadoFila = {
  proyecto_id: '00000000-0000-4000-8000-00000000f010', indicador_numero: 1, indicador_especifico: INDICADOR, aspecto_general: 'logro_aprendizaje',
  nivel: 'en_proceso', confianza: 0.9, corregido_manualmente: false, observacion: null,
  proyectos_seguimiento: { nombre: 'Proyecto ficticio', grupo_id: GRUPO_ID, ciclo_escolar_id: CICLO_ID, periodo_evaluacion_id: null, origen_resultados: 'fotografia', confirmado_en: '2025-10-01T00:00:00Z' },
}

// --- fetch interceptado (sin red) ---
const promptsAnthropic: string[] = []
const llamadasSupabase: string[] = []
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })
  if (url.startsWith('http://supabase.prueba.local/rest/v1/')) {
    const ruta = new URL(url).pathname.replace('/rest/v1/', '')
    llamadasSupabase.push(ruta)
    if (ruta === 'rpc/contexto_alumno') return json(contextoCrudo)
    if (ruta === 'rpc/consultar_asistencia_alumno') return json(contextoCrudo.asistencia_resumen)
    if (ruta === 'seguimiento_resultados') return json([resultadoFila])
    if (ruta === 'incidencias') return json([{ fecha: '2025-09-10', tipo: 'conducta', descripcion: INCIDENCIA }])
    return json({ message: 'ruta no simulada' }, 404)
  }
  if (url.startsWith('https://api.anthropic.com/')) {
    const cuerpo = String(init?.body ?? (input instanceof Request ? await input.text() : ''))
    promptsAnthropic.push(cuerpo)
    const borrador = { fortalezas: 'f', areas_oportunidad: 'a', apoyos_requeridos: 'r', observaciones_generales: 'o', recomendaciones: 'c' }
    return json({ id: 'msg_prueba', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: JSON.stringify(borrador) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
  }
  throw new Error('RED BLOQUEADA EN LA PRUEBA: ' + url)
}) as typeof fetch

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.prueba.local'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-prueba'
process.env.ANTHROPIC_API_KEY = 'sk-ant-prueba'

function sinSensibles(texto: string): string[] {
  const presentes = Object.entries(SENSIBLES).filter(([, v]) => texto.includes(v)).map(([k]) => k)
  if (texto.includes('XAXX010101HNEXXXA4')) presentes.push('curp_campo_desconocido')
  return presentes
}

async function main() {
  const motor = await import('../lib/motorContexto')

  // ===== 1. Proyección pura =====
  console.log('\n— 1. proyectarContextoAlumnoParaIA —')
  const p = motor.proyectarContextoAlumnoParaIA(contextoCrudo)
  const pTexto = JSON.stringify(p)
  verificar(JSON.stringify(Object.keys(p).sort()) === JSON.stringify(['asistencia_resumen', 'nombre']), 'la salida tiene EXACTAMENTE las claves permitidas (nombre, asistencia_resumen)')
  verificar(p.nombre === NOMBRE, 'conserva el nombre del alumno')
  verificar(JSON.stringify(p.asistencia_resumen) === JSON.stringify({ faltas: 3, retardos: 2, justificadas: 1, dias_registrados: 41 }), 'conserva los 4 conteos de asistencia')
  verificar(sinSensibles(pTexto).length === 0, `ningún valor sensible/administrativo/texto libre en la salida (${sinSensibles(pTexto).join(',') || 'ninguno'})`)
  verificar(CLAVES_EXCLUIDAS.every((k) => !pTexto.includes(`"${k}"`)), 'ninguna clave excluida (curp, fecha_nacimiento, sexo, ids, numero_lista, observaciones, notas, perfil, desconocidas)')
  const entradas: unknown[] = [null, undefined, 'texto', 42, [], {}, { datos_personales: 'x' }, { datos_personales: { nombre: 5 } }, { datos_personales: { nombre: '   ' } }]
  verificar(entradas.every((e) => JSON.stringify(motor.proyectarContextoAlumnoParaIA(e)) === JSON.stringify({ nombre: null, asistencia_resumen: null })), 'entradas nulas/malformadas → salida vacía segura, sin excepción')
  const asistMala = [{ faltas: '3', retardos: 0, justificadas: 0, dias_registrados: 1 }, { faltas: -1, retardos: 0, justificadas: 0, dias_registrados: 1 }, { faltas: 1, retardos: 0, justificadas: 0 }, { faltas: NaN, retardos: 0, justificadas: 0, dias_registrados: 1 }]
  verificar(asistMala.every((a) => motor.proyectarContextoAlumnoParaIA({ datos_personales: { nombre: 'X' }, asistencia_resumen: a }).asistencia_resumen === null), 'asistencia con tipos/valores inválidos → null (nunca se propaga el objeto original)')
  const conExtraAsist = motor.proyectarContextoAlumnoParaIA({ asistencia_resumen: { faltas: 0, retardos: 0, justificadas: 0, dias_registrados: 0, curp: CURP } })
  verificar(!JSON.stringify(conExtraAsist).includes(CURP), 'una clave extra dentro de asistencia_resumen no se copia')

  // ===== 2. contextoPedagogicoAlumno (agregador del Chat) =====
  console.log('\n— 2. contextoPedagogicoAlumno —')
  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient('http://supabase.prueba.local', 'anon-prueba')
  const nLlamadas = llamadasSupabase.length
  const ctx = await motor.contextoPedagogicoAlumno(sb, ALUMNO_ID, CICLO_ID, GRUPO_ID)
  const llamadasCtx = llamadasSupabase.slice(nLlamadas).sort()
  verificar(JSON.stringify(llamadasCtx) === JSON.stringify(['incidencias', 'rpc/consultar_asistencia_alumno', 'rpc/contexto_alumno', 'seguimiento_resultados']), `mismas 4 consultas de siempre, ninguna adicional (${llamadasCtx.join(', ')})`)
  verificar(!('contextoAlumno' in ctx) && JSON.stringify(Object.keys(ctx).sort()) === JSON.stringify(['asistencia', 'contextoAlumnoParaIA', 'incidencias', 'resultadosProyectos']), 'el agregador ya NO expone el objeto crudo de contexto_alumno')
  verificar(JSON.stringify(ctx.contextoAlumnoParaIA) === JSON.stringify(p), 'el agregador entrega exactamente la proyección')
  verificar(ctx.resultadosProyectos.length === 1 && ctx.incidencias.total === 1 && ctx.asistencia.dias_registrados === 41, 'resultados confirmados, incidencias y asistencia (B, C, D) intactos')

  // ===== 3. Prompt REAL de la ficha del Chat (bloques A–D) =====
  console.log('\n— 3. Ficha del Chat IA (tramo real de route.ts) —')
  const fuenteChat = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf8')
  const ini = fuenteChat.indexOf('            const resultadosParaFicha = ctxPedagogico.resultadosProyectos.map(')
  const marcaFin = 'contextoEnriquecido += `\\n\\n${INSTRUCCIONES_FICHA_DESCRIPTIVA}`'
  const fin = fuenteChat.indexOf(marcaFin, ini)
  verificar(ini > 0 && fin > ini, 'tramo de la ficha localizado en route.ts')
  const inicioRama = fuenteChat.lastIndexOf("if (clasificacion.intencion_principal === 'ficha_descriptiva'", ini)
  const ramaFicha = fuenteChat.slice(inicioRama, fin + marcaFin.length)
  verificar(inicioRama > 0 && /ctxPedagogico = await contextoPedagogicoAlumno\(/.test(ramaFicha) && !/contextoAlumno\(supabaseUser/.test(ramaFicha), 'la rama de la ficha obtiene su contexto SOLO de contextoPedagogicoAlumno (nunca de contextoAlumno() crudo)')
  verificar(!/ctxPedagogico\.contextoAlumno\b(?!ParaIA)/.test(fuenteChat) && /JSON\.stringify\(ctxPedagogico\.contextoAlumnoParaIA\)/.test(ramaFicha), 'el bloque A serializa únicamente la proyección (sin referencia al objeto original)')
  const ts = (await import('typescript')).default
  const js = ts.transpileModule(`function __bloque(ctxPedagogico: any, INSTRUCCIONES_FICHA_DESCRIPTIVA: string) { let contextoEnriquecido = ''\n${fuenteChat.slice(ini, fin + marcaFin.length)}\n return contextoEnriquecido }`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText
  const construirBloque = new Function(`${js}; return __bloque`)() as (c: unknown, i: string) => string
  const { INSTRUCCIONES_FICHA_DESCRIPTIVA } = await import('../lib/asistente/instruccionesFichaDescriptiva')
  const promptChat = construirBloque(ctx, INSTRUCCIONES_FICHA_DESCRIPTIVA)
  const bloqueA = promptChat.slice(promptChat.indexOf('A) CONTEXTO BASE DEL ALUMNO:'), promptChat.indexOf('B) RESULTADOS'))
  verificar(sinSensibles(promptChat).length === 0, `prompt final de la ficha del Chat sin ningún valor sensible (${sinSensibles(promptChat).join(',') || 'ninguno'})`)
  verificar(CLAVES_EXCLUIDAS.every((k) => !bloqueA.includes(`"${k}"`)), 'bloque A sin ninguna clave excluida')
  verificar(bloqueA.includes(NOMBRE) && bloqueA.includes('"dias_registrados":41'), 'bloque A conserva nombre y asistencia')
  verificar(promptChat.includes(INDICADOR) && promptChat.includes('"nivel":"en_proceso"') && promptChat.includes(INCIDENCIA) && promptChat.includes('"faltas":3') && promptChat.includes('Proyecto ficticio'), 'bloques B (resultados), C (asistencia) y D (incidencias) intactos en el prompt')

  // ===== 4. Prompt REAL de /api/generar-ficha-descriptiva =====
  console.log('\n— 4. /api/generar-ficha-descriptiva (ruta completa) —')
  const fuenteRuta = readFileSync(join(RAIZ, 'app/api/generar-ficha-descriptiva/route.ts'), 'utf8')
  verificar(/const contexto = proyectarContextoAlumnoParaIA\(await contextoAlumno\(/.test(fuenteRuta) && (fuenteRuta.match(/contextoAlumno\(/g) || []).length === 1 && (fuenteRuta.match(/JSON\.stringify\(/g) || []).length === 1 && /JSON\.stringify\(contexto\)/.test(fuenteRuta), 'la ruta solo serializa la proyección (una única lectura de contexto_alumno, sin variable cruda)')
  const ruta = await import('../app/api/generar-ficha-descriptiva/route')
  const nPrompts = promptsAnthropic.length
  const nSb = llamadasSupabase.length
  const res = await ruta.POST({ json: async () => ({ alumno_id: ALUMNO_ID, ciclo_escolar_id: CICLO_ID, access_token: 'token-prueba' }) } as never)
  const cuerpo = await res.json()
  verificar(res.status === 200 && !!cuerpo.borrador, 'la ruta sigue respondiendo con el borrador (contrato sin cambios)')
  verificar(promptsAnthropic.length === nPrompts + 1 && JSON.stringify(llamadasSupabase.slice(nSb)) === JSON.stringify(['rpc/contexto_alumno']), 'exactamente 1 llamada de IA y 1 consulta a Supabase (ninguna adicional)')
  const promptRuta = promptsAnthropic.at(-1) ?? ''
  verificar(sinSensibles(promptRuta).length === 0, `prompt final de la ruta sin ningún valor sensible (${sinSensibles(promptRuta).join(',') || 'ninguno'})`)
  verificar(CLAVES_EXCLUIDAS.every((k) => !promptRuta.includes(`\\"${k}\\"`)), 'prompt de la ruta sin ninguna clave excluida')
  verificar(promptRuta.includes(NOMBRE) && promptRuta.includes('\\"dias_registrados\\":41'), 'prompt de la ruta conserva nombre y asistencia')

  // ===== 5. Ningún otro prompt de ficha usa el objeto crudo =====
  console.log('\n— 5. Referencias al contexto original —')
  const fuenteMotor = readFileSync(join(RAIZ, 'lib/motorContexto.ts'), 'utf8')
  const tipoCtx = fuenteMotor.slice(fuenteMotor.indexOf('export type ContextoPedagogicoAlumno = {'), fuenteMotor.indexOf('}', fuenteMotor.indexOf('export type ContextoPedagogicoAlumno = {')))
  verificar(!/\bcontextoAlumno\s*:/.test(tipoCtx) && /contextoAlumnoParaIA: ContextoAlumnoParaIA/.test(tipoCtx), 'el tipo ContextoPedagogicoAlumno no tiene campo crudo')
  verificar(/return \{ contextoAlumnoParaIA: proyectarContextoAlumnoParaIA\(contexto\),/.test(fuenteMotor), 'contextoPedagogicoAlumno devuelve la proyección, nunca `contexto`')
  const fuenteInstr = readFileSync(join(RAIZ, 'lib/asistente/instruccionesFichaDescriptiva.ts'), 'utf8')
  verificar(!fuenteInstr.includes('JSON.stringify'), 'las instrucciones de la ficha no serializan datos')

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR DEL VERIFICADOR:', e)
  process.exit(1)
})
