// scripts/verificar-historial-sin-datos-personales.ts
//
// P0-B — el historial que reciben los modelos (Nivel 0 y Sonnet) no
// reenvía CURP, fecha de nacimiento ni sexo mostrados por las
// herramientas autorizadas, sin debilitar C2–C4. Usa la SALIDA REAL de
// las herramientas (ejecutarHerramientaDeModulo con Supabase simulado),
// firmas reales con una clave de prueba y datos 100% ficticios. Sin red.
//
// Ejecutar: npx tsx --tsconfig ./tsconfig.json scripts/verificar-historial-sin-datos-personales.ts

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
process.env.CORRECCION_ALUMNO_HMAC_SECRET_KEY = 'clave-de-prueba-ficticia-0123456789-abcdefghijklmnopqrstuvwxyz'

// --- Datos ficticios ---
const DOCENTE = '00000000-0000-4000-8000-0000000d0001'
const CONV = '00000000-0000-4000-8000-0000000c0001'
const CONV_OTRA = '00000000-0000-4000-8000-0000000c0002'
const CICLO = '00000000-0000-4000-8000-0000000c1c10'
const A1 = '00000000-0000-4000-8000-0000000a0001'
const A2 = '00000000-0000-4000-8000-0000000a0002'
const N1 = 'Alumna Ficticia Uno'
const N2 = 'Alumno Ficticio Dos'
const CURP_REG = 'XEXX010101MNEXXXA8'
const CURP_NUEVA = 'XAXX020202HNEXXXB5'
const FECHA_REG = '2016-03-14'
const FECHA_NUEVA = '2016-05-05'
const roster = [
  { alumno_id: A1, nombre_completo: N1, sexo: 'M', numero_lista: 1 },
  { alumno_id: A2, nombre_completo: N2, sexo: 'H', numero_lista: 2 },
]
const datosPorAlumno: Record<string, Record<string, unknown>> = {
  [A1]: { id: A1, nombre: N1, curp: CURP_REG, sexo: 'M', fecha_nacimiento: FECHA_REG },
  [A2]: { id: A2, nombre: N2, curp: null, sexo: 'H', fecha_nacimiento: null },
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const json = (c: unknown, status = 200) => new Response(JSON.stringify(c), { status, headers: { 'content-type': 'application/json' } })
  if (url.startsWith('http://supabase.prueba.local/rest/v1/rpc/contexto_alumno')) {
    const cuerpo = JSON.parse(String(init?.body ?? '{}'))
    return json({ datos_personales: datosPorAlumno[cuerpo.p_alumno_id] ?? null })
  }
  throw new Error('RED BLOQUEADA EN LA PRUEBA: ' + url)
}) as typeof fetch

const quitarMarcadores = (t: string) => t.replace(/\n?\[\[[A-Z_]+:[^\]]+\]\]/g, '').trim()

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const herr = await import('../lib/asistente/herramientasModulo')
  const hist = await import('../lib/asistente/historialParaModelo')
  const firmaMod = await import('../lib/asistente/propuestaCorreccionFirmada')
  const motor = await import('../lib/motorContexto')
  const sb = createClient('http://supabase.prueba.local', 'anon-prueba')
  const sesion = { grupo_activo_id: 'g', ciclo_escolar_id: CICLO, alumnos_del_grupo_activo: roster } as never
  const ctx = { sb, sesion, userId: DOCENTE, zonaHoraria: 'America/Mexico_City', canal: 'text' as const, conversacionId: CONV, propuestaCorreccionPendiente: null }
  const ent = (id: string, n: string) => ({ alumno_id: id, alumno_nombre_detectado: n, alumno_ambiguo: false, opciones_alumno_ambiguo: [] })
  const base = { nivel_ejecucion: 1, datos_faltantes: [], entidades_resueltas: ent(A1, N1) }
  const ejecutar = async (c: Record<string, unknown>) => (await herr.ejecutarHerramientaDeModulo({ ...base, ...c } as never, ctx as never)) ?? ''
  const proyectar = (texto: string) => hist.proyectarHistorialParaModelo([{ role: 'assistant', content: texto }]).historial[0].content

  // ===== 1. Plantillas REALES de consulta y corrección =====
  console.log('\n— 1. Plantillas reales enmascaradas —')
  const consultaCurp = await ejecutar({ intencion_principal: 'consultar_dato_alumno', campo_alumno_solicitado: 'curp' })
  const consultaSexo = await ejecutar({ intencion_principal: 'consultar_dato_alumno', campo_alumno_solicitado: 'sexo' })
  const consultaFecha = await ejecutar({ intencion_principal: 'consultar_dato_alumno', campo_alumno_solicitado: 'fecha_nacimiento' })
  const corregir = (campo: string, valor: string, modo = 'corregir') => ejecutar({ intencion_principal: 'corregir_dato_alumno', accion_correccion_alumno: 'proponer', modo_operacion_alumno: modo, campo_alumno_corregir: campo, valor_alumno_propuesto: valor })
  const propCurp = await corregir('curp', CURP_NUEVA)
  const propFecha = await corregir('fecha_nacimiento', FECHA_NUEVA)
  const propSexo = await corregir('sexo', 'H')
  const compCoincide = await corregir('curp', CURP_REG, 'comparar')
  const compDifiereFecha = await corregir('fecha_nacimiento', FECHA_NUEVA, 'comparar')
  const compDifiereSexo = await corregir('sexo', 'H', 'comparar')
  const sinCambios = await corregir('fecha_nacimiento', FECHA_REG)
  const fuenteHerr = readFileSync(join(RAIZ, 'lib/asistente/herramientasModulo.ts'), 'utf8')
  const fuenteBoton = readFileSync(join(RAIZ, 'app/api/alumnos/aplicar-correccion/route.ts'), 'utf8')
  const tplAplicado = fuenteHerr.match(/`(Listo\. Corregí \$\{ETIQUETA_CAMPO_ALUMNO_CORREGIR\[datos\.campo\]\}[^`]*)`/)?.[1] ?? ''
  const tplBoton = fuenteBoton.match(/`(Listo\. Corregí el dato: [^`]*)`/)?.[1] ?? ''
  const aplicado = new Function('ETIQUETA_CAMPO_ALUMNO_CORREGIR', 'datos', `return \`${tplAplicado}\``)(herr.ETIQUETA_CAMPO_ALUMNO_CORREGIR, { campo: 'fecha_nacimiento', nombre: N1, valorNuevo: FECHA_NUEVA }) as string
  const boton = new Function('resultado', `return \`${tplBoton}\``)({ valorNuevo: CURP_NUEVA }) as string
  const casos: [string, string, string[]][] = [
    ['consulta CURP', consultaCurp, [CURP_REG]],
    ['consulta sexo', consultaSexo, ['Niña']],
    ['consulta fecha', consultaFecha, ['14 de marzo de 2016']],
    ['propuesta CURP', propCurp, [CURP_REG, CURP_NUEVA]],
    ['propuesta fecha', propFecha, [FECHA_REG, FECHA_NUEVA]],
    ['propuesta sexo', propSexo, ['Actual: M', 'Nuevo: H']],
    ['comparación coincide', compCoincide, [CURP_REG]],
    ['comparación difiere (fecha)', compDifiereFecha, [FECHA_REG, FECHA_NUEVA]],
    ['comparación difiere (sexo)', compDifiereSexo, ['registrada: M', 'proporcionado: H', ' a H")']],
    ['sin cambios', sinCambios, [FECHA_REG]],
    ['aplicado (texto)', aplicado, [FECHA_NUEVA]],
    ['aplicado (botón)', boton, [CURP_NUEVA]],
  ]
  for (const [nombre, texto, valores] of casos) {
    const visible = quitarMarcadores(texto)
    const p = proyectar(visible)
    const ok = valores.every((v) => visible.includes(v)) && valores.every((v) => !p.includes(v)) && hist.contieneMarcadorOmision(p)
    verificar(ok, `${nombre}: la salida real contiene el valor y la proyección lo omite (${valores.length} valor(es))`)
    if (!ok) console.error(`  salida real (ficticia): ${JSON.stringify(visible)}\n  proyección: ${JSON.stringify(p)}`)
  }
  verificar(proyectar(quitarMarcadores(consultaCurp)).startsWith(`La CURP registrada de ${N1} es `) && proyectar(quitarMarcadores(propCurp)).includes(`Alumno: ${N1}\nCampo: CURP\nActual: ⟦`),
    'se conservan nombre, etiquetas y estructura (la plantilla sigue siendo reconocible)')

  // ===== 2. Detector de deriva de plantillas =====
  console.log('\n— 2. Deriva de plantillas —')
  const ini = fuenteHerr.indexOf('const herramientaConsultarDatoAlumno')
  const fin = fuenteHerr.indexOf('const herramientaRevisarDatosAlumnos')
  const region = fuenteHerr.slice(ini, fin)
  const contar = (re: RegExp) => (region.match(re) || []).length
  const esperado: Record<string, number> = { actualTexto: 3, 'd\\.valorNuevo': 1, 'datos\\.valor': 1, 'datos\\.valorNuevo': 1, 'datos\\.valorProporcionado': 3, etiquetaSexo: 1, fechaLegible: 1, valorCrudo: 1 }
  const reales = Object.fromEntries(Object.keys(esperado).map((k) => [k, contar(new RegExp(`\\$\\{${k}\\}`, 'g'))]))
  verificar(ini > 0 && fin > ini && Object.entries(esperado).every(([k, n]) => reales[k] === n), `las interpolaciones de valores personales en las plantillas coinciden con las cubiertas (${JSON.stringify(reales)})`)
  verificar((fuenteBoton.match(/\$\{resultado\.valorNuevo\}/g) || []).length === 1, 'la ruta del botón tiene exactamente 1 plantilla con valor (cubierta)')

  // ===== 3. Contenido legítimo intacto =====
  console.log('\n— 3. Fechas pedagógicas y otros contenidos intactos —')
  const legitimos = [
    '**Proyecto Ficticio**\nPeriodo: Trimestre 1\nFechas: 2026-10-05 al 2026-10-16\nEstado: publicada',
    'Hoy, lunes, 5 de octubre de 2026.\nPresentes: 25 · Faltas: 2 · Retardos: 1',
    'Alumna Ficticia Uno tiene 2 incidencia(s) registrada(s); la más reciente es del 2026-09-10 (conducta).',
    'Listo, guardé la planeación de Proyecto Ficticio, del 2026-10-05 al 2026-10-09.',
    'El 16 de septiembre de 2026 no hay clases (suspensión oficial).',
    'Código de hoja: HOJA-2026-ABCD1234. Fecha de nacimiento: dato no solicitado.',
  ]
  const proyLeg = hist.proyectarHistorialParaModelo(legitimos.flatMap((t) => [{ role: 'user' as const, content: t }, { role: 'assistant' as const, content: t }]))
  verificar(proyLeg.historial.every((t, i) => t.content === legitimos[Math.floor(i / 2)]) && proyLeg.turnosEnmascarados === 0, 'fechas de proyectos, calendario, asistencia e incidencias: byte a byte idénticas (0 turnos alterados)')

  // ===== 4. CURP en turnos anteriores =====
  console.log('\n— 4. CURP en turnos anteriores —')
  const pc = hist.proyectarHistorialParaModelo([
    { role: 'user', content: `corrige la CURP de ${N1} a ${CURP_NUEVA.toLowerCase()} por favor` },
    { role: 'user', content: `la otra es ${CURP_REG}.` },
    { role: 'user', content: 'XXXX999999HZZZZZZ9 no es una CURP real (entidad y fecha inválidas)' },
  ]).historial
  verificar(!pc[0].content.toLowerCase().includes(CURP_NUEVA.toLowerCase()) && !pc[1].content.includes(CURP_REG) && pc[0].content.includes(N1), 'CURP del docente en turnos anteriores (mayúsculas o minúsculas) → omitida; el resto del texto se conserva')
  verificar(pc[2].content === 'XXXX999999HZZZZZZ9 no es una CURP real (entidad y fecha inválidas)', 'una cadena con forma de CURP pero estructura inválida no se toca')

  // ===== 5. Marcador nunca es un valor válido =====
  console.log('\n— 5. Marcadores de omisión —')
  const marcadores = Object.values(hist.MARCADOR_OMISION)
  verificar(marcadores.every((m) => (['curp', 'sexo', 'fecha_nacimiento'] as const).every((c) => !motor.validarValorCampoAlumno(c, m).valido)), 'ningún marcador es un valor válido para CURP, sexo o fecha (copiarlo siempre se rechaza)')
  verificar(marcadores.every((m) => hist.contieneMarcadorOmision(m)) && !hist.contieneMarcadorOmision(CURP_REG) && !hist.contieneMarcadorOmision(null), 'contieneMarcadorOmision reconoce los marcadores y nada más')

  // ===== 6. Excepción de Nivel 0 vinculada a la propuesta firmada =====
  console.log('\n— 6. Excepción controlada de Nivel 0 —')
  const marcadorProp = propCurp.match(/\[\[CORRECCION_ALUMNO:([^\]]+)\]\]/)?.[1] ?? ''
  const diferencia = JSON.parse(Buffer.from(marcadorProp, 'base64').toString('utf8'))
  const sobre = diferencia.sobre
  const pendiente = { mensajeId: 'm-1', sobre }
  const ctxV = { docenteId: DOCENTE, conversacionId: CONV, roster }
  const vigente = hist.propuestaVigenteParaNivel0(pendiente, ctxV)
  verificar(!!vigente && vigente.alumnoNombre === N1 && vigente.campo === 'curp' && vigente.valorNuevo === CURP_NUEVA, 'propuesta real firmada y vigente → excepción disponible (alumno, campo y valor firmados)')
  const secreto = process.env.CORRECCION_ALUMNO_HMAC_SECRET_KEY!
  const vencida = firmaMod.firmarConSecreto(firmaMod.construirPayloadCorreccion({ docenteId: DOCENTE, conversacionId: CONV, alumnoId: A1, alumnoNombre: N1, campo: 'curp', valorAnterior: CURP_REG, valorNuevo: CURP_NUEVA }, new Date(Date.now() - 24 * 3600_000)), secreto)
  const alterada = { ...sobre, payload: { ...sobre.payload, valorNuevo: 'XAXX030303HNEXXXC2' } }
  const invalidos: [string, unknown, typeof ctxV][] = [
    ['sin propuesta', null, ctxV],
    ['sin sobre', { mensajeId: 'm', sobre: null }, ctxV],
    ['otro docente', pendiente, { ...ctxV, docenteId: '00000000-0000-4000-8000-0000000d0099' }],
    ['otra conversación', pendiente, { ...ctxV, conversacionId: CONV_OTRA }],
    ['sin conversación autorizada', pendiente, { ...ctxV, conversacionId: null as never }],
    ['vencida', { mensajeId: 'm', sobre: vencida }, ctxV],
    ['alterada', { mensajeId: 'm', sobre: alterada }, ctxV],
    ['alumno fuera del grupo', pendiente, { ...ctxV, roster: [roster[1]] }],
    ['nombre del alumno cambió', pendiente, { ...ctxV, roster: [{ ...roster[0], nombre_completo: 'Alumna Ficticia Renombrada' }, roster[1]] }],
  ]
  for (const [n, p, c] of invalidos) verificar(hist.propuestaVigenteParaNivel0(p as never, c) === null, `${n} → sin excepción (fail-closed)`)
  const sinClave = process.env.CORRECCION_ALUMNO_HMAC_SECRET_KEY
  delete process.env.CORRECCION_ALUMNO_HMAC_SECRET_KEY
  verificar(hist.propuestaVigenteParaNivel0(pendiente, ctxV) === null, 'sin clave de firma disponible → sin excepción (fail-closed)')
  process.env.CORRECCION_ALUMNO_HMAC_SECRET_KEY = sinClave

  const visibleProp = quitarMarcadores(propCurp)
  const h = (extra: { role: 'user' | 'assistant'; content: string }[] = []) => [{ role: 'user' as const, content: `corrige la CURP de ${N1} a ${CURP_NUEVA}` }, { role: 'assistant' as const, content: visibleProp }, ...extra]
  const conExc = hist.proyectarHistorialParaModelo(h(), { propuestaVigente: vigente })
  const ultimoTurno = conExc.historial.at(-1)!.content
  verificar(conExc.excepcionPropuesta && ultimoTurno.includes(`Alumno: ${N1}`) && ultimoTurno.includes('Campo: CURP') && ultimoTurno.includes(`Nuevo: ${CURP_NUEVA}`), 'Nivel 0 con propuesta vigente en el último turno → conserva Alumno, Campo y Nuevo')
  verificar(!ultimoTurno.includes(CURP_REG) && ultimoTurno.includes(`Actual: ${hist.MARCADOR_OMISION.valor}`), '«Actual» se enmascara SIEMPRE, incluso con la excepción')
  verificar(!conExc.historial[0].content.includes(CURP_NUEVA), 'el turno anterior del docente sigue enmascarado aunque haya excepción')
  const noUltimo = hist.proyectarHistorialParaModelo(h([{ role: 'user', content: 'otra cosa' }, { role: 'assistant', content: 'Respuesta.' }]), { propuestaVigente: vigente })
  const otraProp = { ...vigente!, valorNuevo: 'XAXX030303HNEXXXC2' }
  const otroAlumno = { ...vigente!, alumnoNombre: N2 }
  const otroCampo = { ...vigente!, campo: 'fecha_nacimiento' as const }
  const sinExc = [
    ['la propuesta no es el último turno', noUltimo],
    ['propuesta pendiente con otro valor', hist.proyectarHistorialParaModelo(h(), { propuestaVigente: otraProp })],
    ['propuesta pendiente de otro alumno', hist.proyectarHistorialParaModelo(h(), { propuestaVigente: otroAlumno })],
    ['propuesta pendiente de otro campo', hist.proyectarHistorialParaModelo(h(), { propuestaVigente: otroCampo })],
    ['sin propuesta pendiente válida', hist.proyectarHistorialParaModelo(h(), { propuestaVigente: null })],
    ['Sonnet principal (sin excepción)', hist.proyectarHistorialParaModelo(h())],
  ] as const
  for (const [n, r] of sinExc) {
    const texto = r.historial.map((t) => t.content).join('\n')
    verificar(!r.excepcionPropuesta && !texto.includes(CURP_NUEVA) && !texto.includes(CURP_REG), `${n} → «Nuevo» y «Actual» enmascarados`)
  }
  const original = h()
  const copia = JSON.stringify(original)
  hist.proyectarHistorialParaModelo(original, { propuestaVigente: vigente })
  verificar(JSON.stringify(original) === copia, 'la proyección nunca modifica el historial original (copia pura)')

  // ===== 7. Cableado en route.ts =====
  console.log('\n— 7. Destinos en app/api/chat/route.ts —')
  const r = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf8')
  verificar(/clasificarNivel0\(mensaje, sesion, proyeccionNivel0\.historial\.slice\(-4\)/.test(r) && !/clasificarNivel0\(mensaje, sesion, historialMensajes/.test(r), 'Nivel 0 recibe la proyección (con la excepción verificada)')
  verificar(/propuestaVigente: propuestaVigenteParaNivel0\(propuestaCorreccionPendiente, \{ docenteId: userId, conversacionId: conversacionIdContinuidad, roster: sesion\.alumnos_del_grupo_activo \}\)/.test(r), 'la excepción se calcula solo desde la propuesta pendiente verificada (firma, docente, conversación autorizada, grupo)')
  verificar(/const proyeccionSonnet = proyectarHistorialParaModelo\(historialMensajes\)\n/.test(r) && /messages: \[\n\s+\.\.\.proyeccionSonnet\.historial,/.test(r) && !/messages: \[\n\s+\.\.\.historialMensajes,/.test(r), 'Sonnet principal recibe la proyección SIN excepción')
  verificar(/if \(clasificacion\.accion_correccion_alumno === 'confirmar' && !proyeccionNivel0\.excepcionPropuesta\) \{\n\s+clasificacion\.valor_alumno_propuesto = MARCADOR_OMISION\.valor/.test(r), 'confirmación sin excepción verificada → valor marcado como omitido (la comprobación cruzada lo rechaza)')
  verificar(/\[\.\.\.historialMensajes\]\.reverse\(\)\.find\(\(h\) => h\.role === 'assistant' && esDocumentoFormal/.test(r) && /\.\.\.historialMensajes\.slice\(-4\)\.filter\(\(t\) => t\.role === 'user'\)/.test(r) && /aprobarBorradorPlaneacion\(supabaseUser, sesion, historialMensajes,/.test(r), 'procesos deterministas (documento, identidad C1, aprobación) siguen con el historial original')
  const coincide = fuenteHerr.slice(fuenteHerr.indexOf('const validacionClasificada = '), fuenteHerr.indexOf("if (!coincide) return { exito: true, datos: { tipo: 'no_coincide'"))
  verificar(/validacionClasificada\.valido && validacionClasificada\.valorNormalizado === firmada\.valorNuevo/.test(coincide), 'la comprobación cruzada C4 del valor sigue intacta')

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR DEL VERIFICADOR:', e)
  process.exit(1)
})
