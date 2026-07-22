// lib/fuentesOficiales.ts
//
// "Consultar información oficial vigente de la SEP" — Docente IA necesita
// poder responder preguntas sobre calendario escolar oficial, ciclo
// escolar, planes y programas, lineamientos y acuerdos SEP/DOF sin
// inventar fechas ni decir "no tengo acceso a internet".
//
// DECISIÓN DE ARQUITECTURA: en vez de escribir un buscador/scraper propio
// (que exigiría contratar un proveedor de búsqueda, guardar una API key
// nueva, y escribir a mano el manejo de HTML/timeouts/límites de tamaño),
// se usa la herramienta nativa `web_search` de la propia API de
// Anthropic — misma cuenta y credencial ya configurada (ANTHROPIC_API_KEY),
// cero proveedores ni credenciales nuevas (ver "Diagnóstico y Plan de
// Optimización del Pipeline de Voz": la prioridad explícita es reducir
// complejidad, costos, credenciales y puntos de falla).
//
// Esto también resuelve la mayoría de la sección SEGURIDAD por
// construcción, no por código propio:
// - allowed_domains lo aplica la infraestructura de Anthropic — el
//   modelo NUNCA puede pedir una URL fuera de la lista, sin importar qué
//   intente. No hay "URLs arbitrarias enviadas por el modelo" posibles.
// - Los resultados llegan como bloques de contenido estructurados
//   (title/url/page_age) — nunca HTML crudo que haya que sanitizar.
// - El contenido recuperado se trata como datos dentro de la misma
//   conversación de Claude, nunca como instrucciones nuevas del sistema.
// - Anthropic controla timeout y tamaño de cada búsqueda del lado de su
//   propia infraestructura.
//
// Lo que SÍ es responsabilidad de este archivo/route.ts: que la
// herramienta solo esté disponible cuando el Clasificador de Nivel 0
// autorizó explícitamente el turno (requiere_consulta_oficial=true) —
// nunca por default en cada mensaje — y que la lista de dominios
// permitidos sea exactamente la pedida, nada más.

// Lista inicial — solo los dominios federales pedidos explícitamente.
// Agregar aquí el dominio de la SEE estatal correspondiente en cuanto se
// confirme cuál es el real para cada estado; no se inventan dominios
// estatales sin verificarlos primero.
export const DOMINIOS_OFICIALES_SEP: string[] = ['gob.mx', 'sep.gob.mx', 'dof.gob.mx']

// max_uses bajo a propósito: limita cuántas búsquedas puede hacer Claude
// en un solo turno (costo/latencia acotados) — casi ninguna pregunta de
// este tipo necesita más de 1-2 búsquedas reales.
const MAX_USOS_POR_TURNO = 3

// Objeto listo para spread en `tools` de client.messages.create() — se
// construye como función (no constante estática) por si en el futuro
// necesita variar user_location según el estado del docente; hoy siempre
// devuelve la misma configuración.
export function construirHerramientaConsultaOficial() {
  return {
    type: 'web_search_20250305' as const,
    name: 'web_search' as const,
    allowed_domains: DOMINIOS_OFICIALES_SEP,
    max_uses: MAX_USOS_POR_TURNO,
  }
}
