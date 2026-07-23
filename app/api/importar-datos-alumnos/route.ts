import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

// FASE 1A — "Protección de endpoints críticos": este endpoint quedó
// deshabilitado a propósito. Confirmado dos veces (auditoría técnica
// completa + verificación fresca con grep antes de esta implementación)
// que no tiene NINGÚN consumidor real en app/, components/ ni lib/.
// Antes de este cambio ya recibía access_token y validaba sesión, pero
// tomaba docente_id literal del FormData sin compararlo contra el
// usuario real del token — un hueco de autorización real, aunque sin
// tráfico que lo explotara. No se elimina el archivo (la funcionalidad
// — actualizar CURP/sexo/fecha de nacimiento desde una foto de lista
// oficial — es real y podría conectarse en una fase posterior, con la
// corrección de autorización pendiente), pero mientras no tenga
// consumidores no debe procesar datos, consultar alumnos ni consumir
// servicios de IA. Pendiente decidir en una fase posterior: conectarlo
// a un flujo real (corrigiendo el uso de docente_id) o eliminarlo.
export async function POST() {
  return NextResponse.json(
    { error: 'Este endpoint fue descontinuado por no tener consumidores activos.' },
    { status: 410 }
  );
}
