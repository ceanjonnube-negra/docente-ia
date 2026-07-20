// scripts/verificar-analisis-calendario.ts
//
// Prueba aislada (sin credenciales de Anthropic/Supabase) de la lógica
// pura de "Mejora del flujo inteligente de actualización del
// Calendario Escolar": detección determinista de la intención,
// validación de cada diferencia que el modelo pudiera devolver (la
// única barrera real contra un id inventado), y los dos textos
// deterministas (resumen inicial / resumen de éxito) que NUNCA los
// redacta la IA. Se ejecuta con
// `npx tsx scripts/verificar-analisis-calendario.ts`.

import {
  esVerificacionCalendarioConImagen,
  validarDiferencia,
  construirResumenAnalisis,
  construirResumenExito,
} from '../lib/calendario/analisisCalendario'
import { aplicarCorreccionesCalendario } from '../lib/motorContexto'
import type { DiferenciaCalendario } from '../lib/asistente/tipos'
import type { SupabaseClient } from '@supabase/supabase-js'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const imagenValida = { base64: 'ZmFrZQ==', tipo: 'image/jpeg' }

// --- Detección ---
verificar(esVerificacionCalendarioConImagen('Verifica el calendario con esta foto', imagenValida), 'Detecta "verifica el calendario" + imagen')
verificar(esVerificacionCalendarioConImagen('Actualiza el calendario, aquí está la foto oficial', imagenValida), 'Detecta "actualiza el calendario" + imagen')
verificar(!esVerificacionCalendarioConImagen('Verifica el calendario con esta foto', undefined), 'Sin imagen adjunta, no se activa')
verificar(!esVerificacionCalendarioConImagen('Manda una foto de mi salón', imagenValida), 'Sin la palabra "calendario", no se activa')
verificar(!esVerificacionCalendarioConImagen('El calendario se ve bonito', imagenValida), 'Sin verbo de verificación, no se activa')
verificar(!esVerificacionCalendarioConImagen('Verifica la lista de alumnos', imagenValida), 'Sin la palabra "calendario", "verifica" solo no basta')

// --- Validación de diferencias (barrera contra datos inventados) ---
const idsValidos = new Set(['id-1', 'id-2'])

const agregarValida = validarDiferencia(
  { accion: 'agregar', evento: { titulo: 'Suspensión de labores', fecha: '2026-02-05', tipo: 'SUSPENSION_LABORES', color: '#f97316', descripcion: '' }, motivo: 'No estaba registrada' },
  idsValidos
)
verificar(agregarValida !== null && agregarValida.evento.tipo === 'suspension_labores', 'Diferencia "agregar" válida se acepta y el tipo se normaliza a minúsculas')
verificar(agregarValida?.id === undefined, '"agregar" nunca lleva id')

verificar(
  validarDiferencia({ accion: 'agregar', id: 'id-1', evento: { titulo: 'X', fecha: '2026-01-01', tipo: 'cte' }, motivo: '' }, idsValidos) === null,
  'Se rechaza "agregar" que sí trae id (nunca debería)'
)

verificar(
  validarDiferencia({ accion: 'corregir', id: 'id-inventado', evento: { titulo: 'X', fecha: '2026-01-01', tipo: 'cte' }, motivo: '' }, idsValidos) === null,
  'Se rechaza "corregir" con un id que Claude pudo haber inventado (no está en idsValidos)'
)

verificar(
  validarDiferencia({ accion: 'corregir', evento: { titulo: 'X', fecha: '2026-01-01', tipo: 'cte' }, motivo: '' }, idsValidos) === null,
  'Se rechaza "corregir" sin id en absoluto'
)

verificar(
  validarDiferencia({ accion: 'eliminar', id: 'id-2', evento: { titulo: 'X', fecha: '2026-01-01', tipo: 'cte' }, motivo: '' }, idsValidos) !== null,
  'Se acepta "eliminar" con un id real'
)

verificar(
  validarDiferencia({ accion: 'agregar', evento: { titulo: 'X', fecha: '05-01-2026', tipo: 'cte' }, motivo: '' }, idsValidos) === null,
  'Se rechaza una fecha que no viene en formato YYYY-MM-DD'
)

verificar(validarDiferencia('esto no es un objeto', idsValidos) === null, 'Se rechaza cualquier cosa que no sea un objeto')
verificar(validarDiferencia({ accion: 'volar', evento: {}, motivo: '' }, idsValidos) === null, 'Se rechaza una acción que no es agregar/corregir/eliminar')

verificar(
  validarDiferencia({ accion: 'agregar', evento: { titulo: 'X', fecha: '2026-01-01', tipo: 'cte', color: 'no-es-hex' }, motivo: '' }, idsValidos)?.evento.color === '#8b5cf6',
  'Un color con formato inválido cae al morado institucional por defecto, nunca se descarta la diferencia entera por eso'
)

// --- Textos deterministas ---
verificar(construirResumenAnalisis([]).includes('no encontré diferencias'), 'Resumen inicial sin diferencias es honesto (no promete botones que no aparecerán)')
const resumenConDiferencias = construirResumenAnalisis([agregarValida as DiferenciaCalendario, agregarValida as DiferenciaCalendario])
verificar(resumenConDiferencias.includes('Encontré 2 diferencias'), 'Resumen inicial cuenta el número real de diferencias')
verificar(resumenConDiferencias.includes('respaldo automático'), 'Resumen inicial siempre promete el respaldo automático')

const resultadoExito = {
  exito: true,
  agregados: 3,
  corregidos: 2,
  eliminados: 1,
  aplicadas: [
    { accion: 'agregar' as const, evento: { titulo: 'A', fecha: '2026-02-01', tipo: 'cte', color: '#eab308', descripcion: '' }, motivo: '' },
    { accion: 'agregar' as const, evento: { titulo: 'B', fecha: '2026-02-02', tipo: 'cte', color: '#eab308', descripcion: '' }, motivo: '' },
    { accion: 'agregar' as const, evento: { titulo: 'C', fecha: '2026-02-03', tipo: 'suspension_labores', color: '#f97316', descripcion: '' }, motivo: '' },
  ],
}
const textoExito = construirResumenExito(resultadoExito)
verificar(textoExito.includes('2 CTEs agregados'), 'Resumen de éxito agrupa por categoría real (2 CTE)')
verificar(textoExito.includes('1 suspensión de labores agregada'), 'Concordancia de género correcta (femenino: "agregada", no "agregado")')
verificar(textoExito.includes('2 eventos corregidos') && textoExito.includes('1 evento eliminado'), 'Corregidos/eliminados se reportan con su propio conteo real, singular/plural correcto')
console.log('   (texto real de éxito para revisión visual):\n' + textoExito.split('\n').map((l) => '   ' + l).join('\n'))

// --- aplicarCorreccionesCalendario nunca cuenta más de lo real (sin red, con diferencias vacías) ---
async function verificarAplicarVacio() {
  // diferencias=[] regresa de inmediato sin tocar Supabase — un cliente
  // falso alcanza, nunca se llama a ninguno de sus métodos.
  const resultado = await aplicarCorreccionesCalendario({} as unknown as SupabaseClient, 'user-x', [])
  verificar(resultado.exito && resultado.agregados === 0 && resultado.aplicadas.length === 0, 'aplicarCorreccionesCalendario con arreglo vacío no hace ninguna llamada y regresa 0 en todo')
}

verificarAplicarVacio().then(() => {
  if (fallos > 0) {
    console.error(`\n${fallos} verificación(es) fallida(s).`)
    process.exit(1)
  }
  console.log('\nTodo correcto.')
})
