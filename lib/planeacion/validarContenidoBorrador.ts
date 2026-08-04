// lib/planeacion/validarContenidoBorrador.ts
//
// Validación DETERMINISTA y tipada del contenido estructurado de un
// borrador antes de guardarlo — C-005, Paso 3C (cierre técnico).
// Nunca depende de que Claude "se haya portado bien": revisa el
// ResumenBorrador YA EXTRAÍDO (lib/planeacion/extraerBorrador.ts) con
// comprobaciones explícitas de presencia, tipo y no-vacío, y rechaza
// cualquier combinación que no las cumpla — nunca se persiste un
// borrador incompleto.

import type { ResumenBorrador } from './extraerBorrador'

export type ResultadoValidacionBorrador =
  | { ok: true }
  | { ok: false; elementosFaltantes: string[]; mensaje: string }

type ReglaCampo = {
  etiqueta: string
  cumple: (r: ResumenBorrador) => boolean
}

// Cada regla revisa presencia Y tipo explícitamente (nunca asume que
// el valor ya viene "bien formado" solo porque TypeScript lo tipa
// así) — defensa en profundidad ante cualquier construcción futura de
// ResumenBorrador que no pase por extraerResumenBorrador().
const REGLAS: ReglaCampo[] = [
  { etiqueta: 'propósito', cumple: (r) => typeof r.proposito === 'string' && r.proposito.trim().length > 0 },
  { etiqueta: 'campos formativos', cumple: (r) => Array.isArray(r.camposFormativos) && r.camposFormativos.length > 0 },
  { etiqueta: 'contenidos', cumple: (r) => Array.isArray(r.contenidos) && r.contenidos.length > 0 },
  { etiqueta: 'PDA', cumple: (r) => Array.isArray(r.pda) && r.pda.length > 0 },
  { etiqueta: 'metodología', cumple: (r) => typeof r.metodologia === 'string' && r.metodologia.trim().length > 0 },
  { etiqueta: 'producto final', cumple: (r) => typeof r.productoFinal === 'string' && r.productoFinal.trim().length > 0 },
  {
    etiqueta: 'secuencia didáctica',
    cumple: (r) => Array.isArray(r.secuenciaDidactica) && r.secuenciaDidactica.length > 0 &&
      r.secuenciaDidactica.every((d) => typeof d.dia === 'number' && d.dia > 0 && typeof d.resumen === 'string' && d.resumen.trim().length > 0),
  },
  { etiqueta: 'recursos', cumple: (r) => Array.isArray(r.recursos) && r.recursos.length > 0 },
  { etiqueta: 'evidencias', cumple: (r) => Array.isArray(r.evidencias) && r.evidencias.length > 0 },
  { etiqueta: 'indicadores de evaluación', cumple: (r) => Array.isArray(r.indicadores) && r.indicadores.length > 0 },
  // Fechas y duración resueltas: extraerResumenBorrador ya garantiza
  // fechaInicio/fechaFin en formato YYYY-MM-DD (si no, devuelve null
  // antes de llegar aquí) — aquí se valida además que la duración
  // venga como número positivo real, nunca inventada.
  { etiqueta: 'duración calculada', cumple: (r) => typeof r.duracionDias === 'number' && r.duracionDias > 0 },
]

export function validarContenidoBorrador(resumen: ResumenBorrador): ResultadoValidacionBorrador {
  const elementosFaltantes = REGLAS.filter((regla) => !regla.cumple(resumen)).map((regla) => regla.etiqueta)

  if (elementosFaltantes.length > 0) {
    return {
      ok: false,
      elementosFaltantes,
      // Mensaje funcional y comprensible para el docente — nombres de
      // elementos pedagógicos en español, nunca nombres de columnas,
      // códigos de error de Supabase ni detalles técnicos internos.
      mensaje: `El borrador todavía no tiene toda la información necesaria para guardarlo (falta: ${elementosFaltantes.join(', ')}). Pídeme que lo complete antes de aprobarlo.`,
    }
  }

  return { ok: true }
}
