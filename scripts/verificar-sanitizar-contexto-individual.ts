// scripts/verificar-sanitizar-contexto-individual.ts
//
// Prueba aislada (sin credenciales, sin red, sin IA) de
// lib/programaAnalitico/sanitizarContextoIndividual.ts — PA-5D.
// Cubre la lógica pura de anonimización determinista contra el roster
// real del grupo. La integración completa (dentro de
// manejarTurnoProgramaAnalitico, con persistencia real en el borrador
// falso) se prueba en scripts/verificar-manejar-turno-programa-analitico.ts
// (casos PA5D-*).
//
// Se ejecuta con `npx tsx scripts/verificar-sanitizar-contexto-individual.ts`.

import { sanitizarContextoPedagogicoAdjunto } from '../lib/programaAnalitico/sanitizarContextoIndividual'
import type { ContextoPedagogicoAdjunto } from '../lib/programaAnalitico/contextoAdjuntoProgramaAnalitico'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const ROSTER = [{ nombreCompleto: 'Halit Eduardo Trejo Álvarez' }, { nombreCompleto: 'Ana Sofía Ramírez Cortés' }]

function contexto(observaciones: string[], lecturasDudosas: string[] = []): ContextoPedagogicoAdjunto {
  return { hayContextoPedagogico: observaciones.length > 0, observaciones, lecturasDudosas }
}

// --- H1. nombre completo exacto → eliminado/anonimizado ---
{
  const r = sanitizarContextoPedagogicoAdjunto(
    contexto(['El alumno 24 (Halit Eduardo Trejo Álvarez) presenta niveles 2 en varias áreas, indicando que está en proceso.']),
    ROSTER
  )
  verificar(!r.observaciones[0].includes('Halit Eduardo Trejo Álvarez'), 'H1. nombre completo exacto del roster → desaparece del texto')
  verificar(r.observaciones[0].includes('un alumno del grupo'), 'H1b. se sustituye por una formulación neutral grupal')
}

// --- H2. mayúsculas/acentos distintos → protegido igual ---
{
  const variantes = [
    'HALIT EDUARDO TREJO ALVAREZ requiere apoyo en lectura.',
    'halit eduardo trejo alvarez requiere apoyo en lectura.',
    'Halit   Eduardo   Trejo   Álvarez requiere apoyo en lectura.', // espacios extra
  ]
  for (const v of variantes) {
    const r = sanitizarContextoPedagogicoAdjunto(contexto([v]), ROSTER)
    verificar(!/halit/i.test(r.observaciones[0]) && !/trejo/i.test(r.observaciones[0]), `H2. variante "${v.slice(0, 25)}..." → protegida por normalización (mayúsculas/acentos/espacios)`)
  }
}

// --- H3. palabras comunes que coinciden parcialmente → NO se eliminan ---
{
  const r = sanitizarContextoPedagogicoAdjunto(contexto(['El grupo muestra fortalezas en lectura y en el manejo de operaciones básicas.']), ROSTER)
  verificar(
    r.observaciones[0] === 'El grupo muestra fortalezas en lectura y en el manejo de operaciones básicas.',
    'H3. una observación sin coincidencia real con el roster completo queda intacta (nunca se activa por palabras sueltas)'
  )
}
{
  // "Ana" solo (nombre de pila suelto, sin apellidos) NUNCA debe activar la sanitización — solo el nombre CANÓNICO COMPLETO.
  const r = sanitizarContextoPedagogicoAdjunto(contexto(['Ana muestra buen avance en el área de escritura, según lo observado.']), ROSTER)
  verificar(r.observaciones[0].includes('Ana '), 'H3b. un nombre de pila suelto (no el nombre completo del roster) nunca se sanitiza por sí solo')
}

// --- H4. dos alumnos mencionados → ambos protegidos ---
{
  const r = sanitizarContextoPedagogicoAdjunto(
    contexto(['Halit Eduardo Trejo Álvarez y Ana Sofía Ramírez Cortés presentan niveles distintos en comprensión lectora.']),
    ROSTER
  )
  verificar(
    !r.observaciones[0].includes('Halit Eduardo Trejo Álvarez') && !r.observaciones[0].includes('Ana Sofía Ramírez Cortés'),
    'H4. dos alumnos distintos mencionados en la misma observación → ambos anonimizados'
  )
}

// --- H5. observación sin nombres → queda idéntica ---
{
  const original = 'Se identifican necesidades de fortalecimiento en fluidez lectora y comprensión de textos.'
  const r = sanitizarContextoPedagogicoAdjunto(contexto([original]), ROSTER)
  verificar(r.observaciones[0] === original, 'H5. una observación sin ningún nombre del roster queda byte a byte idéntica')
}

// --- H6. la información pedagógica alrededor del nombre se conserva ---
{
  const r = sanitizarContextoPedagogicoAdjunto(
    contexto(['Halit Eduardo Trejo Álvarez presenta niveles 2 en varias áreas, indicando que requiere orientación en lectura y escritura.']),
    ROSTER
  )
  verificar(
    r.observaciones[0].includes('niveles 2 en varias áreas') && r.observaciones[0].includes('requiere orientación en lectura y escritura'),
    'H6. el contenido pedagógico alrededor del nombre se conserva intacto, solo se retira la identidad'
  )
}

// --- H7. lecturasDudosas también se sanitizan ---
{
  const r = sanitizarContextoPedagogicoAdjunto(contexto(['Se observan indicadores de mejora.'], ['No queda claro si Halit Eduardo Trejo Álvarez alcanzó el nivel 3 o 4.']), ROSTER)
  verificar(!r.lecturasDudosas[0].includes('Halit Eduardo Trejo Álvarez'), 'H7. lecturasDudosas se sanitiza con el mismo criterio que observaciones')
}

// --- extra: CURP estructural también se sanitiza (identificador estructurado, §C) ---
{
  const r = sanitizarContextoPedagogicoAdjunto(contexto(['Se ve una CURP TREH120304HDFRLL09 anotada junto al diagnóstico.']), ROSTER)
  verificar(!r.observaciones[0].includes('TREH120304HDFRLL09'), 'extra. una CURP con formato estructural válido se omite del texto persistido')
}

// --- extra: contexto sin observaciones/lecturasDudosas (roster vacío o hayContextoPedagogico=false) no falla ---
{
  const r = sanitizarContextoPedagogicoAdjunto(contexto([]), ROSTER)
  verificar(r.hayContextoPedagogico === false && r.observaciones.length === 0, 'extra. contexto vacío se sanitiza sin error y conserva su forma')
}
{
  const r = sanitizarContextoPedagogicoAdjunto(contexto(['Halit Eduardo Trejo Álvarez requiere apoyo.']), [])
  verificar(r.observaciones[0].includes('Halit Eduardo Trejo Álvarez'), 'extra. roster vacío → no hay ningún patrón que aplicar, el texto no se altera (nunca falla)')
}

console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
process.exit(fallos === 0 ? 0 : 1)
