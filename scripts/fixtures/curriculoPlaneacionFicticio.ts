// scripts/fixtures/curriculoPlaneacionFicticio.ts
//
// Currículo FICTICIO para las pruebas deterministas de Planeación
// (resolución curricular y generación de borradores): primaria, Fase 4
// (3.º y 4.º) en 'borrador', una Fase 5 con cobertura incompleta,
// grupos de preescolar y secundaria sin catálogo, y un Programa Analítico
// publicado del 4.º B. Ningún dato real.

type Fila = Record<string, unknown>

export const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const V = 'version-curricular', F4 = 'fase-4', F5 = 'fase-5', G3 = 'grado-3', G4 = 'grado-4', G5 = 'grado-5'
export const CAMPOS = [
  { id: 'campo-len', clave: 'lenguajes', nombre: 'Lenguajes', curriculo_version_id: V },
  { id: 'campo-sab', clave: 'saberes', nombre: 'Saberes y pensamiento científico', curriculo_version_id: V },
]
export function baseCurricular(estadoVersion: 'borrador' | 'vigente' = 'borrador'): Record<string, Fila[]> {
  return {
    grupos: [
      { id: 'grupo-3a', ciclo_escolar_id: 'ciclo', nivel_educativo: 'primaria', grado: '3°' },
      { id: 'grupo-4b', ciclo_escolar_id: 'ciclo', nivel_educativo: 'primaria', grado: '4' },
      { id: 'grupo-pre', ciclo_escolar_id: 'ciclo', nivel_educativo: 'preescolar', grado: '2' },
      { id: 'grupo-sec', ciclo_escolar_id: 'ciclo', nivel_educativo: 'secundaria', grado: '1' },
      { id: 'grupo-5c', ciclo_escolar_id: 'ciclo', nivel_educativo: 'primaria', grado: '5' },
    ],
    curriculo_grado: [
      { id: G3, nivel_educativo: 'primaria', clave: '3' },
      { id: G4, nivel_educativo: 'primaria', clave: '4' },
      { id: G5, nivel_educativo: 'primaria', clave: '5' },
    ],
    curriculo_fase_grado: [
      { curriculo_grado_id: G3, curriculo_fase_id: F4 },
      { curriculo_grado_id: G4, curriculo_fase_id: F4 },
      { curriculo_grado_id: G5, curriculo_fase_id: F5 },
    ],
    curriculo_fase: [
      { id: F4, clave: 'fase_4', curriculo_version_id: V },
      { id: F5, clave: 'fase_5', curriculo_version_id: V },
    ],
    curriculo_version: [{ id: V, estado: estadoVersion }],
    curriculo_campo_formativo: CAMPOS,
    curriculo_cobertura: [
      { curriculo_version_id: V, fase_id: F4, grado_id: G3, campo_formativo_id: 'campo-len' },
      { curriculo_version_id: V, fase_id: F4, grado_id: G3, campo_formativo_id: 'campo-sab' },
      { curriculo_version_id: V, fase_id: F4, grado_id: G4, campo_formativo_id: 'campo-len' },
      { curriculo_version_id: V, fase_id: F4, grado_id: G4, campo_formativo_id: 'campo-sab' },
      // 5.º: cobertura incompleta (falta un campo).
      { curriculo_version_id: V, fase_id: F5, grado_id: G5, campo_formativo_id: 'campo-len' },
    ],
    curriculo_contenido: [
      { id: U(1), curriculo_version_id: V, fase_id: F4, campo_formativo_id: 'campo-len', titulo: 'Narración de sucesos del pasado y del presente' },
      { id: U(2), curriculo_version_id: V, fase_id: F4, campo_formativo_id: 'campo-sab', titulo: 'Cuerpo humano: estructura externa, acciones para su cuidado' },
      { id: U(3), curriculo_version_id: V, fase_id: F4, campo_formativo_id: 'campo-sab', titulo: 'Alimentación saludable y plato del bien comer' },
      // Sin PDA en 3.º (solo en 4.º).
      { id: U(4), curriculo_version_id: V, fase_id: F4, campo_formativo_id: 'campo-len', titulo: 'Leyendas y mitos de la comunidad' },
      // Otra fase de la misma versión: nunca para 3.º.
      { id: U(5), curriculo_version_id: V, fase_id: F5, campo_formativo_id: 'campo-len', titulo: 'Contenido exclusivo de la Fase 5' },
    ],
    curriculo_pda_grado: [
      { id: U(101), curriculo_pda_id: 'pda-1', contenido_id: U(1), curriculo_grado_id: G3, curriculo_version_id: V },
      { id: U(102), curriculo_pda_id: 'pda-2', contenido_id: U(2), curriculo_grado_id: G3, curriculo_version_id: V },
      { id: U(103), curriculo_pda_id: 'pda-3', contenido_id: U(3), curriculo_grado_id: G3, curriculo_version_id: V },
      { id: U(104), curriculo_pda_id: 'pda-4', contenido_id: U(4), curriculo_grado_id: G4, curriculo_version_id: V },
      { id: U(105), curriculo_pda_id: 'pda-5', contenido_id: U(1), curriculo_grado_id: G4, curriculo_version_id: V },
      { id: U(106), curriculo_pda_id: 'pda-vacio', contenido_id: U(2), curriculo_grado_id: G3, curriculo_version_id: V },
      { id: U(107), curriculo_pda_id: 'pda-7', contenido_id: U(5), curriculo_grado_id: G3, curriculo_version_id: V },
    ],
    curriculo_pda: [
      { id: 'pda-1', texto: 'Narra sucesos del pasado de su comunidad, en orden cronológico.' },
      { id: 'pda-2', texto: 'Reconoce la estructura externa del cuerpo humano y acciones para cuidarlo.' },
      { id: 'pda-3', texto: 'Describe una alimentación saludable con base en el plato del bien comer.' },
      { id: 'pda-4', texto: 'Compara leyendas de distintas comunidades (solo 4.º).' },
      { id: 'pda-5', texto: 'Narra sucesos (versión de 4.º).' },
      { id: 'pda-vacio', texto: '   ' },
      { id: 'pda-7', texto: 'PDA de un contenido de otra fase.' },
    ],
  }
}

// Programa Analítico publicado del 4.º B (compatible) y uno incompatible.
export function conProgramaAnalitico(tablas: Record<string, Fila[]>, gradoVersion = G4): Record<string, Fila[]> {
  return {
    ...tablas,
    programa_analitico: [{ id: 'pa-4b', grupo_id: 'grupo-4b', version_vigente_id: 'pav-2' }],
    programa_analitico_version: [
      { id: 'pav-1', programa_analitico_id: 'pa-4b', curriculo_version_id: V, curriculo_fase_id: F4, curriculo_grado_id: G4 },
      { id: 'pav-2', programa_analitico_id: 'pa-4b', curriculo_version_id: V, curriculo_fase_id: F4, curriculo_grado_id: gradoVersion },
    ],
    programa_analitico_item: [
      { id: U(201), programa_analitico_version_id: 'pav-2', curriculo_contenido_id: U(4), curriculo_version_id: V, curriculo_grado_id: G4, tipo_decision: 'sin_ajuste', texto_contextualizado: null, texto_local: null },
      { id: U(202), programa_analitico_version_id: 'pav-2', curriculo_contenido_id: U(1), curriculo_version_id: V, curriculo_grado_id: G4, tipo_decision: 'contextualizado', texto_contextualizado: 'Historias del barrio contadas por las familias', texto_local: null },
      { id: U(203), programa_analitico_version_id: 'pav-2', curriculo_contenido_id: null, curriculo_version_id: null, curriculo_grado_id: null, tipo_decision: 'nuevo', texto_contextualizado: null, texto_local: 'Huerto escolar de la comunidad' },
      // Versión anterior del PA: nunca.
      { id: U(204), programa_analitico_version_id: 'pav-1', curriculo_contenido_id: U(2), curriculo_version_id: V, curriculo_grado_id: G4, tipo_decision: 'sin_ajuste', texto_contextualizado: null, texto_local: null },
      // Declara otro grado: nunca.
      { id: U(205), programa_analitico_version_id: 'pav-2', curriculo_contenido_id: U(3), curriculo_version_id: V, curriculo_grado_id: G3, tipo_decision: 'sin_ajuste', texto_contextualizado: null, texto_local: null },
      // Contenido de otra fase: nunca.
      { id: U(206), programa_analitico_version_id: 'pav-2', curriculo_contenido_id: U(5), curriculo_version_id: V, curriculo_grado_id: G4, tipo_decision: 'sin_ajuste', texto_contextualizado: null, texto_local: null },
    ],
    programa_analitico_item_pda: [
      { id: U(301), programa_analitico_item_id: U(201), curriculo_pda_grado_id: U(104), curriculo_grado_id: G4 },
      { id: U(302), programa_analitico_item_id: U(202), curriculo_pda_grado_id: U(105), curriculo_grado_id: G4 },
      // PDA de 3.º colgado de un item de 4.º: nunca.
      { id: U(303), programa_analitico_item_id: U(202), curriculo_pda_grado_id: U(101), curriculo_grado_id: G3 },
      // Relación a un PDA inexistente: se omite.
      { id: U(304), programa_analitico_item_id: U(201), curriculo_pda_grado_id: U(999), curriculo_grado_id: G4 },
    ],
  }
}
