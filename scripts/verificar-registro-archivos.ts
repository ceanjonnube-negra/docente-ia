// scripts/verificar-registro-archivos.ts
//
// Etapa 3B-2A: registro confiable de archivos nuevos. Ciclo registrar
// ('subiendo') → subir → URL firmada → verificación → confirmar
// ('activo') → entregar; ningún archivo se entrega sin registro activo;
// cada etapa se recupera sobre la MISMA ruta (sin duplicar archivos ni
// llamar a la IA); clasificación conservar por defecto: solo una señal
// estructurada ({ clase: 'efimero', conversacionId }) hace un archivo
// efímero, nunca el texto del documento, y hoy ningún flujo la envía.
//
// Sin red, sin credenciales, sin IA: Storage, la base y fetch se
// sustituyen por dobles en memoria; los generadores de PDF/Word son los
// reales. Se ejecuta con `npx tsx scripts/verificar-registro-archivos.ts`.

// Módulo (no script global): sus nombres no chocan con otros scripts.
export {}

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

const DOCENTE = 'd0000000-0000-4000-8000-0000000000d0'
const CONVERSACION = 'C0000000-0000-4000-8000-0000000000C0'
const TEXTO = '📨 CITATORIO\n\nEstimados padres de familia:\n\nSe les cita a una reunión ficticia el viernes a las 8:00.\n\nAtentamente,\nLa dirección'

type Fila = Record<string, unknown>

async function main() {
  const registro = await import('../lib/documentGen/registroArchivos')
  const { ejecutarHerramientaDocumento } = await import('../lib/documentGen/herramientas')

  // ---- Doble de la base (archivos_generados) con fallos programables ----
  const filas: Fila[] = []
  const fallas = { insert: 0, insertPerdido: 0, update: 0, updatePerdido: 0, fk: false }
  const operaciones: string[] = []
  class Consulta {
    private filtros: [string, unknown][] = []
    private op = 'select'
    private datos: Fila | null = null
    private conSelect = false
    private unica = false
    select() { this.conSelect = true; return this }
    insert(d: Fila) { this.op = 'insert'; this.datos = d; return this }
    update(d: Fila) { this.op = 'update'; this.datos = d; return this }
    eq(c: string, v: unknown) { this.filtros.push([c, v]); return this }
    maybeSingle() { this.unica = true; return this }
    then(ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) { return Promise.resolve().then(() => this.ejecutar()).then(ok, ko) }
    private coinciden() { return filas.filter((f) => this.filtros.every(([c, v]) => f[c] === v)) }
    private ejecutar() {
      operaciones.push(`bd.${this.op}`)
      if (this.op === 'insert') {
        const d: Fila = { estado: 'subiendo', activado_en: null, ...this.datos! }
        if (fallas.insert > 0) { fallas.insert--; return { error: { message: 'fallo transitorio de red' } } }
        if (filas.some((f) => f.id === d.id)) return { error: { code: '23505', message: 'duplicado' } }
        if (fallas.fk && d.clase === 'efimero') return { error: { code: '23503', message: 'fk' } }
        if ((d.clase === 'efimero') !== (d.conversacion_id != null)) return { error: { code: '23514', message: 'check' } }
        filas.push(d)
        if (fallas.insertPerdido > 0) { fallas.insertPerdido--; return { error: { message: 'respuesta perdida' } } }
        return { error: null }
      }
      if (this.op === 'update') {
        if (fallas.update > 0) { fallas.update--; return { data: null, error: { message: 'fallo transitorio de red' } } }
        const afectadas = this.coinciden()
        for (const f of afectadas) Object.assign(f, this.datos)
        if (fallas.updatePerdido > 0) { fallas.updatePerdido--; return { data: null, error: { message: 'respuesta perdida' } } }
        return { data: this.conSelect ? afectadas.map((f) => ({ id: f.id })) : null, error: null }
      }
      const datos = this.coinciden().map((f) => ({ ...f }))
      return { data: this.unica ? (datos[0] ?? null) : datos, error: null }
    }
  }
  registro.configurarClienteRegistroArchivos({ from: () => new Consulta() } as never)

  // ---- Doble de Storage y de fetch (verificación HEAD) ----
  const objetos = new Map<string, number>()
  const fallasStorage = { subida: 0, subidaGuardaYFalla: 0, firma: 0, head: 0 }
  const sb = {
    storage: {
      getBucket: async () => ({ data: { id: 'documentos-generados-ia' }, error: null }),
      createBucket: async () => ({ error: null }),
      from: () => ({
        upload: async (ruta: string, buffer: Buffer) => {
          operaciones.push('storage.upload')
          if (fallasStorage.subida > 0) { fallasStorage.subida--; return { error: { message: 'fallo transitorio' } } }
          if (objetos.has(ruta)) return { error: { message: 'The resource already exists' } }
          objetos.set(ruta, buffer.length)
          if (fallasStorage.subidaGuardaYFalla > 0) { fallasStorage.subidaGuardaYFalla--; return { error: { message: 'respuesta perdida' } } }
          return { error: null }
        },
        createSignedUrl: async (ruta: string) => {
          operaciones.push('storage.firma')
          if (fallasStorage.firma > 0) { fallasStorage.firma--; return { data: null, error: { message: 'fallo transitorio' } } }
          return { data: { signedUrl: `https://storage.invalid/sign/${encodeURIComponent(ruta)}?token=t` }, error: null }
        },
      }),
    },
  }
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
    operaciones.push('http.head')
    if (fallasStorage.head > 0) { fallasStorage.head--; return { ok: false, status: 503 } }
    const ruta = decodeURIComponent(url.split('/sign/')[1].split('?')[0])
    return { ok: objetos.has(ruta), status: objetos.has(ruta) ? 200 : 404 }
  }
  const reiniciar = () => { filas.length = 0; objetos.clear(); operaciones.length = 0 }
  const ejecutar = (tipo: 'pdf' | 'word', opciones?: Parameters<typeof ejecutarHerramientaDocumento>[6]) =>
    ejecutarHerramientaDocumento(tipo, TEXTO, {}, null, sb as never, DOCENTE, opciones)
  const errorDe = async (p: Promise<unknown>) => { try { await p; return null } catch (e) { return e as { codigo?: string; message?: string } } }

  // ---- 1. Camino normal ----
  reiniciar()
  const a = await ejecutar('pdf')
  const orden = operaciones.filter((o) => o !== 'storage.firma' || true)
  verificar(orden.indexOf('bd.insert') < orden.indexOf('storage.upload') && orden.indexOf('storage.upload') < orden.indexOf('http.head') && orden.lastIndexOf('bd.update') > orden.indexOf('http.head'), '1a. Orden: registrar → subir → URL → verificar → confirmar')
  verificar(filas.length === 1 && filas[0].estado === 'activo' && !!filas[0].activado_en && a.archivoId === filas[0].id && objetos.size === 1, '1b. Un registro activo, un objeto y archivoId devuelto')
  verificar(filas[0].clase === 'conservar' && filas[0].conversacion_id === null && filas[0].ruta === [...objetos.keys()][0] && String(filas[0].ruta).startsWith(`${DOCENTE}/`), '1c. Sin clasificación: conservar, en la carpeta del docente y con la misma ruta subida')
  verificar(!!a.urlVer && a.tamanoBytes === filas[0].tamano_bytes && filas[0].tipo_mime === 'application/pdf', '1d. Entrega igual que antes (URL de ver, tamaño) más el registro')

  reiniciar()
  await ejecutar('word', { registro: { clase: 'efimero', conversacionId: CONVERSACION } })
  verificar(filas[0].clase === 'efimero' && filas[0].conversacion_id === CONVERSACION.toLowerCase(), '1e. Solo con señal estructurada (clase + conversación) un archivo es efímero')

  // ---- 2. Fallos del registro ----
  reiniciar(); fallas.insert = 3
  const e2a = await errorDe(ejecutar('pdf'))
  verificar(!!e2a && /-REG$/.test(String(e2a.codigo)) && !operaciones.includes('storage.upload') && objetos.size === 0, '2a. Sin registro no se sube nada (error -REG)')
  reiniciar(); fallas.insert = 2
  await ejecutar('pdf')
  verificar(filas.length === 1 && filas[0].estado === 'activo', '2b. Fallos transitorios del registro: se reintenta y sigue')
  reiniciar(); fallas.insertPerdido = 1
  await ejecutar('pdf')
  verificar(filas.length === 1 && objetos.size === 1 && operaciones.filter((o) => o === 'storage.upload').length === 1, '2c. Registro hecho pero respuesta perdida: se reconoce (mismo id), sin duplicar')
  reiniciar(); fallas.fk = true
  await ejecutar('pdf', { registro: { clase: 'efimero', conversacionId: CONVERSACION } })
  fallas.fk = false
  verificar(filas.length === 1 && filas[0].clase === 'conservar' && filas[0].conversacion_id === null, '2d. Conversación que no es del docente (FK): se registra como conservar')

  // ---- 3. Recuperación sobre la misma ruta ----
  reiniciar(); fallasStorage.subida = 1
  await ejecutar('pdf')
  verificar(objetos.size === 1 && filas.length === 1 && filas[0].estado === 'activo', '3a. Subida con fallo transitorio: se reintenta en la misma ruta')
  reiniciar(); fallasStorage.subidaGuardaYFalla = 1
  await ejecutar('pdf')
  verificar(objetos.size === 1 && filas.length === 1 && filas[0].estado === 'activo', '3b. Subida guardada con respuesta perdida: "ya existe" se reconoce, verificada, sin duplicar')
  reiniciar(); fallasStorage.firma = 2
  await ejecutar('pdf')
  verificar(objetos.size === 1 && operaciones.filter((o) => o === 'storage.upload').length === 1 && filas[0].estado === 'activo', '3c. URL firmada con fallos: se reintenta sin volver a subir')
  reiniciar(); fallasStorage.head = 2
  await ejecutar('pdf')
  verificar(objetos.size === 1 && filas[0].estado === 'activo', '3d. Verificación con fallos transitorios: se reintenta sin volver a subir')
  reiniciar(); fallas.update = 2
  await ejecutar('pdf')
  verificar(filas[0].estado === 'activo' && objetos.size === 1, '3e. Confirmación con fallos transitorios: se reintenta sin regenerar')
  reiniciar(); fallas.updatePerdido = 1
  await ejecutar('pdf')
  verificar(filas[0].estado === 'activo' && objetos.size === 1 && filas.length === 1, '3f. Confirmación hecha con respuesta perdida: se reconoce el estado activo')

  // ---- 4. Fallos definitivos: nunca se entrega ----
  reiniciar(); fallasStorage.subida = 5
  const e4a = await errorDe(ejecutar('pdf'))
  fallasStorage.subida = 0
  verificar(!!e4a && /-SUB$/.test(String(e4a.codigo)) && filas[0].estado === 'fallido' && !!filas[0].ultimo_error, '4a. Subida imposible: error -SUB y registro fallido')
  reiniciar(); fallasStorage.head = 5
  const e4b = await errorDe(ejecutar('pdf'))
  fallasStorage.head = 0
  verificar(!!e4b && /-URL-VERIF$/.test(String(e4b.codigo)) && filas[0].estado === 'fallido' && objetos.size === 1, '4b. URL inaccesible: no se entrega, registro fallido (el objeto no se borra)')
  reiniciar(); fallas.update = 5
  const e4c = await errorDe(ejecutar('pdf'))
  fallas.update = 0
  verificar(!!e4c && /-REG-CONF$/.test(String(e4c.codigo)) && filas[0].estado !== 'activo', '4c. Sin confirmación no se entrega (error -REG-CONF), aunque el archivo esté subido')

  // ---- 5. Clasificación: conservar salvo señal estructurada ----
  const k = registro.clasificarArchivo
  verificar(k(undefined).clase === 'conservar', '5a. Sin señal: conservar (también un citatorio o aviso generado en el Chat)')
  verificar(k({ clase: 'efimero' }).clase === 'conservar' && k({ clase: 'efimero', conversacionId: null }).clase === 'conservar' && k({ clase: 'efimero', conversacionId: 'no-es-uuid' }).clase === 'conservar' && k({ clase: 'conservar', conversacionId: CONVERSACION }).clase === 'conservar', '5b. Señal incompleta o inválida: conservar')
  verificar(!('clasificarDocumentoDelChat' in registro) && !('esDocumentoAcademico' in registro), '5c. No existe clasificación por palabras clave del título o del contenido')

  // ---- 6. Integración (código fuente) ----
  const { readFileSync } = await import('node:fs')
  const { execSync } = await import('node:child_process')
  const ruta = readFileSync('app/api/chat/route.ts', 'utf8')
  const herramientas = readFileSync('lib/documentGen/herramientas.ts', 'utf8')
  const llamadas = [...ruta.matchAll(/ejecutarHerramientaDocumento\(/g)].length
  verificar(llamadas === 3 && !/registro:/.test(ruta) && !/registroArchivos/.test(ruta), '6a. Ningún flujo envía señal de efímero: conversión, documento nuevo y lista se registran como conservar')
  verificar(execSync('git diff --name-only -- app/api/chat/route.ts', { encoding: 'utf8' }).trim() === '', '6b. /api/chat sin cambios: generación y conversión intactas')
  verificar(execSync('git diff --name-only -- lib/planeacion lib/seguimiento lib/calendario app/api/proyectos-seguimiento app/api/upload-documento', { encoding: 'utf8' }).trim() === '', '6c. Generadores académicos y otros puntos de subida sin cambios (planeación, hojas, calendario, documentos institucionales)')
  verificar(!/messages\.create|anthropic|openai/i.test(herramientas) && !/\.remove\(|eliminarArchivo/.test(herramientas), '6d. La herramienta no llama a la IA ni borra archivos')
  const posMarcador = ruta.indexOf("const marcador = `[[DOCUMENTO_ARCHIVO:", ruta.indexOf('await conReintento(() => ejecutarHerramientaDocumento(tipoHerramientaSolicitado, documentoTexto'))
  verificar(posMarcador > ruta.indexOf('await conReintento(() => ejecutarHerramientaDocumento(tipoHerramientaSolicitado, documentoTexto'), '6e. El marcador del archivo solo se arma después de que la herramienta terminó (registro activo)')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  }
  console.log('Todas las pruebas pasaron.')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
