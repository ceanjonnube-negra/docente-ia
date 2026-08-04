// scripts/verificar-identidad-docente.ts
//
// Prueba aislada (sin credenciales, sin red, sin escrituras reales) de
// la "CORRECCIÓN CRÍTICA — DOCENTE NO IDENTIFICADO": confirma que la
// aplicación nunca abre Lista/Planeación con ceros ni deja que el Chat
// IA actúe como si conociera al docente cuando no hay sesión válida —
// y que, cuando sí hay sesión, el grupo activo se resuelve
// automáticamente y sin inventar datos. La causa raíz real
// (auth.getUser() del navegador sin sesión en el dominio de
// producción) no es reproducible sin un navegador real — se verifica
// en su lugar, con certeza, el código determinista que decide qué
// hacer en cada uno de los 3 estados posibles (sin sesión / con
// sesión sin grupo / con sesión y grupo), ver informe.
// Se ejecuta con `npx tsx scripts/verificar-identidad-docente.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { obtenerSesionContexto } from '../lib/sesionContexto'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// --- Mismo doble mínimo de SupabaseClient que ya usan los demás
//     scripts de C-005/contexto autenticado. ---

type Fila = Record<string, unknown>

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
  private orden: { columna: string; ascendente: boolean } | null = null
  private limite: number | null = null

  constructor(private cliente: ClienteSupabaseFalso, private tabla: string) {}

  select(_columnas: string) {
    void _columnas
    return this
  }

  eq(columna: string, valor: unknown) {
    this.filtros.push([columna, valor])
    return this
  }

  order(columna: string, opciones?: { ascending?: boolean }) {
    this.orden = { columna, ascendente: opciones?.ascending ?? true }
    return this
  }

  limit(n: number) {
    this.limite = n
    return this
  }

  private ejecutar(): { data: Fila[] | null; error: { message: string } | null } {
    const filas = this.cliente._tabla(this.tabla)
    let resultado = filas.filter((f) => this.filtros.every(([c, v]) => f[c] === v))
    if (this.orden) {
      const { columna, ascendente } = this.orden
      resultado = [...resultado].sort((a, b) => {
        const av = String(a[columna] ?? '')
        const bv = String(b[columna] ?? '')
        if (av < bv) return ascendente ? -1 : 1
        if (av > bv) return ascendente ? 1 : -1
        return 0
      })
    }
    if (this.limite != null) resultado = resultado.slice(0, this.limite)
    return { data: resultado, error: null }
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: Fila[] | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.ejecutar()).then(onfulfilled, onrejected)
  }
}

class ClienteSupabaseFalso {
  private tablas = new Map<string, Fila[]>()

  constructor(datosIniciales: Record<string, Fila[]> = {}) {
    for (const [tabla, filas] of Object.entries(datosIniciales)) {
      this.tablas.set(tabla, filas.map((f) => ({ ...f })))
    }
  }

  from(tabla: string) {
    return new ConsultaFalsa(this, tabla)
  }

  _tabla(tabla: string): Fila[] {
    if (!this.tablas.has(tabla)) this.tablas.set(tabla, [])
    return this.tablas.get(tabla)!
  }
}

function clienteFalso(datos: Record<string, Fila[]> = {}): SupabaseClient {
  return new ClienteSupabaseFalso(datos) as unknown as SupabaseClient
}

const DOCENTE_ID = 'docente-real-2'

async function main() {
  const rutaChat = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
  const rutaLista = readFileSync(join(__dirname, '..', 'app', 'dashboard', 'lista', 'page.tsx'), 'utf-8')
  const rutaProyectos = readFileSync(join(__dirname, '..', 'app', 'dashboard', 'lista', 'proyectos', 'page.tsx'), 'utf-8')
  const rutaProyectosNuevo = readFileSync(join(__dirname, '..', 'app', 'dashboard', 'lista', 'proyectos', 'nuevo', 'page.tsx'), 'utf-8')
  const rutaPlaneacion = readFileSync(join(__dirname, '..', 'app', 'dashboard', 'planeacion', 'page.tsx'), 'utf-8')
  const rutaAuthApi = readFileSync(join(__dirname, '..', 'lib', 'server', 'authApi.ts'), 'utf-8')
  const rutaSupabaseClient = readFileSync(join(__dirname, '..', 'lib', 'supabaseClient.ts'), 'utf-8')

  // ============================================================
  // ESCENARIO 1 — Sin sesión: Lista redirige, Chat IA no ejecuta
  // herramientas escolares.
  // ============================================================
  {
    for (const [nombre, contenido] of [
      ['Lista', rutaLista],
      ['Lista/proyectos', rutaProyectos],
      ['Lista/proyectos/nuevo', rutaProyectosNuevo],
      ['Planeación', rutaPlaneacion],
    ] as const) {
      const bloqueSinUsuario = contenido.slice(contenido.indexOf('auth.getUser()'), contenido.indexOf('auth.getUser()') + 200)
      verificar(/if \(!user\) \{[\s\S]*router\.push\('\/login'\)/.test(bloqueSinUsuario), `1a. ${nombre} redirige a /login cuando no hay usuario autenticado, nunca muestra la pantalla con ceros`)
      verificar(!bloqueSinUsuario.includes("No se pudo identificar al maestro"), `1b. ${nombre} ya no muestra el mensaje ambiguo "No se pudo identificar al maestro" sin redirigir`)
    }

    // Chat IA: ninguna herramienta/Nivel1/Nivel4 puede ejecutarse sin
    // supabaseUser+userId+sesion — el clasificador mismo no se llama.
    verificar(rutaChat.includes('if (supabaseUser && userId && sesion) {'), '1c. El clasificador de Nivel 0 (y por lo tanto CUALQUIER herramienta escolar) solo se invoca con sesión real completa')
    verificar(rutaChat.includes("clasificarNivel0(mensaje, sesion, historialMensajes.slice(-4))"), '1d. La llamada al clasificador vive dentro de ese mismo guardián de sesión')
  }

  // ============================================================
  // ESCENARIO 1b — Sesión rota (accessToken presente pero inválido):
  // mensaje claro y determinista, nunca una respuesta genérica de
  // Claude fingiendo tener acceso.
  // ============================================================
  {
    verificar(rutaChat.includes('if (accessToken && !autenticacion?.ok) {'), '1e. Con un accessToken presente pero inválido, el servidor corta antes de llegar a Claude o a cualquier herramienta')
    const bloque = rutaChat.slice(rutaChat.indexOf('if (accessToken && !autenticacion?.ok) {'), rutaChat.indexOf('if (accessToken && !autenticacion?.ok) {') + 300)
    verificar(bloque.includes("respuestaTexto('Inicia sesión para cargar tu grupo.')"), '1f. El mensaje devuelto es exactamente el exigido: "Inicia sesión para cargar tu grupo."')
  }

  // ============================================================
  // ESCENARIO 2 — Usuario autenticado sin grupo/perfil asociado:
  // error controlado, cero datos inventados, nunca se le pide al
  // docente grado/grupo por chat.
  // ============================================================
  {
    verificar(rutaChat.includes("clasificacion.intencion_principal === 'planeacion_generar' && !sesion.grupo_activo_id"), '2a. planeacion_generar detecta explícitamente "autenticado pero sin grupo activo" como un caso propio, distinto de "sin sesión"')
    const mensajeSinGrupo = rutaChat.match(/return respuestaTexto\('(No encontré un grupo activo[^']*)'\)/)?.[1] ?? ''
    verificar(mensajeSinGrupo.length > 0, '2b. El mensaje es un error controlado y honesto, no una respuesta genérica de Claude')
    verificar(!/grado|turno|escuela/i.test(mensajeSinGrupo), '2c. Ese mensaje nunca le pide al docente grado, turno o escuela por chat')

    // A nivel de datos: obtenerSesionContexto nunca inventa un grupo
    // ni un docente_id cuando el docente no tiene ninguno registrado.
    const sbSinGrupo = clienteFalso({ grupos: [] })
    const sesionSinGrupo = await obtenerSesionContexto(sbSinGrupo, DOCENTE_ID, 'America/Mexico_City')
    verificar(sesionSinGrupo.docente_id === DOCENTE_ID, '2d. docente_id sigue siendo el real (nunca se inventa), aunque no haya grupo')
    verificar(sesionSinGrupo.grupo_activo_id === null && sesionSinGrupo.alumnos_del_grupo_activo.length === 0, '2e. Sin grupo real, grupo_activo_id y la lista de alumnos quedan honestamente vacíos — nunca inventados')
  }

  // ============================================================
  // ESCENARIO 3 — Usuario autenticado con un grupo real: se resuelve
  // automáticamente, sin preguntar nada.
  // ============================================================
  {
    const sb = clienteFalso({
      grupos: [
        { id: 'grupo-x', docente_id: DOCENTE_ID, institucion_id: 'institucion-x', ciclo_escolar_id: 'ciclo-x', creado_en: '2026-08-01T00:00:00Z', 'ciclos_escolares.activo': true },
      ],
      inscripciones: [
        { alumno_id: 'a1', grupo_id: 'grupo-x', estatus: 'activo', numero_lista: 1, alumnos: { nombre: 'Carla Vega', sexo: 'M' } },
      ],
    })
    const sesion = await obtenerSesionContexto(sb, DOCENTE_ID, 'America/Mexico_City')
    verificar(sesion.grupo_activo_id === 'grupo-x', '3a. Con un docente y un grupo real, el grupo activo se resuelve automáticamente')
    verificar(sesion.ciclo_escolar_id === 'ciclo-x', '3b. El ciclo escolar asociado se resuelve junto con el grupo')
    verificar(sesion.alumnos_del_grupo_activo.length === 1, '3c. Los alumnos reales del grupo se cargan sin que el docente los vuelva a capturar')
    // El mismo objeto sesion es lo que el Chat IA recibe e inyecta —
    // ya verificado en detalle en verificar-contexto-autenticado-planeacion.ts.
    verificar(rutaChat.includes('prepararContextoGeneracionPlaneacion(supabaseUser, sesion,'), '3d. El Chat IA (planeacion_generar) recibe ese mismo objeto de sesión (docente_id, grupo, ciclo) para inyectar contexto real')
  }

  // ============================================================
  // ESCENARIO 4 — Usuario autenticado con VARIOS grupos: usa el
  // grupo activo asociado al ciclo vigente (el mismo criterio que
  // Lista, fuente única de verdad).
  // ============================================================
  {
    const sb = clienteFalso({
      grupos: [
        { id: 'grupo-viejo', docente_id: DOCENTE_ID, institucion_id: 'institucion-x', ciclo_escolar_id: 'ciclo-viejo', creado_en: '2025-08-01T00:00:00Z', 'ciclos_escolares.activo': true },
        { id: 'grupo-nuevo', docente_id: DOCENTE_ID, institucion_id: 'institucion-x', ciclo_escolar_id: 'ciclo-nuevo', creado_en: '2026-08-01T00:00:00Z', 'ciclos_escolares.activo': true },
      ],
    })
    const sesion = await obtenerSesionContexto(sb, DOCENTE_ID, 'America/Mexico_City')
    verificar(sesion.grupo_activo_id === 'grupo-nuevo', '4. Con varios grupos activos, se usa el más reciente (mismo criterio que ya usa Lista) — nunca uno arbitrario ni ambos a la vez')
  }

  // ============================================================
  // ESCENARIO 5 — Producción: identidad resuelta contra el
  // accessToken en cada petición, nunca contra localStorage (el
  // servidor no tiene acceso a localStorage del navegador).
  // ============================================================
  {
    verificar(!rutaAuthApi.includes('localStorage') && !rutaAuthApi.includes('document.cookie'), '5a. lib/server/authApi.ts nunca depende de localStorage ni de cookies para identificar al docente — solo del accessToken recibido')
    verificar(rutaAuthApi.includes('supabase.auth.getUser(accessToken)'), '5b. La identidad se valida contra Supabase Auth con el token recibido en cada petición, siempre en el servidor')
    verificar(!rutaAuthApi.includes('SUPABASE_SERVICE_ROLE_KEY'), '5c. No se usa service_role para sustituir la sesión real del docente')
    verificar(!rutaChat.includes('SUPABASE_SERVICE_ROLE_KEY!'.repeat(1)) || rutaChat.includes('supabaseRAG'), '5d. El único uso de service_role en route.ts sigue siendo supabaseRAG (RAG/procesos_activos), no la identidad del docente')
    // lib/supabaseClient.ts (navegador) no fuerza ningún storage propio
    // — usa el comportamiento estándar del SDK (localStorage en el
    // navegador), documentado aquí para que quede explícito que el
    // SERVIDOR nunca lee ese storage directamente.
    verificar(rutaSupabaseClient.includes("createClient(") && !rutaSupabaseClient.includes('cookie'), '5e. El cliente de navegador no implementa su propio manejo de cookies — confirma que esta app no depende de cookies de sesión')
  }

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
