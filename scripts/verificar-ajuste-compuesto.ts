// Hito 2, etapa 3c — solicitudes compuestas (cambio + archivo), edición
// desde el documento activo y limpieza. Sin red ni IA.
//   npx tsx scripts/verificar-ajuste-compuesto.ts

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ETIQUETA_AJUSTE,
  anotarFormatoDelAjuste,
  construirBorradorAjustado,
  contextoParaAjuste,
  estructuraDesdeResumen,
  formatoPedido,
  huellaBorrador,
  sinPeticionDeFormato,
  soloPideFormato,
  type BaseAjuste,
} from '../lib/planeacion/modificarPlaneacion'
import { pideModificar } from '../lib/planeacion/consultaPlaneaciones'
import { extraerResumenBorrador } from '../lib/planeacion/extraerBorrador'
import type { Planeacion } from '../lib/planeacion/tipos'

let fallos = 0
function verificar(condicion: boolean, nombre: string) {
  if (condicion) console.log(`✓ ${nombre}`)
  else { fallos++; console.log(`✗ ${nombre}`) }
}

const BASE_TEXTO = [
  '📋 PLANEACIÓN DIDÁCTICA\nFase: Fase 4\nCampo Formativo: Lenguajes\nProyecto Didáctico: Cuentos propios\nDuración: 3 días',
  '🎯 PROPÓSITO GENERAL\nQue el grupo escriba cuentos propios.',
  '📌 CONTENIDOS Y PDA DE ESTA PLANEACIÓN\nContenido:\n- Comprensión y producción de cuentos.\nPDA de referencia:\n- Escribe cuentos con secuencia causal.',
  '🧰 MATERIALES\n- Hojas\n- Colores',
  '📅 DÍA 1 — Leemos cuentos\n🔹 Inicio (15 min)\nLectura en voz alta.\n📌 Evaluación: participación oral.',
  '📅 DÍA 2 — Planeamos\n🔹 Inicio (15 min)\nLluvia de ideas.\n📌 Evaluación: plan escrito.',
  '📅 DÍA 3 — Escribimos\n🔹 Inicio (15 min)\nEscritura del borrador.\n📌 Evaluación: borrador completo.',
  '🎓 PRODUCTO FINAL\nCuento ilustrado.',
].join('\n\n')
const RESUMEN = ['📎 RESUMEN PARA GUARDAR', 'Nombre: Cuentos propios', 'Fecha de inicio: 2026-11-24', 'Fecha de fin: 2026-11-26', 'Duración: 3 días', 'Propósito: Que el grupo escriba cuentos propios.',
  'Campos formativos: Lenguajes', 'Contenidos: Comprensión y producción de cuentos.', 'PDA: Escribe cuentos con secuencia causal.', 'Ejes articuladores: Apropiación de las culturas', 'Metodología: Proyectos',
  'Producto final: Cuento ilustrado.', 'Secuencia didáctica: Día 1: Leemos; Día 2: Planeamos; Día 3: Escribimos', 'Recursos: Hojas; Colores', 'Evidencias: Plan; Borrador', 'Indicadores de evaluación: Identifica partes del cuento; Escribe con secuencia'].join('\n')
const ESTRUCTURA = extraerResumenBorrador([{ role: 'assistant', content: `${BASE_TEXTO}\n\n${RESUMEN}` }])!
const PLANEACION = { id: 'pl-1', nombre: 'Cuentos propios', version: 3, grupo_id: 'g-1' } as Planeacion
const BASE: BaseAjuste = { planeacion: PLANEACION, numero: 3, contenido: BASE_TEXTO, estructura: estructuraDesdeResumen(ESTRUCTURA), trazabilidad: null }

async function main() {
  // 1. Solicitudes compuestas: el cambio prevalece y el formato se separa.
  {
    const casos: [string, string, 'word' | 'pdf'][] = [
      ['Cámbiale la sesión 2 y dámela en Word', 'Cámbiale la sesión 2', 'word'],
      ['Reduce las actividades y pásala a PDF', 'Reduce las actividades', 'pdf'],
      ['Hazla más dinámica y guárdala en Word', 'Hazla más dinámica', 'word'],
      ['Agrega una salida al patio, en PDF', 'Agrega una salida al patio', 'pdf'],
    ]
    const ok = casos.every(([m, instruccion, formato]) => formatoPedido(m) === formato && sinPeticionDeFormato(m) === instruccion && pideModificar(sinPeticionDeFormato(m)) && !soloPideFormato(m))
    verificar(ok, '1a. "…y dámela en Word", "…y pásala a PDF", "…y guárdala en Word": se reconoce el cambio y el formato por separado')
    verificar(soloPideFormato('Pásala a Word') && soloPideFormato('dámela en PDF por favor') && !soloPideFormato('Hazme un citatorio en Word') && formatoPedido('Cámbiale la sesión 2') === null,
      '1b. Solo el archivo ("pásala a Word") se distingue de un cambio o de otro documento')
  }

  // 2. El borrador ajustado conserva la intención del formato sin entregar archivo ni mencionar etapas.
  {
    const r = construirBorradorAjustado({ textoModelo: `${BASE_TEXTO.replace('Lluvia de ideas.', 'Lluvia de ideas con tarjetas.')}\n\n${RESUMEN}`, base: BASE, instruccion: 'Cámbiale la sesión 2', formato: 'word' })!
    verificar(r.textoFinal.includes('Tomé nota de que lo quieres en Word: primero revisa el ajuste y apruébalo.') && !/etapa/i.test(r.textoFinal) && !r.textoFinal.includes('[[DOCUMENTO_ARCHIVO'),
      '2. El borrador se presenta para aprobación con la nota del formato (sin archivo ni etapas técnicas)')
  }

  // 3. Metadata del formato sobre el ajuste registrado.
  {
    const conv: Record<string, unknown> = { planeacion_activa: { esquema: 'referencia-planeacion-v1', planeacionId: 'pl-1', numero: 3, opciones: [], ajustes: [{ planeacionId: 'pl-1', versionBase: 3, grupoId: 'g-1', huella: 'h-1', creadoEn: 'x' }, { planeacionId: 'pl-1', versionBase: 3, grupoId: 'g-1', huella: 'h-2', creadoEn: 'x' }] } }
    const sb = { from: () => {
      let cambios: Record<string, unknown> | null = null
      const q = { select: () => q, eq: () => q, update: (d: Record<string, unknown>) => { cambios = d; return q }, maybeSingle: async () => ({ data: JSON.parse(JSON.stringify(conv)), error: null }),
        then: (ok: (r: unknown) => unknown) => { if (cambios) Object.assign(conv, cambios); return Promise.resolve({ error: null }).then(ok) } }
      return q
    } } as unknown as SupabaseClient
    await anotarFormatoDelAjuste(sb, 'conv-1', 'h-2', 'pdf')
    const ajustes = (conv.planeacion_activa as { ajustes: { huella: string; formatoSolicitado?: string }[]; planeacionId: string }).ajustes
    verificar(ajustes[1].formatoSolicitado === 'pdf' && ajustes[0].formatoSolicitado === undefined && (conv.planeacion_activa as { planeacionId: string }).planeacionId === 'pl-1',
      '3. "Pásala a PDF" sobre un ajuste no aprobado: el formato queda en la metadata de ESE borrador, sin tocar la referencia')
  }

  // 4. Continuación desde el documento activo: la referencia del modelo es el último borrador confiable.
  {
    const previo = `${BASE_TEXTO.replace('Lluvia de ideas.', 'Lluvia de ideas con tarjetas.')}\n\n${RESUMEN}\n${ETIQUETA_AJUSTE}: «Cuentos propios», versión 3`
    const c = contextoParaAjuste(BASE, 'agrega una lectura al día 3', { contenido: previo, estructura: estructuraDesdeResumen(extraerResumenBorrador([{ role: 'assistant', content: previo }])!) })
    verificar(c.includes('BORRADOR DE AJUSTE EN CURSO (sobre la versión 3; conserva sus cambios):') && c.includes('Lluvia de ideas con tarjetas.') && !c.includes('PLANEACIÓN VIGENTE'),
      '4. Seguir corrigiendo: el modelo parte del último borrador confiable (cambios acumulados), con la versión base como referencia')
    verificar(huellaBorrador(previo) === huellaBorrador(`${previo}\n\nCambios respecto a la versión 3: Día 2. ¿Quieres corregir algo más? Si está bien, dime «apruébala» y la guardo como versión 4.`), '4b. La identidad del borrador no depende del mensaje de cierre')
  }

  // 5. Ruta (estático): sin archivos prematuros ni texto del cliente como fuente; identidad protegida.
  {
    const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
    const iGuard = ruta.indexOf("if (decision === 'ajuste') {")
    const iOriginal = ruta.indexOf('if (formatoOriginal && !ajusteDesdeEdicion) {')
    verificar(iGuard > 0 && iGuard < iOriginal && ruta.includes("formatoDelAjuste = formatoOriginal\n      } else if (decision === 'consulta'") && ruta.includes(": formatoOriginal && pideModificar(sinPeticionDeFormato(instruccion)) ? 'ajuste' : 'archivo'"),
      '5a. Cambio + formato sobre la planeación consultada: ajuste antes de entregar el original (nunca el original ignorando el cambio)')
    const iTemprana = ruta.indexOf('if (!borradorNuevo && (mostrada || /\\bplaneaci[oó]n(es)?\\b/i.test(String(mensaje ?? \'\')))) formatoDelAjuste = formatoOriginal')
    const iPipeline = ruta.indexOf('if (supabaseUser && userId && tipoHerramientaSolicitado && !esEdicionDocumento && !formatoDelAjuste) {')
    verificar(iTemprana > 0 && iPipeline > iTemprana && ruta.includes('if (supabaseUser && userId && tipoHerramientaSolicitado && !ajusteDelTurno && !formatoDelAjuste && !continuacionAjuste) {')
      && ruta.includes('!esEdicionDocumento && !formatoDelAjuste && !continuacionAjuste &&'),
      '5b. Sin documento activo: la solicitud compuesta sobre una planeación guardada se reconoce antes del pipeline de archivos (sin IA ni sesión extra); ni conversión, ni CASO 3, ni lista generan archivo')
    verificar(ruta.includes('if (resolucion?.tipo === \'texto\' && formatoDelAjuste) await anotarFormatoPendiente(supabaseUser, conversacionAjuste, formatoDelAjuste)') && ruta.includes('mensaje: formatoDelAjuste ? sinPeticionDeFormato(String(mensaje ?? \'\')) : String(mensaje ?? \'\')') && ruta.includes('formato: formatoDelAjuste ?? resolucion.formato ?? null'),
      '5c. Si hay que aclarar la planeación, el formato queda pendiente junto con la instrucción')
    verificar(ruta.includes('const origen = ajustePublicable(previoAjuste,') && ruta.includes('if (!origen) return respuestaTexto(MENSAJE_AJUSTE_SIN_IDENTIDAD)') && ruta.includes('mensajeConDocumento = continuacionAjuste.instruccion')
      && ruta.includes('referencia: { contenido: previo, estructura: estructuraDesdeResumen(resumenPrevio) }') && ruta.includes('formatoSolicitado: formatoAjuste'),
      '5d. Documento activo de un ajuste: identidad solo por metadata (si falta, no se continúa), el modelo recibe solo la instrucción y la metadata conserva el formato')
    verificar(ruta.includes('if ((formatoDelAjuste || continuacionAjuste || ajusteDesdeEdicion) && !ajusteDelTurno) {'), '5e. Si el ajuste no se puede resolver, se dice (nunca cae en convertir el texto del cliente)')
    verificar(ruta.includes('Este ajuste todavía no está guardado. Revísalo y, si está bien, dime «apruébala»') && !/etapa \d|etapa 4|en la etapa/i.test(ruta.slice(ruta.indexOf('Este ajuste todavía no está guardado'), ruta.indexOf('Este ajuste todavía no está guardado') + 250)),
      '5f. "Pásala a Word" de un ajuste no aprobado: pide aprobarlo, sin mencionar etapas técnicas')
  }

  // 6. Limpieza: sin consumidores de los mensajes retirados.
  {
    const archivos: string[] = []
    const recorrer = (d: string) => { for (const n of readdirSync(d)) { const r = join(d, n); if (statSync(r).isDirectory()) { if (n !== 'node_modules' && !n.startsWith('.')) recorrer(r) } else if (/\.(ts|tsx)$/.test(n)) archivos.push(r) } }
    for (const d of ['app', 'lib', 'components']) { try { recorrer(join(__dirname, '..', d)) } catch { /* carpeta ausente */ } }
    const restos = archivos.filter((a) => /mensajeModificacionNoDisponible|MENSAJE_MODIFICAR_NO_DISPONIBLE|aún no habilitada|Modificarla todavía/.test(readFileSync(a, 'utf-8')))
    verificar(restos.length === 0, `6. Mensajes y comentarios del bloqueo anterior retirados (restos: ${restos.length})`)
  }

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
