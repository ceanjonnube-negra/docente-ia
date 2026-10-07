// scripts/verificar-aplicacion-firmada.ts
//
// V1-D2A/V1-D2A2 — pruebas deterministas (sin credenciales, sin red,
// sin Supabase, sin IA) del contrato HMAC SEPARADO de aplicación
// (lib/listaOficial/aplicacionFirmada.ts). Cubre la forma original del
// contrato (actualizar_dato, baja, payload global, HMAC/domain
// separation, compatibilidad histórica) más la división V1-D2A2 de
// 'alta' en alta_persona/alta_inscripcion (ver auditoría de diseño
// aprobada "persona vs. inscripción") — incluida la demostración
// explícita de que tipo:'alta' DEJÓ DE EXISTIR por completo, sin alias
// ni compatibilidad artificial (0 consumidores productivos del
// contrato al momento de este cambio).
//
// Se ejecuta con `npx tsx scripts/verificar-aplicacion-firmada.ts`.

import {
  esOperacionAplicableListaOficialValida,
  esPayloadAplicacionListaOficialValido,
  firmarAplicacionConSecreto,
  verificarAplicacionConSecreto,
  type PayloadAplicacionListaOficial,
  type OperacionAplicableListaOficial,
  type OperacionActualizarDatoAplicable,
  type OperacionAltaPersonaAplicable,
  type OperacionAltaInscripcionAplicable,
  type OperacionBajaAplicable,
} from '../lib/listaOficial/aplicacionFirmada'
import { firmarConSecreto, verificarConSecreto } from '../lib/listaOficial/propuestaFirmada'
import type { PayloadPropuestaListaOficial } from '../lib/asistente/tipos'
import { createHmac } from 'node:crypto'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const SECRETO = 'secreto-de-prueba-nunca-real-1234567890'

const OP_ACTUALIZAR: OperacionActualizarDatoAplicable = {
  tipo: 'actualizar_dato',
  alumnoId: 'a1',
  campo: 'curp',
  valorActual: 'VIXO030303MDGLPT06',
  valorPropuesto: 'JULO100101HDFPRN03',
}
const OP_ALTA_PERSONA: OperacionAltaPersonaAplicable = { tipo: 'alta_persona', nombre: 'Fernanda Castillo Ruiz', curp: null }
const OP_ALTA_INSCRIPCION: OperacionAltaInscripcionAplicable = { tipo: 'alta_inscripcion', alumnoId: 'a2' }
const OP_BAJA: OperacionBajaAplicable = { tipo: 'baja', alumnoId: 'a5', inscripcionId: 'i5' }

function payloadBase(operaciones: OperacionAplicableListaOficial[]): PayloadAplicacionListaOficial {
  return {
    docenteId: 'docente-1',
    conversacionId: 'conv-1',
    grupoId: 'grupo-1',
    generadoEn: '2026-10-05T12:00:00.000Z',
    rosterFingerprint: 'huella-de-prueba',
    operaciones,
  }
}

// ============================================================
// 1-5. actualizar_dato — sin cambios respecto a la versión anterior.
// ============================================================
{
  const sobre = firmarAplicacionConSecreto(payloadBase([OP_ACTUALIZAR]), SECRETO)
  verificar(verificarAplicacionConSecreto(sobre, SECRETO), '1. Contrato válido de actualizar CURP firma y verifica correctamente')

  const sobreValorActualNull = firmarAplicacionConSecreto(payloadBase([{ ...OP_ACTUALIZAR, valorActual: null }]), SECRETO)
  verificar(verificarAplicacionConSecreto(sobreValorActualNull, SECRETO), '2. valorActual: null es una forma válida (CURP_FALTANTE_EN_DB) y firma/verifica correctamente')

  const sobreValorActualAlterado = { payload: { ...sobre.payload, operaciones: [{ ...OP_ACTUALIZAR, valorActual: 'OTRA-CURP-DISTINTA000' }] }, firma: sobre.firma }
  verificar(!verificarAplicacionConSecreto(sobreValorActualAlterado, SECRETO), '3. Alterar valorActual después de firmar invalida la verificación')

  const sobreValorPropuestoAlterado = { payload: { ...sobre.payload, operaciones: [{ ...OP_ACTUALIZAR, valorPropuesto: 'RUME080505HQRSTN08' }] }, firma: sobre.firma }
  verificar(!verificarAplicacionConSecreto(sobreValorPropuestoAlterado, SECRETO), '4. Alterar valorPropuesto después de firmar invalida la verificación')

  const sobreAlumnoIdAlterado = { payload: { ...sobre.payload, operaciones: [{ ...OP_ACTUALIZAR, alumnoId: 'otro-alumno' }] }, firma: sobre.firma }
  verificar(!verificarAplicacionConSecreto(sobreAlumnoIdAlterado, SECRETO), '5. Alterar alumnoId después de firmar invalida la verificación')
}

// ============================================================
// 6-9. alta_persona — V1-D2A2: antes 'alta', ahora 'alta_persona'.
//      tipo:'alta' (la forma antigua) DEJA DE EXISTIR por completo.
// ============================================================
{
  const sobre = firmarAplicacionConSecreto(payloadBase([OP_ALTA_PERSONA]), SECRETO)
  verificar(verificarAplicacionConSecreto(sobre, SECRETO), '6. Contrato válido de alta_persona (nombre + curp null) firma y verifica correctamente')

  verificar(
    !esOperacionAplicableListaOficialValida({ ...OP_ALTA_PERSONA, alumnoId: 'no-deberia-existir' }),
    '7. alta_persona con alumnoId se rechaza — alta_persona JAMÁS debe llevar alumnoId (clave extra fuera del whitelist exacto)'
  )
  verificar(
    !esOperacionAplicableListaOficialValida({ ...OP_ALTA_PERSONA, inscripcionId: 'no-deberia-existir' }),
    '8. alta_persona con inscripcionId se rechaza — mismo criterio, nunca reutiliza/fusiona historial'
  )
  verificar(
    !esOperacionAplicableListaOficialValida({ tipo: 'alta', nombre: 'Fernanda Castillo Ruiz', curp: null }),
    '9. tipo:\'alta\' (la forma ANTIGUA, pre-V1-D2A2) se rechaza explícitamente — dejó de existir, sin alias ni compatibilidad artificial'
  )
}

// ============================================================
// 10-13. alta_inscripcion — V1-D2A2, variante NUEVA. Único anchor:
//      alumnoId (grupoId ya viaja firmado en el payload global; la
//      ausencia de inscripción activa se revalida server-side en la
//      futura RPC, nunca mediante un valor firmado adicional aquí).
// ============================================================
{
  const sobre = firmarAplicacionConSecreto(payloadBase([OP_ALTA_INSCRIPCION]), SECRETO)
  verificar(verificarAplicacionConSecreto(sobre, SECRETO), '10. Contrato válido de alta_inscripcion (solo alumnoId) firma y verifica correctamente')

  verificar(
    !esOperacionAplicableListaOficialValida({ ...OP_ALTA_INSCRIPCION, nombre: 'no-deberia-existir' }),
    '11. alta_inscripcion con nombre se rechaza — identidad ya fue resuelta antes de firmar, esta operación nunca decide quién es la persona'
  )
  verificar(
    !esOperacionAplicableListaOficialValida({ ...OP_ALTA_INSCRIPCION, curp: 'no-deberia-existir' }),
    '12. alta_inscripcion con curp se rechaza — mismo criterio'
  )
  verificar(
    !esOperacionAplicableListaOficialValida({ ...OP_ALTA_INSCRIPCION, inscripcionId: 'no-deberia-existir' }),
    '13. alta_inscripcion con inscripcionId se rechaza — la inscripción todavía no existe, es justamente lo que esta operación crea'
  )
}

// ============================================================
// 14-16. baja — sin cambios respecto a la versión anterior.
// ============================================================
{
  const sobre = firmarAplicacionConSecreto(payloadBase([OP_BAJA]), SECRETO)
  verificar(verificarAplicacionConSecreto(sobre, SECRETO), '14. Contrato válido de baja (alumnoId + inscripcionId) firma y verifica correctamente')

  const sobreInscripcionIdAlterado = { payload: { ...sobre.payload, operaciones: [{ ...OP_BAJA, inscripcionId: 'otra-inscripcion' }] }, firma: sobre.firma }
  verificar(!verificarAplicacionConSecreto(sobreInscripcionIdAlterado, SECRETO), '15. Alterar inscripcionId después de firmar invalida la verificación')

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructuring deliberado para omitir inscripcionId
  const { inscripcionId: _omitida, ...bajaSinInscripcionId } = OP_BAJA
  verificar(!esOperacionAplicableListaOficialValida(bajaSinInscripcionId), '16. baja sin inscripcionId se rechaza — es el único ID que dar_de_baja_inscripcion exige')
}

// ============================================================
// 17-20. grupoId / rosterFingerprint obligatorios en este contrato.
// ============================================================
{
  const base = payloadBase([OP_ACTUALIZAR])
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructuring deliberado para omitir grupoId
  const { grupoId: _g, ...sinGrupoId } = base
  verificar(!esPayloadAplicacionListaOficialValido(sinGrupoId), '17. grupoId ausente se rechaza en el contrato de aplicación (aquí es obligatorio, a diferencia del sobre histórico)')

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructuring deliberado para omitir rosterFingerprint
  const { rosterFingerprint: _rf, ...sinFingerprint } = base
  verificar(!esPayloadAplicacionListaOficialValido(sinFingerprint), '18. rosterFingerprint ausente se rechaza en el contrato de aplicación')

  const sobre = firmarAplicacionConSecreto(base, SECRETO)
  const sobreGrupoIdAlterado = { payload: { ...sobre.payload, grupoId: 'otro-grupo' }, firma: sobre.firma }
  verificar(!verificarAplicacionConSecreto(sobreGrupoIdAlterado, SECRETO), '19. Alterar grupoId después de firmar invalida la verificación')

  const sobreFingerprintAlterado = { payload: { ...sobre.payload, rosterFingerprint: 'otra-huella' }, firma: sobre.firma }
  verificar(!verificarAplicacionConSecreto(sobreFingerprintAlterado, SECRETO), '20. Alterar rosterFingerprint después de firmar invalida la verificación')
}

// ============================================================
// 21-24. Formas inválidas generales.
// ============================================================
{
  verificar(!esPayloadAplicacionListaOficialValido(payloadBase([])), '21. operaciones=[] se rechaza — un lote de aplicación vacío no tiene sentido')

  const payloadConClaveExtra = { ...payloadBase([OP_ACTUALIZAR]), extra: 'no deberia existir' }
  verificar(!esPayloadAplicacionListaOficialValido(payloadConClaveExtra), '22. Una clave desconocida a nivel payload rechaza el contrato completo')

  const operacionConClaveExtra = { ...OP_ACTUALIZAR, observacion: 'no deberia existir' }
  verificar(!esOperacionAplicableListaOficialValida(operacionConClaveExtra), '23. Una clave desconocida dentro de una operación (ej. actualizar_dato) la rechaza completa')

  verificar(!esOperacionAplicableListaOficialValida({ tipo: 'algo_desconocido', alumnoId: 'a1' }), '24. Un tipo de operación desconocido se rechaza explícitamente')
}

// ============================================================
// 25. conflicto/requiere_confirmacion NUNCA son firmables — en runtime
//     Y en tiempo de compilación.
// ============================================================
{
  verificar(!esOperacionAplicableListaOficialValida({ tipo: 'conflicto', alumnoId: 'a1' }), '25. tipo:\'conflicto\' se rechaza en runtime')
  verificar(!esOperacionAplicableListaOficialValida({ tipo: 'requiere_confirmacion', alumnoId: 'a1' }), '25b. tipo:\'requiere_confirmacion\' se rechaza en runtime')

  // Prueba de tipo en tiempo de COMPILACIÓN — si la unión discriminada
  // alguna vez se ampliara por error para aceptar 'conflicto', esta
  // línea dejaría de necesitar @ts-expect-error y `npx tsc` fallaría
  // con "Unused '@ts-expect-error' directive", delatando la regresión
  // antes de que cualquier prueba en runtime tuviera que detectarla.
  // @ts-expect-error — 'conflicto' no es un valor de `tipo` válido en OperacionAplicableListaOficial; esto NUNCA debe compilar.
  const operacionImposible: OperacionAplicableListaOficial = { tipo: 'conflicto', alumnoId: 'a1' }
  verificar(typeof operacionImposible === 'object', '25c. (ver @ts-expect-error arriba) la unión discriminada hace estructuralmente imposible construir tipo:\'conflicto\' sin que tsc falle')
}

// ============================================================
// 26-29. Compatibilidad histórica y separación de contratos.
// ============================================================
{
  // 26 — el sobre histórico read-only (propuestaFirmada.ts) sigue
  // firmando/verificando exactamente como en V1-D1, sin ninguna
  // interferencia de este archivo nuevo.
  const payloadHistorico: PayloadPropuestaListaOficial = {
    docenteId: 'docente-1',
    conversacionId: 'conv-1',
    generadoEn: '2026-10-05T12:00:00.000Z',
    propuesta: [{ alumnoId: 'a1', campo: 'curp', valorPropuesto: 'JULO100101HDFPRN03' }],
  }
  const sobreHistorico = firmarConSecreto(payloadHistorico, SECRETO)
  verificar(verificarConSecreto(sobreHistorico, SECRETO), '26. El sobre histórico read-only (propuestaFirmada.ts) sigue firmando/verificando igual que en V1-D1')

  // 27 — sin grupoId/rosterFingerprint, la forma canónica histórica
  // sigue siendo exactamente la de 4 claves (ya probado en V1-D1;
  // repetido aquí para demostrar que coexiste sin cambios junto al
  // contrato nuevo).
  verificar(
    !('grupoId' in sobreHistorico.payload) && !('rosterFingerprint' in sobreHistorico.payload),
    '27. La firma histórica sin grupoId/rosterFingerprint sigue canonicalizando exactamente igual (4 claves, sin inventar ninguna)'
  )

  // 28 — CRÍTICO: el sobre histórico (forma propuesta/sin grupoId/sin
  // rosterFingerprint) NUNCA debe ser aceptado por el validador del
  // contrato de aplicación, y viceversa — son contratos estructuralmente
  // distintos, nunca intercambiables por accidente.
  verificar(
    !esPayloadAplicacionListaOficialValido(sobreHistorico.payload),
    '28. El contrato de aplicación RECHAZA la forma histórica read-only (le faltan grupoId/rosterFingerprint y usa `propuesta` en vez de `operaciones`)'
  )
  verificar(
    !verificarAplicacionConSecreto(sobreHistorico, SECRETO),
    '28b. verificarAplicacionConSecreto rechaza un sobre histórico real (firmado válidamente con propuestaFirmada.ts) por forma, no solo por firma'
  )
  const sobreAplicacion = firmarAplicacionConSecreto(payloadBase([OP_ACTUALIZAR]), SECRETO)
  verificar(
    !('rosterFingerprint' in payloadHistorico) && !esPayloadAplicacionListaOficialValido(payloadHistorico) === true,
    '28c. (reafirmación) un payload histórico nunca pasa la validación del contrato de aplicación'
  )
  verificar(
    typeof (sobreAplicacion.payload as unknown as PayloadPropuestaListaOficial).propuesta === 'undefined',
    '29. El contrato de aplicación nunca produce accidentalmente una clave `propuesta` (usa `operaciones`) — separación real, no solo nominal'
  )
}

// ============================================================
// A. Strings de solo espacios SIEMPRE rechazadas en todo campo
//    obligatorio — corrección fail-closed post-auditoría final.
// ============================================================
{
  const base = payloadBase([OP_ACTUALIZAR])
  verificar(!esPayloadAplicacionListaOficialValido({ ...base, docenteId: '   ' }), 'A1. docenteId de solo espacios se rechaza')
  verificar(!esPayloadAplicacionListaOficialValido({ ...base, conversacionId: '   ' }), 'A2. conversacionId de solo espacios se rechaza')
  verificar(!esPayloadAplicacionListaOficialValido({ ...base, grupoId: '   ' }), 'A3. grupoId de solo espacios se rechaza')
  verificar(!esPayloadAplicacionListaOficialValido({ ...base, generadoEn: '   ' }), 'A4. generadoEn de solo espacios se rechaza')
  verificar(!esPayloadAplicacionListaOficialValido({ ...base, rosterFingerprint: '   ' }), 'A5. rosterFingerprint de solo espacios se rechaza')

  verificar(!esOperacionAplicableListaOficialValida({ ...OP_ACTUALIZAR, alumnoId: '   ' }), 'A6. actualizar_dato.alumnoId de solo espacios se rechaza')
  verificar(!esOperacionAplicableListaOficialValida({ ...OP_ACTUALIZAR, valorPropuesto: '   ' }), 'A7. actualizar_dato.valorPropuesto de solo espacios se rechaza')
  verificar(!esOperacionAplicableListaOficialValida({ ...OP_ACTUALIZAR, valorActual: '   ' }), 'A8. actualizar_dato.valorActual de solo espacios se rechaza (null SÍ sigue siendo válido, ver prueba 2)')

  verificar(!esOperacionAplicableListaOficialValida({ ...OP_ALTA_PERSONA, nombre: '   ' }), 'A9. alta_persona.nombre de solo espacios se rechaza')
  verificar(!esOperacionAplicableListaOficialValida({ ...OP_ALTA_PERSONA, nombre: '' }), 'A9b. alta_persona.nombre vacío (\'\') se rechaza')
  verificar(!esOperacionAplicableListaOficialValida({ ...OP_ALTA_PERSONA, curp: '   ' }), 'A10. alta_persona.curp de solo espacios se rechaza (null SÍ sigue siendo válido, ver prueba 6)')
  verificar(esOperacionAplicableListaOficialValida({ ...OP_ALTA_PERSONA, curp: 'RUME080505HQRSTN08' }), 'A10b. alta_persona.curp con contenido real no vacío es válido a nivel de forma')

  verificar(!esOperacionAplicableListaOficialValida({ ...OP_BAJA, alumnoId: '   ' }), 'A11. baja.alumnoId de solo espacios se rechaza')
  verificar(!esOperacionAplicableListaOficialValida({ ...OP_BAJA, inscripcionId: '   ' }), 'A12. baja.inscripcionId de solo espacios se rechaza')

  verificar(!esOperacionAplicableListaOficialValida({ ...OP_ALTA_INSCRIPCION, alumnoId: '   ' }), 'A13. alta_inscripcion.alumnoId de solo espacios se rechaza')
  verificar(!esOperacionAplicableListaOficialValida({ ...OP_ALTA_INSCRIPCION, alumnoId: '' }), 'A14. alta_inscripcion.alumnoId vacío (\'\') se rechaza')
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructuring deliberado para omitir alumnoId
  const { alumnoId: _omitidaAltaIns, ...altaInscripcionSinAlumnoId } = OP_ALTA_INSCRIPCION
  verificar(!esOperacionAplicableListaOficialValida(altaInscripcionSinAlumnoId), 'A15. alta_inscripcion sin alumnoId se rechaza — es el único ID que esta operación requiere')
  verificar(!esOperacionAplicableListaOficialValida({ tipo: 'alta_inscripcion' } as unknown as Record<string, unknown>), 'A15b. alta_inscripcion sin ninguna clave adicional (solo tipo) se rechaza')
}

// ============================================================
// B. valorActual permanece RAW — el trim() de la sección A solo valida
//    que exista contenido real; el valor en sí nunca se normaliza.
// ============================================================
{
  const opConEspacios: OperacionActualizarDatoAplicable = { ...OP_ACTUALIZAR, valorActual: ' abcDef123 ' }
  const payloadOriginal = payloadBase([opConEspacios])
  // Snapshot profundo ANTES de firmar, para demostrar que firmar no muta el objeto de entrada.
  const snapshotAntes = JSON.parse(JSON.stringify(payloadOriginal))

  const sobre = firmarAplicacionConSecreto(payloadOriginal, SECRETO)

  verificar(JSON.stringify(payloadOriginal) === JSON.stringify(snapshotAntes), 'B1. El payload original (con valorActual=\' abcDef123 \') no fue mutado al firmar')
  verificar((sobre.payload.operaciones[0] as OperacionActualizarDatoAplicable).valorActual === ' abcDef123 ', 'B2. El payload canónico devuelto conserva valorActual EXACTAMENTE RAW (espacios incluidos)')
  verificar(verificarAplicacionConSecreto(sobre, SECRETO), 'B3. Verificar con el mismo valor RAW (\' abcDef123 \') funciona correctamente')

  const sobreSinEspacios = { payload: { ...sobre.payload, operaciones: [{ ...opConEspacios, valorActual: 'abcDef123' }] }, firma: sobre.firma }
  verificar(!verificarAplicacionConSecreto(sobreSinEspacios, SECRETO), 'B4. Sustituir valorActual por la misma cadena SIN espacios (\'abcDef123\') invalida la firma — nunca se trimea de forma oculta')

  const sobreOtrasMayusculas = { payload: { ...sobre.payload, operaciones: [{ ...opConEspacios, valorActual: ' ABCdef123 ' }] }, firma: sobre.firma }
  verificar(!verificarAplicacionConSecreto(sobreOtrasMayusculas, SECRETO), 'B5. Sustituir valorActual por una variante con mayúsculas/minúsculas distintas invalida la firma — nunca se normaliza mayúsculas de forma oculta')
}

// ============================================================
// C. CURP sintácticamente inválida pero no vacía — decisión
//    arquitectónica INTENCIONAL: este módulo valida FORMA, nunca
//    estructura real de CURP (eso es responsabilidad exclusiva de la
//    futura RPC — validarEstructuraCurp/validar_estructura_curp_sql).
// ============================================================
{
  verificar(
    esOperacionAplicableListaOficialValida({ ...OP_ALTA_PERSONA, curp: 'XXX' }),
    'C1. alta_persona.curp=\'XXX\' (estructura de CURP inválida) PASA el contrato de FORMA — intencional, no una omisión: la estructura real se valida en la futura RPC'
  )
  verificar(
    esOperacionAplicableListaOficialValida({ ...OP_ACTUALIZAR, valorPropuesto: 'XXX' }),
    'C2. actualizar_dato.valorPropuesto=\'XXX\' (estructura de CURP inválida) PASA el contrato de FORMA — mismo criterio intencional, consistente con esCambioListaOficialValido en propuestaFirmada.ts'
  )
}

// ============================================================
// D. Firma malformada — debe devolver false, nunca lanzar.
// ============================================================
{
  const sobre = firmarAplicacionConSecreto(payloadBase([OP_ACTUALIZAR]), SECRETO)

  let lanzoLongitudIncorrecta = false
  let resultadoLongitudIncorrecta: boolean | null = null
  try {
    resultadoLongitudIncorrecta = verificarAplicacionConSecreto({ payload: sobre.payload, firma: 'ab' }, SECRETO)
  } catch {
    lanzoLongitudIncorrecta = true
  }
  verificar(!lanzoLongitudIncorrecta && resultadoLongitudIncorrecta === false, 'D1. Firma con longitud incorrecta (\'ab\') devuelve false sin lanzar')

  let lanzoNoHex = false
  let resultadoNoHex: boolean | null = null
  try {
    resultadoNoHex = verificarAplicacionConSecreto({ payload: sobre.payload, firma: 'esto-no-es-hexadecimal-en-absoluto' }, SECRETO)
  } catch {
    lanzoNoHex = true
  }
  verificar(!lanzoNoHex && resultadoNoHex === false, 'D2. Firma con caracteres no hexadecimales devuelve false sin lanzar')
}

// ============================================================
// E. Domain separation del HMAC.
// ============================================================
{
  const payload = payloadBase([OP_ACTUALIZAR])
  const sobre = firmarAplicacionConSecreto(payload, SECRETO)

  // E1 — una firma calculada CON el dominio de aplicación (la que de
  // verdad produce firmarAplicacionConSecreto) verifica correctamente.
  verificar(verificarAplicacionConSecreto(sobre, SECRETO), 'E1. Una firma calculada con el dominio de aplicación verifica correctamente')

  // E2 — una firma calculada sobre el MISMO JSON canónico pero SIN el
  // prefijo de dominio (como si alguien hubiera firmado directamente
  // JSON.stringify(payload), igual que propuestaFirmada.ts) NO debe
  // verificar bajo verificarAplicacionConSecreto — demuestra que el
  // dominio realmente participa en el HMAC, no solo en la documentación.
  // Se reconstruye aquí mismo, sin exportar ninguna constante/función
  // interna de aplicacionFirmada.ts, usando únicamente el payload
  // canónico YA DEVUELTO por la API pública (mismo orden de claves).
  const firmaSinDominio = createHmac('sha256', SECRETO).update(JSON.stringify(sobre.payload)).digest('hex')
  verificar(
    !verificarAplicacionConSecreto({ payload: sobre.payload, firma: firmaSinDominio }, SECRETO),
    'E2. Una firma calculada SOLO sobre el JSON canónico (sin el dominio de aplicación) NO verifica — el dominio participa realmente en el HMAC'
  )

  // E3 — el contrato histórico (propuestaFirmada.ts) nunca tuvo ni
  // necesita domain separation propia; sigue firmando/verificando
  // exactamente igual, confirmando que agregarla aquí no lo afectó.
  const payloadHistoricoE: PayloadPropuestaListaOficial = {
    docenteId: 'docente-1',
    conversacionId: 'conv-1',
    generadoEn: '2026-10-05T12:00:00.000Z',
    propuesta: [{ alumnoId: 'a1', campo: 'curp', valorPropuesto: 'JULO100101HDFPRN03' }],
  }
  const sobreHistoricoE = firmarConSecreto(payloadHistoricoE, SECRETO)
  verificar(verificarConSecreto(sobreHistoricoE, SECRETO), 'E3. El contrato histórico (propuestaFirmada.ts) sigue firmando/verificando igual — domain separation del contrato de aplicación no lo afectó')
}

// ============================================================
// F. HMAC específico de alta_inscripcion.
// ============================================================
{
  const sobre = firmarAplicacionConSecreto(payloadBase([OP_ALTA_INSCRIPCION]), SECRETO)
  verificar(verificarAplicacionConSecreto(sobre, SECRETO), 'F1. firmar/verificar alta_inscripcion funciona correctamente')

  const sobreAlumnoIdAlterado = { payload: { ...sobre.payload, operaciones: [{ ...OP_ALTA_INSCRIPCION, alumnoId: 'otro-alumno' }] }, firma: sobre.firma }
  verificar(!verificarAplicacionConSecreto(sobreAlumnoIdAlterado, SECRETO), 'F2. Alterar alumnoId de alta_inscripcion después de firmar invalida la verificación')

  // F3 — convertir alta_inscripcion en alta_persona CONSERVANDO la
  // firma original debe fallar: cambia el `tipo` y la forma canónica
  // completa (nombre/curp vs. alumnoId), así que la firma esperada ya
  // no coincide. Demuestra que el discriminador `tipo` también queda
  // cubierto por el HMAC, no solo los valores de cada campo.
  const sobreConvertidoAPersona = {
    payload: { ...sobre.payload, operaciones: [{ tipo: 'alta_persona', nombre: 'Alguien Distinto', curp: null }] },
    firma: sobre.firma,
  }
  verificar(!verificarAplicacionConSecreto(sobreConvertidoAPersona, SECRETO), 'F3. Convertir alta_inscripcion en alta_persona conservando la firma original invalida la verificación')

  // F4 — agregar un campo extra (aunque la firma se recalculara sobre
  // el objeto alterado, esPayloadAplicacionListaOficialValido rechaza
  // la forma ANTES de llegar a comparar HMAC — ver tieneExactamenteLasClaves).
  const sobreConCampoExtra = { payload: { ...sobre.payload, operaciones: [{ ...OP_ALTA_INSCRIPCION, extra: 'no deberia existir' }] }, firma: sobre.firma }
  verificar(!verificarAplicacionConSecreto(sobreConCampoExtra, SECRETO), 'F4. Agregar un campo extra a alta_inscripcion después de firmar falla (rechazado por forma, nunca llega a comparar el HMAC)')

  // F5 — eliminar el único campo (alumnoId) deja un objeto sin forma
  // válida — rechazado de la misma manera, antes de comparar HMAC.
  const sobreSinAlumnoId = { payload: { ...sobre.payload, operaciones: [{ tipo: 'alta_inscripcion' }] }, firma: sobre.firma }
  verificar(!verificarAplicacionConSecreto(sobreSinAlumnoId, SECRETO), 'F5. Eliminar el campo alumnoId de alta_inscripcion después de firmar falla (rechazado por forma)')
}

// ============================================================
// G. Lote mixto — las 4 variantes conviviendo en un mismo sobre.
// ============================================================
{
  const sobre = firmarAplicacionConSecreto(payloadBase([OP_ACTUALIZAR, OP_ALTA_PERSONA, OP_ALTA_INSCRIPCION, OP_BAJA]), SECRETO)
  verificar(verificarAplicacionConSecreto(sobre, SECRETO), 'G1. Un lote mixto (actualizar_dato + alta_persona + alta_inscripcion + baja) firma y verifica correctamente')
  verificar(sobre.payload.operaciones.length === 4, 'G2. Las 4 operaciones del lote mixto se preservan tal cual, sin perder ninguna')
  verificar(
    sobre.payload.operaciones.map((o) => o.tipo).join(',') === 'actualizar_dato,alta_persona,alta_inscripcion,baja',
    'G3. El orden de las operaciones del lote mixto se preserva exactamente (nunca se reordena)'
  )

  // Alterar solo la operación alta_inscripcion (3ª del lote) invalida
  // la firma completa del sobre — ninguna operación individual puede
  // alterarse sin invalidar el lote entero.
  const sobreAlterado = {
    payload: { ...sobre.payload, operaciones: [sobre.payload.operaciones[0], sobre.payload.operaciones[1], { ...OP_ALTA_INSCRIPCION, alumnoId: 'otro' }, sobre.payload.operaciones[3]] },
    firma: sobre.firma,
  }
  verificar(!verificarAplicacionConSecreto(sobreAlterado, SECRETO), 'G4. Alterar una sola operación (alta_inscripcion) dentro de un lote mixto invalida la firma de TODO el sobre')
}

console.log('')
if (fallos > 0) {
  console.error(`${fallos} prueba(s) fallaron.`)
  process.exit(1)
}
console.log('Todas las pruebas pasaron.')
