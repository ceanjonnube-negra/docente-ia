// Verificación determinista del flujo de lista oficial del Chat IA
// (lib/listaOficial/flujoChatListaOficial.ts), sin red, sin IA real y sin
// base de datos: Supabase y Anthropic son dobles en memoria. El doble de
// Supabase falla ante cualquier escritura. Datos 100% ficticios.
// Uso: npx tsx scripts/verificar-lista-oficial-chat.ts

import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { esSolicitudListaOficial, mencionaListaOficial, extraerGrupoMencionado, resolverGrupoListaOficial, responderListaOficial } from '../lib/listaOficial/flujoChatListaOficial'

let fallos = 0
const chk = (c: boolean, m: string) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallos++ }

type Llamada = { tabla: string; operaciones: string[]; filtros: Array<[string, unknown]> }
function supabaseFalso(datos: { grupos?: unknown[]; inscripciones?: unknown[]; errorGrupos?: boolean; errorInscripciones?: boolean }) {
  const llamadas: Llamada[] = []
  const sb = {
    from(tabla: string) {
      const llamada: Llamada = { tabla, operaciones: [], filtros: [] }
      llamadas.push(llamada)
      const b: Record<string, unknown> = {}
      for (const op of ['select', 'order', 'limit']) b[op] = () => { llamada.operaciones.push(op); return b }
      b.eq = (col: string, val: unknown) => { llamada.operaciones.push('eq'); llamada.filtros.push([col, val]); return b }
      for (const op of ['insert', 'update', 'upsert', 'delete']) b[op] = () => { llamada.operaciones.push(op); throw new Error(`ESCRITURA PROHIBIDA: ${op} en ${tabla}`) }
      b.then = (resolver: (v: unknown) => unknown) => {
        if (tabla === 'grupos') return resolver(datos.errorGrupos ? { data: null, error: { message: 'x' } } : { data: datos.grupos ?? [], error: null })
        if (tabla === 'inscripciones') return resolver(datos.errorInscripciones ? { data: null, error: { message: 'x' } } : { data: datos.inscripciones ?? [], error: null })
        return resolver({ data: [], error: null })
      }
      return b
    },
    rpc() { throw new Error('RPC PROHIBIDA') },
  }
  return { sb: sb as unknown as SupabaseClient, llamadas }
}
function anthropicFalso(registros: unknown[] | 'error') {
  const estado = { llamadas: 0 }
  const cliente = { messages: { create: async () => {
    estado.llamadas++
    if (registros === 'error') throw new Error('falla simulada')
    return { content: [{ type: 'text', text: JSON.stringify({ registros }) }] }
  } } }
  return { anthropic: cliente as unknown as Anthropic, estado }
}

const DOCENTE = 'd0000000-0000-4000-8000-000000000001'
const G4B = { id: 'g4b00000-0000-4000-8000-000000000001', grado: '4', grupo: 'B', activo: true }
const G3A = { id: 'g3a00000-0000-4000-8000-000000000001', grado: '3', grupo: 'A', activo: true }
const G2C_INACTIVO = { id: 'g2c00000-0000-4000-8000-000000000001', grado: '2', grupo: 'C', activo: false }
const inscripciones = [
  { alumnos: { id: 'a0000000-0000-4000-8000-000000000001', nombre: 'Ana Ficticia Uno', curp: 'FIUA150101MDFCNN01', sexo: 'M', fecha_nacimiento: null } },
  { alumnos: { id: 'a0000000-0000-4000-8000-000000000002', nombre: 'Beto Ficticio Dos', curp: null, sexo: 'H', fecha_nacimiento: null } },
  { alumnos: { id: 'a0000000-0000-4000-8000-000000000003', nombre: 'Carla Ficticia Tres', curp: 'FITC150505MJCCRR02', sexo: 'M', fecha_nacimiento: null } },
  { alumnos: { id: 'a0000000-0000-4000-8000-000000000004', nombre: 'Dani Ficticio Cuatro', curp: 'FICD150707HDFCNN04', sexo: 'H', fecha_nacimiento: null } },
]
const reg = (nombre: string | null, curp: string | null, conf: 'alta' | 'media' | 'baja' = 'alta') => ({ nombreLeido: nombre, nombreConfianza: conf, curpLeida: curp, curpLegible: curp !== null, curpConfianza: conf })
const FOTO = [{ base64: 'iVBORw0KGgo=', tipo: 'image/png' }]

;(async () => {
  console.log('— Reconocimiento de la solicitud')
  const si = ['Actualiza mi lista oficial', 'Actualiza la lista oficial de mi grupo 4.º B con esta fotografía.', 'Compara esta lista con mis alumnos', 'Revisa la lista oficial de mi grupo 3°A', 'Actualiza la lista de mis alumnos con esta foto']
  const no = ['¿Qué es la lista oficial?', 'Pasa lista de hoy', 'Hazme una lista de útiles en Word', 'Revisa la lista de asistencia de mis alumnos', 'Genera una imagen de la lista']
  chk(si.every(esSolicitudListaOficial), 'reconoce las peticiones de actualizar/comparar/revisar la lista')
  chk(no.every((m) => !esSolicitudListaOficial(m)), 'no se activa con preguntas, pase de lista, documentos, asistencia ni imágenes generadas')
  chk(mencionaListaOficial('Actualiza mi lista oficial') && !mencionaListaOficial('Compara esta lista con mis alumnos'), 'sin foto, solo se atiende si nombra la lista oficial')
  chk(JSON.stringify(extraerGrupoMencionado('mi grupo 4.º B')) === '{"grado":"4","letra":"B"}' && JSON.stringify(extraerGrupoMencionado('grupo 3°A')) === '{"grado":"3","letra":"A"}' && extraerGrupoMencionado('Actualiza mi lista oficial') === null, 'extrae el grupo mencionado (4.º B, 3°A) y no inventa uno')

  console.log('— Resolución del grupo')
  let s = supabaseFalso({ grupos: [G4B] }); let r = await resolverGrupoListaOficial(s.sb, DOCENTE, 'Actualiza mi lista oficial')
  chk(r.ok && r.grupo.id === G4B.id, 'un solo grupo vigente: se usa ese')
  chk(s.llamadas[0].tabla === 'grupos' && s.llamadas[0].filtros.some(([c, v]) => c === 'docente_id' && v === DOCENTE) && s.llamadas[0].filtros.some(([c, v]) => c === 'ciclos_escolares.activo' && v === true), 'consulta solo grupos del docente con ciclo activo')
  s = supabaseFalso({ grupos: [G4B, G3A] }); r = await resolverGrupoListaOficial(s.sb, DOCENTE, 'Actualiza mi lista oficial')
  chk(!r.ok && r.motivo === 'ambiguo' && r.opciones.join(',') === '3.º A,4.º B', 'varios grupos sin mencionar cuál: ambiguo, ofrece opciones')
  r = await resolverGrupoListaOficial(s.sb, DOCENTE, 'Actualiza la lista oficial de mi grupo 4.º B')
  chk(r.ok && r.grupo.id === G4B.id, 'varios grupos y el mensaje nombra 4.º B: se usa exactamente ese')
  r = await resolverGrupoListaOficial(s.sb, DOCENTE, 'Actualiza la lista oficial de mi grupo 5.º C')
  chk(!r.ok && r.motivo === 'no_encontrado', 'nombra un grupo que no es suyo o no está vigente: no se usa otro en su lugar')
  s = supabaseFalso({ grupos: [G4B] }); r = await resolverGrupoListaOficial(s.sb, DOCENTE, 'Actualiza la lista oficial de mi grupo 3.º A')
  chk(!r.ok && r.motivo === 'no_encontrado', 'un solo grupo vigente pero el mensaje nombra otro: no se compara')
  s = supabaseFalso({ grupos: [G2C_INACTIVO] }); r = await resolverGrupoListaOficial(s.sb, DOCENTE, 'Actualiza mi lista oficial')
  chk(!r.ok && r.motivo === 'sin_grupo', 'un grupo marcado inactivo no cuenta como vigente')
  s = supabaseFalso({ errorGrupos: true }); r = await resolverGrupoListaOficial(s.sb, DOCENTE, 'Actualiza mi lista oficial')
  chk(!r.ok && r.motivo === 'error', 'error al consultar grupos: no se supone ninguno')

  console.log('— Flujo completo (dobles en memoria)')
  const registros = [
    reg('Ana Ficticia Uno', 'FIUA150101MDFCNN01'),
    reg('Beto Ficticio Dos', 'FIDB150303HDFCTT05'),
    reg('Carla Ficticia Tres', 'FITC150505MJCCRR09'),
    reg('Eva Ficticia Nueva', 'FINE150909MDFCVV06'),
    reg('Fito Ilegible', 'FIXX15', 'baja'),
  ]
  const logs: string[] = []; const logOriginal = console.log; const errOriginal = console.error
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')) }; console.error = (...a: unknown[]) => { logs.push(a.join(' ')) }
  const ia = anthropicFalso(registros); s = supabaseFalso({ grupos: [G4B], inscripciones })
  const texto = await responderListaOficial({ anthropic: ia.anthropic, sb: s.sb, docenteId: DOCENTE, mensaje: 'Actualiza mi lista oficial', fotos: FOTO, esPdf: false })
  const iaAmb = anthropicFalso(registros); const sAmb = supabaseFalso({ grupos: [G4B, G3A], inscripciones })
  const textoAmb = await responderListaOficial({ anthropic: iaAmb.anthropic, sb: sAmb.sb, docenteId: DOCENTE, mensaje: 'Actualiza mi lista oficial', fotos: FOTO, esPdf: false })
  console.log = logOriginal; console.error = errOriginal
  console.log(texto.split('\n').map((l) => `    | ${l}`).join('\n'))
  chk(ia.estado.llamadas === 1, 'una sola llamada de IA (la extracción); comparar y presentar no llaman a la IA')
  chk(s.llamadas.every((l) => l.operaciones.every((o) => ['select', 'eq', 'order', 'limit'].includes(o))), 'solo lecturas en Supabase: ninguna escritura ni RPC')
  const ins = s.llamadas.find((l) => l.tabla === 'inscripciones')
  chk(!!ins && ins.filtros.some(([c, v]) => c === 'grupo_id' && v === G4B.id) && ins.filtros.some(([c, v]) => c === 'estatus' && v === 'activo'), 'la lista actual se lee del grupo resuelto (inscripciones activas)')
  chk(texto.includes('grupo 4.º B') && texto.includes('no guardé ni cambié nada'), 'identifica el grupo y aclara que no guardó nada')
  chk(/Coinciden con tu lista: 2\./.test(texto), 'cuenta las coincidencias')
  chk(texto.includes('CURP que faltan en tu lista y se leyeron con claridad (1)') && texto.includes('Beto Ficticio Dos: FIDB150303HDFCTT05'), 'muestra la CURP faltante que se leyó con claridad')
  chk(texto.includes('CURP distinta a la registrada (1)') && texto.includes('en tu lista FITC150505MJCCRR02, en la foto FITC150505MJCCRR09'), 'muestra la CURP distinta sin elegir por el docente')
  chk(texto.includes('Posibles altas (no están en tu lista) (1)') && texto.includes('Eva Ficticia Nueva'), 'muestra la posible alta')
  chk(/Lecturas dudosas \(1\)|Coincidencias que no pude decidir \(1\)/.test(texto) && texto.includes('Fito Ilegible'), 'la lectura de baja confianza queda como duda')
  chk(texto.includes('no aparecen en las fotos (1)') && texto.includes('Dani Ficticio Cuatro') && texto.includes('no significa que sean bajas'), 'el alumno ausente se reporta sin tratarlo como baja')
  chk(!/confirm|botón|guardar cambios|aplicar/i.test(texto.replace('Podrás confirmarlas en una siguiente versión; por ahora no se guardan.', '')), 'no ofrece confirmar ni aplicar cambios')
  const datosPersonales = ['Ana Ficticia', 'Beto Ficticio', 'Carla Ficticia', 'Dani Ficticio', 'Eva Ficticia', 'Fito Ilegible', 'FIUA15', 'FIDB15', 'FITC15', 'FICD15', 'FINE15']
  chk(logs.length > 0 && logs.every((l) => !datosPersonales.some((d) => l.includes(d))), `los logs (${logs.length}) no contienen nombres ni CURP`)
  chk(iaAmb.estado.llamadas === 0 && !sAmb.llamadas.some((l) => l.tabla === 'inscripciones') && textoAmb.includes('varios grupos vigentes'), 'grupo ambiguo: no llama a la IA ni lee alumnos; pregunta de qué grupo es')

  console.log('— Casos sin comparación')
  const casos: Array<[string, Parameters<typeof responderListaOficial>[0], RegExp]> = [
    ['PDF', { anthropic: anthropicFalso([]).anthropic, sb: supabaseFalso({ grupos: [G4B] }).sb, docenteId: DOCENTE, mensaje: 'Actualiza mi lista oficial', fotos: [], esPdf: true }, /a partir de fotografías/],
    ['sin fotos', { anthropic: anthropicFalso([]).anthropic, sb: supabaseFalso({ grupos: [G4B] }).sb, docenteId: DOCENTE, mensaje: 'Actualiza mi lista oficial', fotos: [], esPdf: false }, /necesito una o varias fotos/],
    ['5 fotos', { anthropic: anthropicFalso([]).anthropic, sb: supabaseFalso({ grupos: [G4B] }).sb, docenteId: DOCENTE, mensaje: 'Actualiza mi lista oficial', fotos: Array(5).fill(FOTO[0]), esPdf: false }, /máximo 4/],
    ['IA falla', { anthropic: anthropicFalso('error').anthropic, sb: supabaseFalso({ grupos: [G4B], inscripciones }).sb, docenteId: DOCENTE, mensaje: 'Actualiza mi lista oficial', fotos: FOTO, esPdf: false }, /No pude leer la lista/],
    ['sin registros', { anthropic: anthropicFalso([]).anthropic, sb: supabaseFalso({ grupos: [G4B], inscripciones }).sb, docenteId: DOCENTE, mensaje: 'Actualiza mi lista oficial', fotos: FOTO, esPdf: false }, /ningún registro legible/],
    ['roster falla', { anthropic: anthropicFalso(registros).anthropic, sb: supabaseFalso({ grupos: [G4B], errorInscripciones: true }).sb, docenteId: DOCENTE, mensaje: 'Actualiza mi lista oficial', fotos: FOTO, esPdf: false }, /No pude leer la lista de tu grupo/],
  ]
  console.log = () => {}; console.error = () => {}
  const salidas: string[] = []
  for (const [, p] of casos) salidas.push(await responderListaOficial(p))
  console.log = logOriginal; console.error = errOriginal
  casos.forEach(([n, , rx], i) => chk(rx.test(salidas[i]), `${n}: mensaje claro sin comparar`))

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
})()
