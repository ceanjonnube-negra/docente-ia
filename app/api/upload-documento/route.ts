import { errorSeguro } from '@/lib/logSeguro';
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import OpenAI from 'openai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { autenticarRequestApi, extraerBearerToken, usuarioPerteneceAInstitucion } from '@/lib/server/authApi';
import { detectarDatosPersonalesSinRoster, protegerTextoDocumento } from '@/lib/asistente/consultaEmbedding';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Carga de documentos institucionales del docente — flujo PRIVADO:
// - Todo con el cliente AUTENTICADO del docente (auth.supabase) y RLS:
//   cada documento pertenece a auth.user.id; el archivo original vive en
//   Storage bajo <uid>/ (políticas del bucket en la migración
//   20261019000000_politicas_storage_documentos_institucionales.sql).
// - Aquí se indexan documentos INSTITUCIONALES y NORMATIVOS. Un registro
//   personal (lista nominal, boleta, expediente, ficha, reporte de
//   incidencia…) se rechaza ANTES de cualquier llamada de IA o escritura:
//   alumnos del roster identificados, CURP, fechas de nacimiento o campos y
//   filas con nombres de personas (ver filtro de privacidad abajo).
// - El ORIGINAL se guarda íntegro. Lo único que se indexa (embeddings,
//   chunk_texto, contenido_texto y el nombre visible del archivo) es una
//   copia PROTEGIDA (lib/asistente/consultaEmbedding.ts): correos,
//   teléfonos y nombres sueltos de los alumnos del propio docente. Si la
//   protección o el filtro fallan, el documento no se indexa.
// - Nada se escribe hasta que el texto está extraído, protegido e
//   indexado en memoria. El documento y sus fragmentos se registran en UNA
//   transacción (RPC registrar_documento_institucional, migración
//   20261019010000): nunca queda un documento incompleto, y el índice
//   único (user_id, hash_archivo) impide duplicados aunque lleguen dos
//   cargas a la vez (23505 → 409).
// - Plazo global (PRESUPUESTO_TOTAL_MS): cada llamada externa tiene un
//   tiempo máximo que cabe en lo que resta, reservando de antemano el
//   tiempo de Storage, del registro y de la limpieza.
// - Imágenes: el OCR automático (imagen completa a un proveedor externo)
//   queda DESACTIVADO en esta fase — ver OCR_AUTOMATICO_HABILITADO.

const BUCKET = 'documentos-institucionales';
const MODELO_EMBEDDINGS = 'text-embedding-3-small';
// Límite real del despliegue: Vercel rechaza cuerpos de más de 4.5 MB.
const MAX_BYTES = 4 * 1024 * 1024;
const TAMANO_FRAGMENTO = 1000;
const TRASLAPE_FRAGMENTO = 150;
// Límite interno de ESTA fase: 200 fragmentos (≈145 000 caracteres). El
// registro atómico viaja en una sola petición (texto + vectores de 1536
// dimensiones): 200 fragmentos ≈ 4.2 MB de JSON, medido ≈ 0.5 s en
// Postgres (PGlite), con margen amplio frente al statement_timeout de 8 s
// del rol authenticated y a PLAZO_REGISTRO_MS. 400 fragmentos serían
// ≈ 8.4 MB; se eleva solo con evidencia medida en Preview. Con lotes de
// 100 son a lo más 2 llamadas a embeddings.
const MAX_FRAGMENTOS = 200;
const TAMANO_LOTE_EMBEDDINGS = 100;
const TIMEOUT_EMBEDDINGS_MS = 20_000;
// Un solo reintento del SDK para errores pasajeros (429/5xx); siempre
// dentro del plazo restante (signal). Los embeddings no escriben nada, así
// que reintentarlos no puede duplicar registros. Storage y el registro NO
// se reintentan.
const REINTENTOS_EMBEDDINGS = 1;
// Plazo global por solicitud (por debajo de maxDuration = 60 s, con margen
// para responder). Antes de escribir se reserva el tiempo de Storage, del
// registro y de la limpieza: si no alcanza, se responde 503 sin escribir.
const PRESUPUESTO_TOTAL_MS = 50_000;
const PLAZO_STORAGE_MS = 10_000;
// statement_timeout del rol authenticated = 8 s, más la red.
const PLAZO_REGISTRO_MS = 10_000;
const RESERVA_LIMPIEZA_MS = 5_000;
const RESERVA_ESCRITURAS_MS = PLAZO_STORAGE_MS + PLAZO_REGISTRO_MS + RESERVA_LIMPIEZA_MS;
// OCR de imágenes con IA: se conserva en la arquitectura, pero NO se
// ejecuta automáticamente mientras no exista una forma de proteger la
// imagen antes de enviarla (una imagen escolar completa saldría tal cual).
const OCR_AUTOMATICO_HABILITADO: boolean = false;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Formato = 'pdf' | 'docx' | 'txt' | 'imagen';

// Tipo MIME y extensión CANÓNICOS del formato validado por el servidor
// (nunca solo file.type: algunos navegadores móviles lo envían vacío y
// documentos_institucionales.tipo es NOT NULL).
// (Imágenes: solo si el OCR se habilita en el futuro; hoy se rechazan antes.)
const MIME_POR_FORMATO: Record<Exclude<Formato, 'imagen'>, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
};
const EXTENSION_POR_FORMATO: Record<Formato, string> = { pdf: '.pdf', docx: '.docx', txt: '.txt', imagen: '' };

// El CONTENIDO debe corresponder al formato declarado: PDF empieza con
// %PDF-, DOCX es un ZIP (PK\x03\x04) y TXT es UTF-8 válido sin bytes nulos.
function contenidoCorresponde(buffer: Buffer, formato: Formato): boolean {
  if (formato === 'imagen') return true;
  if (formato === 'pdf') return buffer.subarray(0, 1024).includes('%PDF-');
  if (formato === 'docx') return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

class PlazoAgotado extends Error {}

// Ejecuta `trabajo` con un tiempo máximo: al vencer, cancela (signal) y deja
// de esperar aunque la librería no admita cancelación.
async function conPlazo<T>(ms: number, trabajo: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  if (ms <= 0) throw new PlazoAgotado();
  const control = new AbortController();
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, rechazar) => {
    temporizador = setTimeout(() => { rechazar(new PlazoAgotado()); control.abort(); }, ms);
  });
  const ejecucion = Promise.resolve(trabajo(control.signal));
  ejecucion.catch(() => {});
  try {
    return await Promise.race([ejecucion, limite]);
  } finally {
    clearTimeout(temporizador);
  }
}

// Error DEFINITIVO de la base (código SQLSTATE o de PostgREST): la
// transacción NO se confirmó. Un corte de red o de plazo no lo es: el
// resultado es desconocido.
const esErrorDefinitivo = (error: { code?: string } | null) => !!error?.code && (/^[0-9A-Z]{5}$/.test(error.code) || error.code.startsWith('PGRST'));

const responder = (cuerpo: Record<string, unknown>, status: number) => NextResponse.json(cuerpo, { status, headers: { 'Cache-Control': 'no-store' } });

function chunkText(text: string, chunkSize = TAMANO_FRAGMENTO, overlap = TRASLAPE_FRAGMENTO) {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap;
  }
  return chunks;
}

// Formato por tipo MIME o extensión — solo los que de verdad se pueden
// extraer. .doc (Word binario antiguo) y cualquier otro binario se rechazan
// (antes se "decodificaban" como texto).
function formatoDe(mimeType: string, filename: string): Formato | null {
  const nombre = filename.toLowerCase();
  if (mimeType === 'application/pdf' || nombre.endsWith('.pdf')) return 'pdf';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || nombre.endsWith('.docx')) return 'docx';
  if (mimeType === 'text/plain' || nombre.endsWith('.txt')) return 'txt';
  if (mimeType.startsWith('image/')) return 'imagen';
  return null;
}

async function extractTextFromImage(buffer: Buffer, mimeType: string): Promise<string> {
  const base64 = buffer.toString('base64');
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extrae todo el texto visible en esta imagen de forma literal y completa. No agregues comentarios ni interpretaciones, solo el texto tal como aparece.' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ],
    max_tokens: 4000,
  });
  return response.choices[0]?.message?.content || '';
}

async function extractText(buffer: Buffer, formato: Formato, mimeType: string, signal?: AbortSignal): Promise<string> {
  if (formato === 'imagen') return extractTextFromImage(buffer, mimeType);
  if (formato === 'pdf') {
    // pdf-parse 2.x (versión instalada): API de clase; ya no exporta una
    // función por defecto (con la llamada anterior la extracción de PDF
    // fallaba siempre).
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    signal?.addEventListener('abort', () => { parser.destroy().catch(() => {}); }, { once: true });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  if (formato === 'docx') {
    const mammoth = (await import('mammoth') as any).default;
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  return buffer.toString('utf-8');
}

// Nombre visible protegido (llega al Chat IA junto a cada fragmento): el
// mismo criterio que el texto, con separadores de archivo leídos como
// espacios. La extensión real se conserva.
function nombreArchivoProtegido(nombre: string, nombresAlumnos: readonly string[]) {
  const punto = nombre.lastIndexOf('.');
  const extension = punto > 0 ? nombre.slice(punto).toLowerCase().replace(/[^.a-z0-9]/g, '') : '';
  const base = (punto > 0 ? nombre.slice(0, punto) : nombre).replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const protegido = protegerTextoDocumento(base, nombresAlumnos);
  return { ...protegido, nombre: `${protegido.texto.replace(/\s+/g, ' ').trim().slice(0, 150) || 'documento'}${extension}` };
}

async function indexarEnLotes(fragmentos: string[], disponible: () => number): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let i = 0; i < fragmentos.length; i += TAMANO_LOTE_EMBEDDINGS) {
    const lote = fragmentos.slice(i, i + TAMANO_LOTE_EMBEDDINGS);
    const plazo = disponible();
    const respuesta = await conPlazo(plazo, (signal) =>
      openai.embeddings.create({ model: MODELO_EMBEDDINGS, input: lote }, { timeout: Math.min(TIMEOUT_EMBEDDINGS_MS, plazo), maxRetries: REINTENTOS_EMBEDDINGS, signal }));
    const ordenados = [...respuesta.data].sort((a, b) => a.index - b.index);
    if (ordenados.length !== lote.length) throw new Error('respuesta de embeddings incompleta');
    for (const d of ordenados) embeddings.push(d.embedding);
  }
  return embeddings;
}

// Pgvector recibe cada vector como texto; 9 dígitos significativos
// reproducen EXACTAMENTE cada float32 que entrega el proveedor (sin
// pérdida) y reducen el tamaño de la petición del registro.
const vectorComoTexto = (embedding: number[]) => `[${embedding.map((x) => Number(x.toPrecision(9))).join(',')}]`;

// Limpieza del archivo privado recién subido, con su propio tiempo máximo.
// Si falla, solo queda un objeto privado huérfano bajo <uid>/ (no bloquea
// volver a subir el archivo: cada carga usa una ruta nueva).
async function eliminarArchivo(sb: SupabaseClient, storagePath: string, ms: number) {
  try {
    const { error } = await conPlazo(ms, () => sb.storage.from(BUCKET).remove([storagePath]));
    if (error) console.error(`[upload-documento] limpieza=archivo resultado=fallo ${errorSeguro(error)}`);
  } catch (e) {
    console.error(`[upload-documento] limpieza=archivo resultado=fallo ${errorSeguro(e)}`);
  }
}

const MENSAJE_PLAZO = 'La indexación tardó demasiado y no se guardó nada. Intenta de nuevo en unos minutos.';
const MENSAJE_DATOS_PERSONALES = 'Este documento contiene datos personales de alumnos (por ejemplo, nombres en una lista, boleta, expediente o ficha, una CURP o fechas de nacimiento), por eso no se indexó. Aquí se indexan documentos institucionales y normativos; los datos de tus alumnos se registran en Lista.';

export async function POST(req: Request) {
  const inicio = Date.now();
  const restante = () => inicio + PRESUPUESTO_TOTAL_MS - Date.now();
  // Tiempo disponible para las fases PREVIAS a escribir: siempre queda
  // reservado el de Storage, el registro y la limpieza.
  const disponiblePrevio = () => restante() - RESERVA_ESCRITURAS_MS;
  let etapa = 'autenticacion';
  try {
    // FASE 1A — autenticación y autorización ANTES de tocar el archivo.
    const accessToken = extraerBearerToken(req);
    const auth = await conPlazo(disponiblePrevio(), () => autenticarRequestApi(accessToken));
    if (!auth.ok) {
      return responder({ error: auth.mensaje }, auth.status);
    }
    const sb = auth.supabase;
    const userId = auth.user.id;

    etapa = 'solicitud';
    const formData = await conPlazo(disponiblePrevio(), () => req.formData());
    const file = formData.get('file');
    const categoria = String(formData.get('categoria') || 'General').trim().slice(0, 80) || 'General';
    const descripcionCruda = String(formData.get('descripcion') || '').slice(0, 1000);
    const institucionId = (formData.get('institucion_id') as string) || null;

    // Nunca se confía solo en el institucion_id que mandó el cliente.
    if (institucionId) {
      const pertenece = await conPlazo(disponiblePrevio(), () => usuarioPerteneceAInstitucion(sb, userId, institucionId));
      if (!pertenece) {
        return responder({ error: 'No tienes acceso a esta institución.' }, 403);
      }
    }

    if (!file || typeof file === 'string') {
      return responder({ error: 'No se envió ningún archivo.' }, 400);
    }
    const formato = formatoDe(file.type || '', file.name || '');
    if (!formato) {
      return responder({ error: 'Formato no admitido. Sube el documento en PDF, Word (.docx) o texto (.txt).' }, 415);
    }
    if (formato === 'imagen' && !OCR_AUTOMATICO_HABILITADO) {
      return responder({ error: 'Por ahora las imágenes no se indexan automáticamente para proteger los datos de tus alumnos. Sube el documento en PDF, Word (.docx) o texto (.txt).' }, 422);
    }
    if (file.size <= 0) {
      return responder({ error: 'El archivo está vacío.' }, 400);
    }
    if (file.size > MAX_BYTES) {
      return responder({ error: 'El archivo supera el tamaño máximo de 4 MB.' }, 413);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!contenidoCorresponde(buffer, formato)) {
      return responder({ error: 'El contenido del archivo no corresponde a un PDF, Word (.docx) o texto (.txt) válido.' }, 415);
    }
    const mime = formato === 'imagen' ? file.type : MIME_POR_FORMATO[formato];
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Duplicados del PROPIO docente (RLS + filtro explícito por dueño): evita
    // pagar embeddings en el caso normal. La exclusividad real la da el
    // índice único dentro del registro atómico.
    etapa = 'duplicado';
    const { data: existente, error: errorExistente } = await conPlazo(disponiblePrevio(), (signal) => sb
      .from('documentos_institucionales')
      .select('id, version')
      .eq('user_id', userId)
      .eq('hash_archivo', hash)
      .limit(1)
      .abortSignal(signal)
      .maybeSingle());
    if (errorExistente) throw errorExistente;
    if (existente) {
      return responder({ error: 'Este documento ya existe', documento: { id: existente.id, version: existente.version } }, 409);
    }

    etapa = 'extraccion';
    let texto: string;
    try {
      texto = await conPlazo(disponiblePrevio(), (signal) => extractText(buffer, formato, mime, signal));
    } catch (e) {
      if (e instanceof PlazoAgotado) throw e;
      console.error(`[upload-documento] etapa=extraccion formato=${formato} ${errorSeguro(e)}`);
      return responder({ error: 'No se pudo leer el contenido del documento. Verifica que no esté dañado o protegido con contraseña.' }, 422);
    }
    if (!texto.trim()) {
      return responder({ error: 'No se encontró texto en el documento (por ejemplo, un PDF escaneado).' }, 422);
    }

    // Alumnos del PROPIO docente (RLS docente_id = auth.uid()) — solo para
    // proteger sus nombres; nunca se consultan datos de otros docentes.
    etapa = 'roster';
    const { data: alumnos, error: errorAlumnos } = await conPlazo(disponiblePrevio(), (signal) =>
      sb.from('alumnos').select('nombre').eq('docente_id', userId).abortSignal(signal));
    if (errorAlumnos) throw errorAlumnos;
    const nombresAlumnos = (alumnos ?? []).map((a: { nombre: string | null }) => a.nombre ?? '').filter(Boolean);

    // Copia protegida + FILTRO DE PRIVACIDAD — antes de cualquier llamada
    // de IA y de cualquier escritura. Un registro personal no se indexa: ni
    // sus nombres fuera del roster, ni domicilios, ni diagnósticos llegan
    // al proveedor de embeddings.
    etapa = 'proteccion';
    let textoProtegido: string;
    let nombreVisible: string;
    let descripcion: string;
    let resumen: { nombres: number; curp: number; contacto: number; fechas: number };
    try {
      const protegido = protegerTextoDocumento(texto, nombresAlumnos);
      const nombre = nombreArchivoProtegido(file.name || 'documento', nombresAlumnos);
      const descripcionProtegida = protegerTextoDocumento(descripcionCruda, nombresAlumnos);
      const sinRoster = detectarDatosPersonalesSinRoster(texto);
      const senales = {
        alumnos: protegido.alumnosIdentificados + nombre.alumnosIdentificados + descripcionProtegida.alumnosIdentificados,
        curp: protegido.resumen.curp + nombre.resumen.curp + descripcionProtegida.resumen.curp,
        fechas: protegido.resumen.fechas + nombre.resumen.fechas + descripcionProtegida.resumen.fechas,
        campos: sinRoster.campos,
        filas: sinRoster.filas,
      };
      if (Object.values(senales).some((n) => n > 0)) {
        // Solo conteos — nunca texto ni nombres.
        const conteos = Object.entries(senales).map(([clave, n]) => `${clave}:${n}`).join(',');
        console.log(`[upload-documento] resultado=rechazado motivo=datos_personales ${conteos}`);
        return responder({ error: MENSAJE_DATOS_PERSONALES }, 422);
      }
      textoProtegido = protegido.texto;
      resumen = protegido.resumen;
      nombreVisible = nombre.nombre;
      descripcion = descripcionProtegida.texto;
    } catch (e) {
      console.error(`[upload-documento] etapa=proteccion ${errorSeguro(e)}`);
      return responder({ error: 'No fue posible preparar el documento de forma segura. No se indexó.' }, 422);
    }

    const fragmentos = chunkText(textoProtegido).filter((f) => f.trim());
    if (fragmentos.length > MAX_FRAGMENTOS) {
      return responder({ error: 'El documento es demasiado extenso para indexarlo. Divídelo en partes más pequeñas.' }, 413);
    }

    // Embeddings en lotes, ANTES de escribir nada (si fallan, no queda nada).
    etapa = 'embeddings';
    const embeddings = await indexarEnLotes(fragmentos, disponiblePrevio);

    // Escrituras: archivo original → registro atómico (documento + fragmentos).
    if (disponiblePrevio() < 0) throw new PlazoAgotado();
    etapa = 'almacenamiento';
    // Ruta ÚNICA por carga (aleatoria): dos envíos simultáneos del mismo
    // archivo en el mismo milisegundo nunca comparten objeto, así la
    // limpieza de uno jamás borra el archivo del otro.
    const storagePath = `${userId}/${Date.now()}-${crypto.randomUUID()}${EXTENSION_POR_FORMATO[formato]}`;
    let storageError: unknown = null;
    try {
      ({ error: storageError } = await conPlazo(PLAZO_STORAGE_MS, () => sb.storage.from(BUCKET).upload(storagePath, buffer, { contentType: mime, upsert: false })));
    } catch (e) {
      storageError = e;
    }
    if (storageError) {
      console.error(`[upload-documento] etapa=almacenamiento ${errorSeguro(storageError)}`);
      // Un corte por plazo puede haber dejado el objeto: se intenta borrar.
      if (storageError instanceof PlazoAgotado) {
        await eliminarArchivo(sb, storagePath, Math.min(RESERVA_LIMPIEZA_MS, restante()));
        return responder({ error: MENSAJE_PLAZO }, 503);
      }
      return responder({ error: 'No se pudo guardar el documento. Intenta de nuevo.' }, 500);
    }

    etapa = 'registro';
    let registro: { data: unknown; error: { code?: string } | null };
    try {
      registro = await conPlazo(PLAZO_REGISTRO_MS, (signal) => sb.rpc('registrar_documento_institucional', {
        p_documento: {
          nombre_archivo: nombreVisible,
          tipo: mime,
          contenido_texto: textoProtegido.slice(0, 5000),
          categoria,
          descripcion,
          institucion_id: institucionId,
          tamano_bytes: buffer.length,
          hash_archivo: hash,
          storage_path: storagePath,
        },
        p_fragmentos: fragmentos.map((chunk_texto, chunk_index) => ({ chunk_index, chunk_texto, embedding: vectorComoTexto(embeddings[chunk_index]) })),
      }).abortSignal(signal));
    } catch (e) {
      registro = { data: null, error: e instanceof PlazoAgotado ? null : { code: undefined } };
      if (!(e instanceof PlazoAgotado)) console.error(`[upload-documento] etapa=registro ${errorSeguro(e)}`);
    }
    const documentoId = typeof registro.data === 'string' ? registro.data : null;
    if (!documentoId) {
      if (!esErrorDefinitivo(registro.error)) {
        // Resultado DESCONOCIDO (plazo o red): la transacción pudo
        // confirmarse completa. No se borra el archivo (quedaría un documento
        // sin original) ni se reintenta (podría duplicarse); si se confirmó,
        // volver a subirlo responde 409.
        console.error(`[upload-documento] etapa=registro resultado=desconocido`);
        return responder({ error: 'No pudimos confirmar si el documento se guardó. Si al volver a subirlo aparece como existente, ya quedó registrado.' }, 503);
      }
      // Error definitivo: la transacción se revirtió completa (ni documento
      // ni fragmentos); se borra el archivo privado recién subido.
      console.error(`[upload-documento] etapa=registro ${errorSeguro(registro.error)}`);
      await eliminarArchivo(sb, storagePath, Math.min(RESERVA_LIMPIEZA_MS, restante()));
      if (registro.error?.code === '23505') {
        return responder({ error: 'Este documento ya existe' }, 409);
      }
      return responder({ error: 'No se pudo indexar el documento. Intenta de nuevo.' }, 500);
    }

    // Solo conteos de protecciones aplicadas — nunca texto ni nombres.
    const protegidos = `nombres:${resumen.nombres},curp:${resumen.curp},contacto:${resumen.contacto},fechas:${resumen.fechas}`;
    console.log(`[upload-documento] resultado=indexado formato=${formato} fragmentos=${fragmentos.length} protegidos=${protegidos}`);
    return responder({ success: true, documento_id: documentoId, chunks_creados: fragmentos.length }, 200);
  } catch (err) {
    if (err instanceof PlazoAgotado) {
      console.error(`[upload-documento] etapa=${etapa} resultado=plazo_agotado`);
      return responder({ error: MENSAJE_PLAZO }, 503);
    }
    console.error(`[upload-documento] etapa=${etapa} ${errorSeguro(err)}`);
    return responder({ error: 'No fue posible procesar el documento en este momento. Intenta de nuevo.' }, 500);
  }
}
