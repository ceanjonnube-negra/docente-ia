// Hito 2, etapa 3 — publicación de una versión N+1 con protección de la
// evaluación (orquestación en TypeScript) y captura solo sobre la hoja
// vigente. La lógica transaccional se valida en PostgreSQL local con la
// migración 20261127000000; aquí, la orquestación, los reintentos, el PDF
// recuperable y que ninguna ruta de captura escriba sin condicionar a la hoja.
//   npx tsx scripts/verificar-publicar-version-hoja.ts

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { avisoEvaluacionDeVersion, indicadoresHojaDeVersion, publicarVersionPlaneacion } from '../lib/planeacion/publicarVersion'
import { actualizarCapturaSobreHoja, esHojaReemplazadaDelProyecto, mensajeHojaReemplazadaImpresa } from '../lib/seguimiento/capturaHojaVigente'

let fallos = 0
function verificar(condicion: boolean, nombre: string) {
  if (condicion) console.log(`✓ ${nombre}`)
  else { fallos++; console.log(`✗ ${nombre}`) }
}

type Fila = Record<string, unknown>
// Cliente falso: rpc con respuestas en cola; tablas con eq/is/not y update condicional.
function cliente(respuestas: unknown[], tablas: Record<string, Fila[]> = {}) {
  const llamadas: Record<string, unknown>[] = []
  const sb = {
    rpc: async (_n: string, args: Record<string, unknown>) => { llamadas.push(args); return { data: respuestas.shift(), error: null } },
    from: (tabla: string) => {
      const filtros: ((f: Fila) => boolean)[] = []
      let cambios: Fila | null = null
      const filas = () => (tablas[tabla] ?? []).filter((f) => filtros.every((g) => g(f)))
      const q = {
        select: () => q,
        update: (d: Fila) => { cambios = d; return q },
        eq: (c: string, v: unknown) => { filtros.push((f) => f[c] === v); return q },
        is: (c: string, v: unknown) => { filtros.push((f) => (v === null ? f[c] == null : f[c] === v)); return q },
        not: (c: string, _op: string, v: unknown) => { filtros.push((f) => (v === null ? f[c] != null : f[c] !== v)); return q },
        maybeSingle: () => Promise.resolve({ data: filas()[0] ?? null, error: null }),
        then: (ok: (r: unknown) => unknown) => {
          const afectadas = filas()
          if (cambios) afectadas.forEach((f) => Object.assign(f, cambios))
          return Promise.resolve({ data: afectadas, error: null }).then(ok)
        },
      }
      return q
    },
  } as unknown as SupabaseClient
  return { sb, llamadas }
}

const ENTRADA = {
  planeacionId: 'pl-1', versionBase: 1, borradorClave: 'msg:conv:m2', contenido: 'V2', estructura: { planeacion: {} }, trazabilidad: null,
  resumen: { indicadores: ['Uno', 'Dos', 'Tres', 'Cuatro', 'Cinco', 'Seis'] },
}

async function main() {
  // 1. Indicadores congelados de la versión: los mismos de la primera aprobación, numerados (máximo 5).
  const ind = indicadoresHojaDeVersion(ENTRADA.resumen)
  verificar(ind.length === 5 && ind.every((x, i) => x.numero_indicador === i + 1 && x.aspecto_general === 'logro_aprendizaje') && ind[0].indicador_especifico === 'Uno',
    '1. Indicadores de la hoja de la versión: mismos que en la primera aprobación (máximo 5), numerados 1..n')

  // 2. Código de hoja ocupado → reintenta con otro; luego conservada (sin PDF que completar).
  {
    let completadas = 0
    const { sb, llamadas } = cliente([{ estado: 'identificador_ocupado' }, { estado: 'publicada', numero: 2, version_id: 'v2', hoja: { estado: 'conservada', id: 'h1' } }])
    const r = await publicarVersionPlaneacion(sb, ENTRADA, async () => { completadas++; return true })
    verificar(r.estado === 'publicada' && llamadas.length === 2 && llamadas[0].p_identificador_hoja !== llamadas[1].p_identificador_hoja && /^SG-[A-Z2-9]{4}$/.test(String(llamadas[1].p_identificador_hoja)),
      '2a. Código de hoja ya usado → reintenta con un código NUEVO (nunca reutiliza el anterior)')
    verificar(completadas === 0 && r.pdfHoja === undefined && avisoEvaluacionDeVersion(r) === null, '2b. Hoja conservada: no se genera ningún PDF ni hay aviso')
  }

  // 3. Hoja reemplazada → se completa el PDF de la vigente; si falla, queda pendiente (recuperable).
  {
    const tablas = { hojas_evaluacion: [{ id: 'h2', proyecto_id: 'ps-1' }] }
    const pedidos: string[] = []
    const { sb } = cliente([{ estado: 'publicada', numero: 3, hoja: { estado: 'reemplazada', id: 'h2', anterior_id: 'h1' } }], tablas)
    const r = await publicarVersionPlaneacion(sb, ENTRADA, async (ps) => { pedidos.push(ps); return true })
    verificar(r.hoja?.estado === 'reemplazada' && r.hoja.anteriorId === 'h1' && pedidos.join() === 'ps-1' && r.pdfHoja === 'listo',
      '3a. Hoja reemplazada: después de la transacción se completa el PDF de la vigente de ESE proyecto')
    verificar(avisoEvaluacionDeVersion(r, 'SG-NVA2') === 'Como cambiaron los indicadores, la hoja de evaluación se actualizó (SG-NVA2). Usa la nueva; la anterior queda solo para consulta.', '3b. Aviso discreto al docente con el código nuevo')
    const { sb: sb2 } = cliente([{ estado: 'publicada', numero: 3, hoja: { estado: 'reemplazada', id: 'h2' } }], { hojas_evaluacion: [{ id: 'h2', proyecto_id: 'ps-1' }] })
    const r2 = await publicarVersionPlaneacion(sb2, ENTRADA, async () => { throw new Error('Storage caído') })
    verificar(r2.estado === 'publicada' && r2.pdfHoja === 'pendiente' && !!avisoEvaluacionDeVersion(r2)?.includes('se terminará de generar'),
      '3c. Si el PDF falla, la versión queda publicada y la hoja PENDIENTE (se completa después con el mismo generador, sin crear otra)')
  }

  // 4. Evaluación protegida: aviso de criterios originales; nada que generar.
  {
    let completadas = 0
    const { sb } = cliente([{ estado: 'publicada', numero: 4, hoja: { estado: 'evaluacion_protegida', id: 'h1' } }])
    const r = await publicarVersionPlaneacion(sb, ENTRADA, async () => { completadas++; return true })
    verificar(completadas === 0 && avisoEvaluacionDeVersion(r) === 'La evaluación de este proyecto ya tiene capturas o resultados: se conserva con sus criterios originales y la hoja no cambia.',
      '4. Evaluación protegida: no se genera nada y se informa que se conservan sus criterios originales')
  }

  // 5. Captura condicionada a la hoja vigente.
  {
    const tablas: Record<string, Fila[]> = {
      proyectos_seguimiento: [{ id: 'ps-1', hoja_id: 'h2', estado: 'hoja_generada' }],
      hojas_evaluacion: [{ id: 'h1', proyecto_id: 'ps-1', identificador_visible: 'SG-VJA2', reemplazada_por: 'h2' }, { id: 'h2', proyecto_id: 'ps-1', identificador_visible: 'SG-NVA2', reemplazada_por: null }],
    }
    const { sb } = cliente([], tablas)
    const sobreVieja = await actualizarCapturaSobreHoja(sb, 'ps-1', 'h1', { estado: 'fotografia_cargada' })
    verificar(sobreVieja === 'hoja_cambiada' && tablas.proyectos_seguimiento[0].estado === 'hoja_generada', '5a. Una operación iniciada sobre la hoja reemplazada no escribe nada (hoja_cambiada)')
    const sobreVigente = await actualizarCapturaSobreHoja(sb, 'ps-1', 'h2', { estado: 'fotografia_cargada' })
    verificar(sobreVigente === 'ok' && tablas.proyectos_seguimiento[0].estado === 'fotografia_cargada', '5b. Sobre la hoja vigente, escribe normalmente')
    verificar(await esHojaReemplazadaDelProyecto(sb, 'ps-1', 'SG-VJA2') && !(await esHojaReemplazadaDelProyecto(sb, 'ps-1', 'SG-NVA2')) && !(await esHojaReemplazadaDelProyecto(sb, 'ps-otro', 'SG-VJA2')),
      '5c. Reconoce una hoja impresa reemplazada del MISMO proyecto (nunca la vigente ni de otro proyecto)')
    verificar(mensajeHojaReemplazadaImpresa('SG-VJA2', 'SG-NVA2').includes('SG-VJA2') && mensajeHojaReemplazadaImpresa('SG-VJA2', 'SG-NVA2').includes('SG-NVA2'), '5d. El mensaje distingue la hoja anterior de la vigente')
  }

  // 6. Ninguna ruta de captura o corrección escribe en el proyecto sin condicionar a su hoja.
  {
    const base = join(__dirname, '..', 'app', 'api', 'proyectos-seguimiento', '[id]')
    const rutas = readdirSync(base).filter((r) => ['foto-hoja', 'analizar-hoja', 'revisar-hoja', 'corregir-celda', 'confirmar-hoja'].includes(r))
    const sinCondicion = rutas.filter((r) => /\.from\('proyectos_seguimiento'\)\s*\n\s*\.update\(/.test(readFileSync(join(base, r, 'route.ts'), 'utf-8')))
    const conCondicion = ['foto-hoja', 'analizar-hoja', 'corregir-celda'].every((r) => readFileSync(join(base, r, 'route.ts'), 'utf-8').includes('actualizarCapturaSobreHoja(supabase, proyectoId, proyecto.hoja_id'))
    const leenVigente = ['foto-hoja', 'analizar-hoja', 'revisar-hoja', 'confirmar-hoja'].every((r) => /\.eq\('id', proyecto\.hoja_id\)\s*\n\s*\.is\('reemplazada_por', null\)/.test(readFileSync(join(base, r, 'route.ts'), 'utf-8')))
    const confirmar = readFileSync(join(base, 'confirmar-hoja', 'route.ts'), 'utf-8')
    verificar(rutas.length === 5 && sinCondicion.length === 0 && conCondicion && leenVigente && confirmar.includes("supabase.rpc('confirmar_resultados_hoja'") && !confirmar.includes(".from('seguimiento_resultados')"),
      '6. Captura y corrección: toda escritura condicionada a la hoja vigente; la confirmación es la RPC atómica')
    const analizar = readFileSync(join(base, 'analizar-hoja', 'route.ts'), 'utf-8')
    verificar(analizar.includes('esHojaReemplazadaDelProyecto(supabase, proyectoId, observado)') && analizar.includes("razon: 'hoja_reemplazada'"), '6b. Una foto de una hoja reemplazada se explica y se rechaza')
    const chat = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
    verificar(chat.includes("...(hoja.proyectoSeguimientoId ? { proyectoSeguimientoId: hoja.proyectoSeguimientoId } : {})") && chat.includes("hoja.reemplazada ? '-reemplazada' : ''"),
      '6c. Al recuperar una versión con hoja reemplazada, su tarjeta no habilita captura (sin proyecto) y se marca como reemplazada')
  }

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
