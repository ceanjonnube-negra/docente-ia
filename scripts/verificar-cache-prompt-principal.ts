// scripts/verificar-cache-prompt-principal.ts
//
// Caché de prompt — Etapa 1. Comprueba, sin ninguna llamada a Anthropic
// y con datos ficticios, que el system prompt principal de
// app/api/chat/route.ts se transmite en 3 bloques cuya concatenación es
// BYTE A BYTE la cadena anterior (plantilla del commit base), que los
// bloques cacheables (A y B) son estables y no contienen datos
// dinámicos, que la estructura es compatible con prompt caching y que
// P0/P0-B siguen intactos.
//
// Ejecutar:
//   npx tsx --tsconfig ./tsconfig.json scripts/verificar-cache-prompt-principal.ts
// Variables opcionales:
//   VERIFICAR_RUTA_CHAT   archivo route.ts a verificar (por defecto el del repo)
//   VERIFICAR_BASE_ARCHIVO archivo route.ts base (antes de la Etapa 1); si no
//                          se indica, se lee con `git show <VERIFICAR_BASE_REF>`
//   VERIFICAR_BASE_REF    commit base (por defecto f90a666…, último sin Etapa 1)

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
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
const RUTA = process.env.VERIFICAR_RUTA_CHAT || join(RAIZ, 'app/api/chat/route.ts')
const BASE_REF = process.env.VERIFICAR_BASE_REF || 'f90a666ad1a10409f387dc5c8e23a440f76c42ff'
// Cambio AUTORIZADO posterior a la Etapa 1 (atribución de fuentes): el bloque CITAR LA FUENTE
// de la plantilla base se sustituye por el texto nuevo; ambos quedan fijados por SHA-256.
const HASH_CITAR_ANTERIOR = '44dd2d4115308fa5fc5faf961a1ed92c2670b49edce5bc4826a5e6cdcc41d343'
const HASH_CITAR_ACTUAL = 'f120b94a273c0f6750a9a6e2304d8d4857d4515a0ee6b91cb4deb101a8945cdf'

// Extrae el texto fuente de un template literal que empieza en `inicio`
// (posición del backtick de apertura), respetando ${...} y templates
// anidados (pila explícita plantilla/expresión).
function literalDesde(s: string, inicio: number): string {
  type Modo = { tipo: 'tpl' } | { tipo: 'expr'; llaves: number }
  const pila: Modo[] = [{ tipo: 'tpl' }]
  let k = inicio + 1
  while (k < s.length) {
    const modo = pila[pila.length - 1]
    const ch = s[k]
    if (modo.tipo === 'tpl') {
      if (ch === '\\') { k += 2; continue }
      if (ch === '`') { pila.pop(); if (pila.length === 0) return s.slice(inicio, k + 1); k++; continue }
      if (ch === '$' && s[k + 1] === '{') { pila.push({ tipo: 'expr', llaves: 1 }); k += 2; continue }
      k++
    } else {
      if (ch === "'" || ch === '"') { const q = ch; k++; while (k < s.length && s[k] !== q) { if (s[k] === '\\') k++; k++ } k++; continue }
      if (ch === '`') { pila.push({ tipo: 'tpl' }); k++; continue }
      if (ch === '{') modo.llaves++
      else if (ch === '}') { modo.llaves--; if (modo.llaves === 0) pila.pop() }
      k++
    }
  }
  throw new Error('template literal sin cerrar')
}

// Interpolaciones de primer nivel de un literal.
function interpolaciones(literal: string): string[] {
  const res: string[] = []
  let d = 0, ini = -1
  for (let p = 0; p < literal.length; p++) {
    if (literal[p] === '$' && literal[p + 1] === '{' && d === 0) { ini = p; d = 1; p++; continue }
    if (d > 0) {
      if (literal[p] === '{') d++
      else if (literal[p] === '}') { d--; if (d === 0) res.push(literal.slice(ini, p + 1)) }
    }
  }
  return res
}

const IDENTIFICADORES = ['fuentesDisponiblesTexto', 'infoFechaHora', 'contextoEnriquecido', 'contextoRAG', 'contextoProceso', 'esTurnoFichaDescriptiva', 'MARCO_CURRICULAR_VIGENTE', 'cicloEscolar',
  'bloqueVoz', 'bloqueConsultaOficial', 'bloqueModoImagen', 'bloqueDocumentoIlustrado', 'bloqueNivelEducativo', 'bloqueFechasExplicitas', 'bloqueTransformarTexto']

function renderizar(literal: string, env: Record<string, unknown>): string {
  const params = IDENTIFICADORES
  // Si el literal usa un identificador que no está en el entorno, falla (ReferenceError): nunca se rinde en silencio.
  return new Function(...params, `"use strict"; return ${literal}`)(...params.map((p) => env[p])) as string
}

function main() {
  const fuente = readFileSync(RUTA, 'utf8')
  let base: string
  try {
    base = process.env.VERIFICAR_BASE_ARCHIVO ? readFileSync(process.env.VERIFICAR_BASE_ARCHIVO, 'utf8') : execFileSync('git', ['show', `${BASE_REF}:app/api/chat/route.ts`], { cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    verificar(false, `no se pudo leer el route.ts base (${BASE_REF}) — la equivalencia NO se comprobó`)
    console.log(`\n${fallos} prueba(s) fallaron.`)
    process.exit(1)
  }

  // ===== 1. Estructura de los 3 bloques =====
  console.log('\n— 1. Estructura del system en bloques —')
  const iniSystem = fuente.indexOf('    system: [\n')
  const finSystem = fuente.indexOf('\n    ],\n', iniSystem)
  const sistema = fuente.slice(iniSystem, finSystem)
  const marcaA = "      { type: 'text' as const, cache_control: { type: 'ephemeral' as const }, text: `Eres Docente IA,"
  const marcaB = "      { type: 'text' as const, cache_control: { type: 'ephemeral' as const }, text: `${fuentesDisponiblesTexto}"
  const marcaC = "      { type: 'text' as const, text: `FECHA Y HORA ACTUALES DEL SISTEMA"
  const pA = fuente.indexOf(marcaA, iniSystem), pB = fuente.indexOf(marcaB, iniSystem), pC = fuente.indexOf(marcaC, iniSystem)
  verificar(iniSystem > 0 && finSystem > iniSystem && pA > iniSystem && pA < pB && pB < pC && pC < finSystem, 'system es un arreglo de exactamente 3 bloques en orden A → B → C')
  const litA = literalDesde(fuente, pA + marcaA.indexOf('`'))
  const litB = literalDesde(fuente, pB + marcaB.indexOf('`'))
  const litC = literalDesde(fuente, pC + marcaC.indexOf('`'))
  verificar((sistema.match(/\{ type: 'text' as const,/g) || []).length === 3, 'no hay bloques adicionales dentro de system')
  verificar((sistema.match(/cache_control: /g) || []).length === 2 && sistema.indexOf('cache_control: ', pC - iniSystem) < 0, "cache_control { type: 'ephemeral' } solo en A y B; C sin caché (2 de 4 puntos permitidos)")
  verificar((fuente.match(/cache_control: /g) || []).length === 2, 'route.ts no declara ningún otro cache_control (sin exceder el límite de 4)')
  verificar(interpolaciones(litA).length === 0, 'bloque A: ninguna interpolación (idéntico para todo docente, turno y conversación)')
  verificar(JSON.stringify(interpolaciones(litB)) === JSON.stringify(['${fuentesDisponiblesTexto}']), 'bloque B: su única interpolación es fuentesDisponiblesTexto')
  verificar(litC.startsWith('`FECHA Y HORA ACTUALES DEL SISTEMA') && interpolaciones(litC).some((i) => i.includes('horaLegible')), 'bloque C empieza en FECHA Y HORA (contiene la hora, por eso no se cachea)')
  verificar(litA.endsWith('\n\n`') && litB.endsWith('\n\n`'), 'los cortes caen en saltos de línea dobles ya existentes')

  // ===== 2. Equivalencia byte a byte con la cadena anterior =====
  console.log('\n— 2. Equivalencia exacta con el prompt anterior —')
  const pBase = base.indexOf('    system: `Eres Docente IA,')
  verificar(pBase > 0, `plantilla base encontrada (${BASE_REF.slice(0, 7)})`)
  const litBaseOriginal = literalDesde(base, pBase + '    system: '.length)
  const bloqueCitar = (s: string) => { const i = s.indexOf('CITAR LA FUENTE — '), f = i < 0 ? -1 : s.indexOf('\n\nMODO CONSULTA — aplica cuando', i); return i < 0 || f < 0 ? '' : s.slice(i, f) }
  const sha = (t: string) => createHash('sha256').update(t).digest('hex')
  const citarBase = bloqueCitar(litBaseOriginal), citarActual = bloqueCitar(litC)
  verificar(sha(citarBase) === HASH_CITAR_ANTERIOR && sha(citarActual) === HASH_CITAR_ACTUAL, `única diferencia admitida con la base: CITAR LA FUENTE anterior → atribución por evidencia (sha256 ${sha(citarActual).slice(0, 12)})`)
  // Cualquier otra diferencia con la plantilla base sigue fallando la equivalencia byte a byte.
  const litBase = citarBase && citarActual ? litBaseOriginal.replace(citarBase, () => citarActual) : litBaseOriginal
  const varianteFuentes = (img: boolean, datos: boolean, n = 2) => `\nFUENTES REALES ficticias — imagen=${img ? `sí(${n})` : 'no'} datos=${datos ? 'sí' : 'no'}\n`
  const fechaHora = (dia: string, hora: string) => ({ zonaHoraria: 'America/Ficticia', diaSemana: dia, fechaLegible: `${dia}-fecha-ficticia`, horaLegible: hora, cicloEscolar: '2099-2100' })
  const baseEnv = {
    fuentesDisponiblesTexto: varianteFuentes(false, true), infoFechaHora: fechaHora('lunes', '08:01'), contextoEnriquecido: 'DOCENTE_FICTICIO grupo 9Z, Alumna Ficticia Uno', contextoRAG: '\nRAG_FICTICIO',
    contextoProceso: '\nPROCESO_FICTICIO', esTurnoFichaDescriptiva: false, MARCO_CURRICULAR_VIGENTE: 'MARCO_FICTICIO', cicloEscolar: '2099-2100',
    bloqueVoz: '', bloqueConsultaOficial: '', bloqueModoImagen: '', bloqueDocumentoIlustrado: '', bloqueNivelEducativo: '', bloqueFechasExplicitas: '', bloqueTransformarTexto: '',
  }
  const matriz: [string, Record<string, unknown>][] = [
    ['base', baseEnv],
    ['otra hora', { ...baseEnv, infoFechaHora: fechaHora('martes', '17:59') }],
    ['otro docente/grupo', { ...baseEnv, contextoEnriquecido: 'OTRO_DOCENTE grupo 1A, Alumno Ficticio Dos' }],
    ['sin datos de módulo', { ...baseEnv, contextoEnriquecido: '', fuentesDisponiblesTexto: varianteFuentes(false, false) }],
    ['con 3 imágenes', { ...baseEnv, fuentesDisponiblesTexto: varianteFuentes(true, true, 3), bloqueModoImagen: '\nMODO_IMAGEN_FICTICIO' }],
    ['ficha descriptiva', { ...baseEnv, esTurnoFichaDescriptiva: true }],
    ['voz', { ...baseEnv, bloqueVoz: '\nVOZ_FICTICIA' }],
    ['consulta oficial', { ...baseEnv, bloqueConsultaOficial: '\nCONSULTA_FICTICIA' }],
    ['documento ilustrado + nivel + fechas + transformar', { ...baseEnv, bloqueDocumentoIlustrado: '\nILUSTRADO_FICTICIO', bloqueNivelEducativo: '\nNIVEL_FICTICIO', bloqueFechasExplicitas: '\nFECHAS_FICTICIO', bloqueTransformarTexto: '\nTRANSFORMAR_FICTICIO' }],
    ['proceso activo y sin RAG', { ...baseEnv, contextoProceso: '\nPROCESO_ACTIVO_FICTICIO', contextoRAG: '' }],
  ]
  const render = matriz.map(([n, env]) => {
    const anterior = renderizar(litBase, env)
    const a = renderizar(litA, env), b = renderizar(litB, env), c = renderizar(litC, env)
    return { n, env, anterior, a, b, c }
  })
  for (const r of render) verificar(r.a + r.b + r.c === r.anterior, `${r.n}: A + B + C === prompt anterior, byte a byte (${r.anterior.length} caracteres)`)
  const parrafos = (t: string) => t.split('\n\n').map((x) => x.trim()).filter(Boolean).sort()
  verificar(render.every((r) => JSON.stringify(parrafos(r.a + r.b + r.c)) === JSON.stringify(parrafos(r.anterior))), 'mismo conjunto de párrafos que antes: ninguna instrucción eliminada ni duplicada')

  // ===== 3. Estabilidad y ausencia de datos dinámicos =====
  console.log('\n— 3. Estabilidad de los bloques cacheables —')
  verificar(render.every((r) => r.a === render[0].a), 'bloque A idéntico en todos los contextos (hora, docente, grupo, imágenes, ficha, voz, consulta, proceso)')
  const porFuentes = new Map<string, Set<string>>()
  for (const r of render) { const k = String(r.env.fuentesDisponiblesTexto); if (!porFuentes.has(k)) porFuentes.set(k, new Set()); porFuentes.get(k)!.add(r.b) }
  verificar([...porFuentes.values()].every((s) => s.size === 1), `bloque B idéntico para una misma variante de fuentes (${porFuentes.size} variantes en la matriz)`)
  const dinamicos = ['DOCENTE_FICTICIO', 'OTRO_DOCENTE', 'Alumna Ficticia Uno', 'Alumno Ficticio Dos', 'America/Ficticia', '08:01', '17:59', 'fecha-ficticia', 'RAG_FICTICIO', 'PROCESO_', 'VOZ_FICTICIA', 'CONSULTA_FICTICIA', 'MODO_IMAGEN_FICTICIO', 'ILUSTRADO_FICTICIO', 'NIVEL_FICTICIO', 'FECHAS_FICTICIO', 'TRANSFORMAR_FICTICIO', 'MARCO_FICTICIO', 'undefined', '${']
  verificar(render.every((r) => dinamicos.every((d) => !r.a.includes(d) && !r.b.includes(d))), 'A y B no contienen ningún dato dinámico (docente, alumnos, fecha/hora, RAG, proceso, bloques condicionales, undefined)')
  verificar(render.some((r) => r.c !== render[0].c), 'el bloque C sí cambia entre contextos (correctamente fuera de la caché)')
  // Mínimo de Anthropic para Sonnet 4.6: 1 024 tokens. Cota conservadora: ≥ 4 caracteres por token.
  verificar(render[0].a.length >= 4 * 1024 && (render[0].a + render[0].b).length >= 4 * 1024, `bloques cacheables por encima del mínimo de 1 024 tokens (A=${render[0].a.length} car., A+B=${render[0].a.length + render[0].b.length} car.)`)

  // ===== 4. Mismas llamadas, P0/P0-B y telemetría =====
  console.log('\n— 4. Llamadas, P0/P0-B y telemetría —')
  verificar((fuente.match(/\n\s+system: /g) || []).length === 1, 'route.ts tiene una sola definición de system (parametrosClaude)')
  verificar(/client\.messages\.create\(\{ \.\.\.parametrosClaude, stream: false \}/.test(fuente) && /client\.messages\.create\(\{ \.\.\.parametrosClaude, stream: true \}/.test(fuente) && /client\.messages\.create\(\{\n\s+\.\.\.parametrosClaude,\n\s+messages: \[\n\s+\.\.\.parametrosClaude\.messages,/.test(fuente),
    'documento (sin streaming), streaming y continuación de registro_escolar usan la MISMA configuración (parametrosClaude)')
  verificar(/messages: \[\n\s+\.\.\.proyeccionSonnet\.historial,/.test(fuente) && /\$\{JSON\.stringify\(ctxPedagogico\.contextoAlumnoParaIA\)\}/.test(fuente) && /clasificarNivel0\(mensaje, sesion, proyeccionNivel0\.historial\.slice\(-4\)/.test(fuente),
    'P0 (bloque A de la ficha proyectado) y P0-B (historial protegido para Sonnet y Nivel 0) intactos')
  const fn = fuente.slice(fuente.indexOf('function registrarUsoIA('), fuente.indexOf('async function conReintento<T>'))
  const plantillaLog = fn.match(/console\.log\(`(\[IA_USO\][^`]*)`\)/)?.[1] ?? ''
  const asignaciones = ['entrada = n(uso?.input_tokens)', 'salida = n(uso?.output_tokens)', 'escritura = n(uso?.cache_creation_input_tokens)', 'lectura = n(uso?.cache_read_input_tokens)']
  verificar(plantillaLog !== '' && asignaciones.every((x) => fn.includes(`const ${x}\n`)) && interpolaciones('`' + plantillaLog + '`').every((i) => /^\$\{(destino|entrada|salida|escritura|lectura)\}$/.test(i)),
    'telemetría [IA_USO]: solo el destino (literal cerrado) y 4 conteos numéricos — nunca prompt ni contenido')
  verificar(/function registrarUsoIA\(destino: 'conversacion' \| 'documento' \| 'registro_escolar_continuacion'/.test(fuente) && (fuente.match(/registrarUsoIA\('(conversacion|documento|registro_escolar_continuacion)'/g) || []).length === 3,
    'telemetría registrada en los 3 caminos (conversación, documento, continuación)')
  const n = new Function('return ' + (fn.match(/const n = (\(v: unknown\) => [^\n]+)/)?.[1] ?? 'null').replace(': unknown', ''))() as ((v: unknown) => unknown) | null
  verificar(!!n && n(5) === 5 && n('texto') === 'na' && n(null) === 'na' && n(NaN) === 'na' && n({ a: 1 }) === 'na', 'el formateador de la telemetría solo deja pasar números finitos')

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
