// scripts/verificar-nivel-educativo.ts
//
// Prueba aislada de "Ilustraciones por nivel educativo, Fase 1 —
// diseño + implementación base". Ejecución REAL (funciones puras, sin
// red) de resolverNivelEducativo/obtenerPerfilNivel contra los
// mensajes reales que se han usado en esta sesión (exámenes de
// ciencias/matemáticas/español para 4°) más los 5 niveles pedidos,
// además de verificación ESTRUCTURAL de que route.ts/herramientas.ts
// quedaron cableados sin romper el comportamiento por defecto
// (nivel no resuelto → sin cambios).
//
// Se ejecuta con `npx tsx scripts/verificar-nivel-educativo.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolverNivelEducativo,
  resolverNivelEducativoDeTexto,
  resolverNivelEducativoDeGrupo,
} from '../lib/documentGen/nivelEducativo'
import { obtenerPerfilNivel } from '../lib/documentGen/perfilNivelEducativo'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const RAIZ = join(__dirname, '..')
const cuerpoRoute = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf-8')
const cuerpoHerramientas = readFileSync(join(RAIZ, 'lib/documentGen/herramientas.ts'), 'utf-8')
const cuerpoSesionContexto = readFileSync(join(RAIZ, 'lib/sesionContexto.ts'), 'utf-8')

async function main() {
  // ============================================================
  // 1. Resolución desde texto explícito — los 3 casos reales de
  //    examen ya usados esta sesión, más preescolar/secundaria.
  // ============================================================
  verificar(resolverNivelEducativoDeTexto('Hazme un examen completo de Ciencias sobre el ciclo del agua para 4° de primaria.') === 'primaria_media', 'Texto "4° de primaria" resuelve a primaria_media')
  verificar(resolverNivelEducativoDeTexto('Hazme un examen completo de matemáticas para 4° de primaria.') === 'primaria_media', 'Texto "para 4° de primaria" (matemáticas) resuelve a primaria_media')
  verificar(resolverNivelEducativoDeTexto('Hazme una ficha para 1° de primaria.') === 'primaria_baja', 'Texto "1° de primaria" resuelve a primaria_baja')
  verificar(resolverNivelEducativoDeTexto('Necesito una actividad para 6° de primaria.') === 'primaria_alta', 'Texto "6° de primaria" resuelve a primaria_alta')
  verificar(resolverNivelEducativoDeTexto('Hazme una actividad para preescolar sobre los colores.') === 'preescolar', 'Texto "para preescolar" resuelve a preescolar')
  verificar(resolverNivelEducativoDeTexto('Genera un examen de historia para secundaria.') === 'secundaria', 'Texto "para secundaria" resuelve a secundaria')
  verificar(resolverNivelEducativoDeTexto('Hazme una guía para cuarto grado sobre el sistema solar.') === 'primaria_media', 'Texto "cuarto grado" (palabra completa) resuelve a primaria_media')
  verificar(resolverNivelEducativoDeTexto('Hazme un examen para 4to de primaria.') === 'primaria_media', 'Texto "4to" (ordinal pegado) resuelve a primaria_media')

  // ============================================================
  // 2. Grado explícito SIN decir el nivel — 1-3 es ambiguo a
  //    propósito (preescolar/primaria/secundaria comparten esos
  //    números), 4-6 es inequívocamente primaria.
  // ============================================================
  verificar(resolverNivelEducativoDeTexto('Hazme un examen para 5°.') === 'primaria_alta', 'Texto "para 5°" sin decir nivel resuelve a primaria_alta (inequívoco)')
  verificar(resolverNivelEducativoDeTexto('Hazme un examen para 2°.') === null, 'Texto "para 2°" sin decir nivel NO se resuelve (ambiguo entre preescolar/primaria/secundaria) — cae al grupo activo')
  verificar(resolverNivelEducativoDeTexto('Hazme un examen de matemáticas.') === null, 'Texto sin ninguna mención de grado/nivel no resuelve nada')

  // ============================================================
  // 3. Resolución desde el grupo activo real (grupos.nivel_educativo
  //    + grupos.grado) — mismos valores crudos que guarda
  //    app/dashboard/grupos/nuevo/page.tsx.
  // ============================================================
  verificar(resolverNivelEducativoDeGrupo({ nivelEducativoGrupo: 'preescolar', gradoGrupo: '2' }) === 'preescolar', 'Grupo activo nivel_educativo="preescolar" resuelve a preescolar (grado no importa)')
  verificar(resolverNivelEducativoDeGrupo({ nivelEducativoGrupo: 'secundaria', gradoGrupo: '1' }) === 'secundaria', 'Grupo activo nivel_educativo="secundaria" resuelve a secundaria')
  verificar(resolverNivelEducativoDeGrupo({ nivelEducativoGrupo: 'primaria', gradoGrupo: '3' }) === 'primaria_media', 'Grupo activo nivel_educativo="primaria" + grado="3" resuelve a primaria_media')
  verificar(resolverNivelEducativoDeGrupo({ nivelEducativoGrupo: null, gradoGrupo: null }) === null, 'Grupo activo sin nivel_educativo no resuelve nada')

  // ============================================================
  // 4. Prioridad real: texto explícito SIEMPRE gana sobre el grupo
  //    activo, aunque contradiga el nivel habitual del docente.
  // ============================================================
  {
    const r = resolverNivelEducativo({
      textoMensaje: 'Hazme un examen para 1° de secundaria.',
      grupoActivo: { nivelEducativoGrupo: 'primaria', gradoGrupo: '4' },
    })
    verificar(r === 'secundaria', 'El texto explícito ("1° de secundaria") gana sobre el grupo activo (primaria 4°) — nunca al revés')
  }
  {
    const r = resolverNivelEducativo({
      textoMensaje: 'Hazme un examen de ciencias.',
      grupoActivo: { nivelEducativoGrupo: 'primaria', gradoGrupo: '6' },
    })
    verificar(r === 'primaria_alta', 'Sin nivel/grado en el texto, cae correctamente al grupo activo (primaria 6° → primaria_alta)')
  }
  {
    const r = resolverNivelEducativo({ textoMensaje: 'Hazme un examen de ciencias.' })
    verificar(r === null, 'Sin texto explícito y sin grupo activo, no resuelve nada — comportamiento actual preservado')
  }

  // ============================================================
  // 5. Perfil pedagógico-visual — los 5 niveles existen, reutilizan
  //    EstiloVisual ya existente (no un enum paralelo).
  // ============================================================
  const NIVELES = ['preescolar', 'primaria_baja', 'primaria_media', 'primaria_alta', 'secundaria'] as const
  for (const n of NIVELES) {
    const perfil = obtenerPerfilNivel(n)
    verificar(perfil.nivel === n && !!perfil.estiloVisual && !!perfil.instruccionRedaccion, `obtenerPerfilNivel('${n}') devuelve un perfil completo (estiloVisual + instrucción de redacción)`)
  }
  verificar(obtenerPerfilNivel('preescolar').estiloVisual === 'infantil', 'Preescolar usa el estilo visual "infantil" ya existente en reglasVisuales.ts')
  verificar(obtenerPerfilNivel('secundaria').estiloVisual === 'profesional-docente', 'Secundaria usa el estilo visual "profesional-docente" ya existente')

  // ============================================================
  // 6. Cableado real en el código — aditivo, sin tocar el
  //    comportamiento por defecto.
  // ============================================================
  verificar(cuerpoSesionContexto.includes('nivel_educativo, grado, grupo, ciclos_escolares!inner(activo)'), 'sesionContexto.ts lee nivel_educativo/grado/grupo del grupo activo real (columnas ya existentes en la tabla grupos)')
  verificar(cuerpoRoute.includes("import { resolverNivelEducativo } from '@/lib/documentGen/nivelEducativo'"), 'route.ts importa resolverNivelEducativo')
  verificar(cuerpoRoute.includes('${bloqueDocumentoIlustrado}${bloqueNivelEducativo}'), 'El bloque de nivel educativo se agrega SIN reemplazar los bloques de sistema existentes (voz/consulta oficial/imagen/documento ilustrado)')
  verificar(cuerpoRoute.includes('generarImagenesParaDocumento(descripciones, perfil, supabaseRAG, userId, supabaseUser, conversacionId, estiloVisualNivelEducativo)'), 'CASO 3 pasa el estilo visual resuelto a la generación de ilustraciones del documento')
  verificar(cuerpoHerramientas.includes('estiloVisual: EstiloVisual | undefined'), 'generarUnaIlustracion acepta estiloVisual como parámetro explícito (undefined = comportamiento anterior exacto)')
  verificar(cuerpoHerramientas.includes("generarImagen({ prompt: descripcion, nivelEscolar: perfil?.grado || undefined, estilo: estiloVisual })"), 'El estilo resuelto llega hasta generarImagen() — SolicitudImagen.estilo ya existía, solo faltaba conectarlo')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
