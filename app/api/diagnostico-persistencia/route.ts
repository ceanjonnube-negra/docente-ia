// app/api/diagnostico-persistencia/route.ts
//
// INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — ver auditoría "observabilidad
// del fallo silencioso de persistencia client-side tras respuesta-final"
// aprobada por separado (caso real: el servidor completó un ajuste de
// planeación con éxito — guardado=true en planeacion_activa — pero el
// mensaje B nunca llegó a mensajes_chat ni documento_activo se
// actualizó; la sospecha es una falla silenciosa de
// docenteIdActual()/supabase.auth.getUser() ocurrida DESPUÉS de que el
// stream de /api/chat ya había cerrado, así que el mecanismo de
// diagnóstico existente — que viaja embebido DENTRO del stream de
// /api/chat, ver diagnosticoCurpActivo en app/api/chat/route.ts —
// estructuralmente no puede capturarla).
//
// Único propósito: recibir eventos técnicos MÍNIMOS que el cliente ya
// genera en lib/asistente/persistencia.ts (ver
// reportarDiagnosticoPersistencia ahí) para que aparezcan en los logs
// de Vercel — el único lugar donde se pueden inspeccionar tras una
// prueba real en un iPhone, sin depender de la consola de Safari del
// dispositivo. Nunca persiste nada en Supabase, nunca lee/escribe
// ninguna tabla, nunca llama a ningún modelo de IA — es exclusivamente
// un console.log gateado.
//
// FAIL-CLOSED por entorno: en producción responde 200 sin loggear nada
// y sin siquiera leer el body — mismo criterio exacto que
// diagnosticoCurpActivo (VERCEL_ENV!=='production') ya usa en
// app/api/chat/route.ts, así que esto es estructuralmente imposible
// que genere ruido para un docente real. Dos llamadores cliente
// distintos, cada uno con su PROPIO gate independiente (nunca el mismo
// entre sí, a propósito — ver "aislar el fallo client-side previo a
// /api/chat en ejecutarEdicion()", que deliberadamente NO reutiliza el
// gate del otro para no volver a acoplar dos investigaciones
// distintas): reportarDiagnosticoPersistencia (lib/asistente/
// persistencia.ts) usa NEXT_PUBLIC_DIAGNOSTICO_CURP_ACTIVO;
// reportarDiagnosticoEnvioCliente (lib/asistente/AsistenteService.ts)
// usa NEXT_PUBLIC_DIAGNOSTICO_ENVIO_CLIENTE_ACTIVO. Esta comprobación
// server-side (VERCEL_ENV) es una segunda capa común a ambos, nunca la
// única.
//
// Retirar este archivo junto con el resto de la instrumentación
// diagnóstica temporal cuando termine de usarse.

import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  if (process.env.VERCEL_ENV === 'production') {
    return NextResponse.json({ ok: true })
  }
  try {
    const body = await req.json()
    // Whitelist explícita de campos — nunca se reenvía el body crudo.
    // Nada de contenido de mensajes, tokens, credenciales ni datos de
    // alumnos puede llegar aquí porque nunca se lee ningún campo fuera
    // de esta lista, sin importar qué mande el cliente.
    const evento = {
      ts: new Date().toISOString(),
      fase: typeof body?.fase === 'string' ? body.fase.slice(0, 60) : 'desconocida',
      mensajeId: typeof body?.mensajeId === 'string' ? body.mensajeId.slice(0, 80) : null,
      conversacionId: typeof body?.conversacionId === 'string' ? body.conversacionId.slice(0, 80) : null,
      userPresente: typeof body?.userPresente === 'boolean' ? body.userPresente : null,
      exito: typeof body?.exito === 'boolean' ? body.exito : null,
      errorCode: typeof body?.errorCode === 'string' ? body.errorCode.slice(0, 60) : null,
      esDocumentoActivo: typeof body?.esDocumentoActivo === 'boolean' ? body.esDocumentoActivo : null,
      ms: typeof body?.ms === 'number' ? Math.round(body.ms) : null,
      // INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — "aislar el fallo
      // client-side previo a /api/chat en ejecutarEdicion()" (ver
      // auditoría aprobada por separado): 3 campos booleanos nuevos,
      // reutilizando exactamente el mismo endpoint y el mismo criterio
      // de whitelist — nunca contenido, solo metadata técnica mínima.
      generando: typeof body?.generando === 'boolean' ? body.generando : null,
      motorPresente: typeof body?.motorPresente === 'boolean' ? body.motorPresente : null,
      documentoActivoPresente: typeof body?.documentoActivoPresente === 'boolean' ? body.documentoActivoPresente : null,
    }
    console.log(`[DIAG_PERSISTENCIA_CLIENTE] ${JSON.stringify(evento)}`)
  } catch {
    // best-effort puro: un body inválido nunca debe producir un error
    // visible para el cliente, esto no es tráfico funcional.
  }
  return NextResponse.json({ ok: true })
}
