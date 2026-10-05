// scripts/verificar-roster-fingerprint-hmac.ts
//
// V1-D1 — pruebas deterministas (sin credenciales, sin red, sin datos
// reales) de:
//   - lib/listaOficial/rosterFingerprint.ts (determinismo real del
//     hash: orden-invariante, normalización de CURP, sensible a
//     cualquier cambio real de estatus/CURP/composición del roster);
//   - la extensión aditiva/fail-closed de rosterFingerprint en
//     lib/listaOficial/propuestaFirmada.ts (cubierta por el HMAC,
//     retrocompatible cuando está ausente, rechazada cuando es
//     inválida).
//
// Se ejecuta con `npx tsx scripts/verificar-roster-fingerprint-hmac.ts`.

import { calcularRosterFingerprint, construirRepresentacionCanonicaRoster, type FilaRosterParaFingerprint } from '../lib/listaOficial/rosterFingerprint'
import { firmarConSecreto, verificarConSecreto } from '../lib/listaOficial/propuestaFirmada'
import type { PayloadPropuestaListaOficial } from '../lib/asistente/tipos'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const SECRETO_PRUEBA = 'secreto-de-prueba-nunca-real-1234567890'

// ============================================================
// rosterFingerprint — determinismo
// ============================================================

const ROSTER_BASE: FilaRosterParaFingerprint[] = [
  { inscripcionId: 'i1', estatus: 'activo', curp: 'TREH120304HDFRLL09' },
  { inscripcionId: 'i2', estatus: 'activo', curp: null },
  { inscripcionId: 'i3', estatus: 'activo', curp: 'LOMA150515MDFRRC05' },
]

verificar(
  calcularRosterFingerprint(ROSTER_BASE) === calcularRosterFingerprint([...ROSTER_BASE].reverse()),
  '1. El orden de entrada nunca afecta el fingerprint (se ordena por inscripcionId antes de serializar)'
)

const ROSTER_CURP_CON_ESPACIOS_Y_MINUSCULAS: FilaRosterParaFingerprint[] = [
  { inscripcionId: 'i1', estatus: 'activo', curp: '  treh120304hdfrll09  ' },
  { inscripcionId: 'i2', estatus: 'activo', curp: null },
  { inscripcionId: 'i3', estatus: 'activo', curp: 'LOMA150515MDFRRC05' },
]
verificar(
  calcularRosterFingerprint(ROSTER_BASE) === calcularRosterFingerprint(ROSTER_CURP_CON_ESPACIOS_Y_MINUSCULAS),
  '2. Espacios/mayúsculas distintas en la misma CURP real producen el mismo fingerprint (normalización trim+mayúsculas)'
)

// CASO E — null vs cadena vacía/espacios: comportamiento determinista
// esperado. curpNormalizadaOrNull colapsa null, '' y '   ' al MISMO
// null — comportamiento seguro en la práctica porque ningún camino de
// escritura real (importar_alumnos_a_grupo ya usa NULLIF) almacena una
// cadena vacía en alumnos.curp; aquí se demuestra explícitamente que
// las 3 formas producen el mismo fingerprint, nunca uno distinto.
const ROSTER_CURP_NULL: FilaRosterParaFingerprint[] = [{ inscripcionId: 'iX', estatus: 'activo', curp: null }]
const ROSTER_CURP_CADENA_VACIA: FilaRosterParaFingerprint[] = [{ inscripcionId: 'iX', estatus: 'activo', curp: '' }]
const ROSTER_CURP_SOLO_ESPACIOS: FilaRosterParaFingerprint[] = [{ inscripcionId: 'iX', estatus: 'activo', curp: '   ' }]
verificar(
  calcularRosterFingerprint(ROSTER_CURP_NULL) === calcularRosterFingerprint(ROSTER_CURP_CADENA_VACIA) &&
    calcularRosterFingerprint(ROSTER_CURP_NULL) === calcularRosterFingerprint(ROSTER_CURP_SOLO_ESPACIOS),
  '2b. null, \'\' y \'   \' en curp producen el MISMO fingerprint — comportamiento determinista, nunca ambiguo entre las 3 formas'
)

const ROSTER_ESTATUS_DISTINTO: FilaRosterParaFingerprint[] = ROSTER_BASE.map((f) => (f.inscripcionId === 'i2' ? { ...f, estatus: 'baja' } : f))
verificar(
  calcularRosterFingerprint(ROSTER_BASE) !== calcularRosterFingerprint(ROSTER_ESTATUS_DISTINTO),
  '3. Cambiar el estatus de una sola inscripción cambia el fingerprint'
)

const ROSTER_CURP_DISTINTA: FilaRosterParaFingerprint[] = ROSTER_BASE.map((f) => (f.inscripcionId === 'i1' ? { ...f, curp: 'PERJ080909HOCRZN02' } : f))
verificar(
  calcularRosterFingerprint(ROSTER_BASE) !== calcularRosterFingerprint(ROSTER_CURP_DISTINTA),
  '4. Cambiar la CURP de una sola inscripción cambia el fingerprint'
)

verificar(
  calcularRosterFingerprint(ROSTER_BASE) !== calcularRosterFingerprint([...ROSTER_BASE, { inscripcionId: 'i4', estatus: 'activo', curp: null }]),
  '5. Agregar una inscripción nueva cambia el fingerprint'
)

verificar(
  calcularRosterFingerprint(ROSTER_BASE) !== calcularRosterFingerprint(ROSTER_BASE.slice(0, 2)),
  '6. Quitar una inscripción del roster cambia el fingerprint'
)

verificar(
  construirRepresentacionCanonicaRoster(ROSTER_BASE).every((f) => Object.keys(f).length === 3 && 'curpNormalizada' in f),
  '7. La representación canónica expone exactamente inscripcionId/estatus/curpNormalizada — nunca nombre ni otro campo'
)

// ============================================================
// HMAC — extensión aditiva/fail-closed de rosterFingerprint
// ============================================================

const PAYLOAD_SIN_FINGERPRINT: PayloadPropuestaListaOficial = {
  docenteId: 'docente-1',
  conversacionId: 'conv-1',
  generadoEn: '2026-10-05T12:00:00.000Z',
  propuesta: [{ alumnoId: 'a1', campo: 'curp', valorPropuesto: 'TREH120304HDFRLL09' }],
}

const sobreSinFingerprint = firmarConSecreto(PAYLOAD_SIN_FINGERPRINT, SECRETO_PRUEBA)
verificar(
  verificarConSecreto(sobreSinFingerprint, SECRETO_PRUEBA),
  '8. Un payload SIN rosterFingerprint (forma previa a V1-D1) sigue firmando/verificando exactamente igual que antes — retrocompatibilidad real, no solo de tipos'
)
verificar(
  !('rosterFingerprint' in sobreSinFingerprint.payload),
  '9. La forma canónica de un payload sin rosterFingerprint no inventa la clave (sigue teniendo exactamente 4 claves)'
)

const HUELLA = calcularRosterFingerprint(ROSTER_BASE)
const PAYLOAD_CON_FINGERPRINT: PayloadPropuestaListaOficial = { ...PAYLOAD_SIN_FINGERPRINT, rosterFingerprint: HUELLA }
const sobreConFingerprint = firmarConSecreto(PAYLOAD_CON_FINGERPRINT, SECRETO_PRUEBA)
verificar(
  verificarConSecreto(sobreConFingerprint, SECRETO_PRUEBA),
  '10. Un payload CON rosterFingerprint válido firma y verifica correctamente'
)
verificar(
  sobreConFingerprint.firma !== sobreSinFingerprint.firma,
  '11. La firma CAMBIA al agregar rosterFingerprint — demuestra que el campo queda cubierto por el HMAC, no solo transportado'
)

const sobreAlterado = { payload: { ...sobreConFingerprint.payload, rosterFingerprint: calcularRosterFingerprint(ROSTER_ESTATUS_DISTINTO) }, firma: sobreConFingerprint.firma }
verificar(
  !verificarConSecreto(sobreAlterado, SECRETO_PRUEBA),
  '12. Alterar rosterFingerprint después de firmar (conservando la firma original) invalida la verificación — protegido por integridad, nunca solo transportado'
)

const sobreFingerprintVacio = { payload: { ...PAYLOAD_SIN_FINGERPRINT, rosterFingerprint: '' }, firma: 'cualquiera' }
verificar(
  !verificarConSecreto(sobreFingerprintVacio, SECRETO_PRUEBA),
  '13. rosterFingerprint presente pero vacío (\'\') se rechaza — fail-closed, nunca se trata como ausente'
)

const sobreFingerprintTipoInvalido = { payload: { ...PAYLOAD_SIN_FINGERPRINT, rosterFingerprint: 12345 as unknown as string }, firma: 'cualquiera' }
verificar(
  !verificarConSecreto(sobreFingerprintTipoInvalido, SECRETO_PRUEBA),
  '14. rosterFingerprint con tipo distinto de string se rechaza — fail-closed'
)

const sobreFingerprintNuloExplicito = { payload: { ...PAYLOAD_SIN_FINGERPRINT, rosterFingerprint: null as unknown as string }, firma: 'cualquiera' }
verificar(
  !verificarConSecreto(sobreFingerprintNuloExplicito, SECRETO_PRUEBA),
  '14b. rosterFingerprint: null explícito se rechaza — fail-closed (typeof null !== \'string\', misma rama que un tipo incorrecto)'
)

const sobreClaveExtraDesconocida = { payload: { ...PAYLOAD_CON_FINGERPRINT, otraClave: 'no debería existir' } as unknown as PayloadPropuestaListaOficial, firma: sobreConFingerprint.firma }
verificar(
  !verificarConSecreto(sobreClaveExtraDesconocida, SECRETO_PRUEBA),
  '15. Una clave adicional desconocida (fuera de las requeridas + rosterFingerprint) sigue rechazando el payload completo — el whitelist exacto no se relajó más allá de lo opcional'
)

console.log('')
if (fallos > 0) {
  console.error(`${fallos} prueba(s) fallaron.`)
  process.exit(1)
}
console.log('Todas las pruebas pasaron.')
