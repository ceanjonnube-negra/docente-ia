// scripts/verificar-eliminacion-concurrente.ts
//
// Etapa 3B-1: concurrencia real entre eliminar_conversacion y la
// escritura de mensajes, con dos sesiones de PostgreSQL en paralelo.
//   1. Eliminación en curso → un INSERT de mensaje simultáneo ESPERA y,
//      al terminar la eliminación, se rechaza (no queda ningún mensaje
//      dentro de una conversación eliminada).
//   2. INSERT en curso → la eliminación espera y luego borra también ese
//      mensaje.
//   3. Control: la eliminación no bloquea escrituras en OTRA conversación.
//
// Necesita una base de PRUEBA con la migración aplicada (p. ej. una
// réplica local). Crea datos ficticios con commit y los borra al final,
// así que exige confirmación explícita y nunca debe apuntarse a E2E ni a
// Production sin autorización:
//   PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGDATABASE=replica \
//   CONFIRMAR_BASE_DE_PRUEBA=replica npx tsx scripts/verificar-eliminacion-concurrente.ts

import { spawn, spawnSync } from 'node:child_process'

export {}

if (!process.env.PGDATABASE || process.env.CONFIRMAR_BASE_DE_PRUEBA !== process.env.PGDATABASE) {
  console.error('Define PGDATABASE y CONFIRMAR_BASE_DE_PRUEBA con el mismo nombre de una base de PRUEBA.')
  process.exit(2)
}

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

const A = 'ad000000-0000-4000-8000-0000000000ad'
const INST = '1d000000-0000-4000-8000-00000000001d'
const CONV = (n: number) => `cc00000${n}-0000-4000-8000-0000000000cc`
const COMO_A = `set role authenticated; select set_config('request.jwt.claim.sub', '${A}', false);`

function psql(sql: string): { ok: boolean; salida: string } {
  const r = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' })
  return { ok: r.status === 0, salida: `${r.stdout}${r.stderr}` }
}

// Sesión en paralelo: devuelve { ok, salida, ms } al terminar.
function sesion(sql: string, retrasoMs = 0): Promise<{ ok: boolean; salida: string; ms: number }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const inicio = Date.now()
      const p = spawn('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql])
      let salida = ''
      p.stdout.on('data', (d) => (salida += d))
      p.stderr.on('data', (d) => (salida += d))
      p.on('close', (code) => resolve({ ok: code === 0, salida, ms: Date.now() - inicio }))
    }, retrasoMs)
  })
}

const insertarMensaje = (conv: string, id: string) =>
  `insert into public.mensajes_chat (id, conversacion_id, docente_id, rol, texto) values ('${conv}:${id}', '${conv}', '${A}', 'usuario', 'ficticio')`
const mensajesDe = (conv: string) => Number(psql(`select count(*) from public.mensajes_chat where conversacion_id = '${conv}'`).salida.trim())

function limpiar() {
  psql(`delete from public.mensajes_chat where docente_id = '${A}'; delete from public.conversaciones_chat where docente_id = '${A}'; delete from public.perfiles_docentes where id = '${A}'; delete from public.instituciones where id = '${INST}'; delete from auth.users where id = '${A}';`)
}

async function main() {
  limpiar()
  const fixture = psql(`
    insert into auth.users (id) values ('${A}');
    insert into public.instituciones (id, nombre) values ('${INST}', 'Escuela ficticia (concurrencia)');
    insert into public.perfiles_docentes (id) values ('${A}');
    insert into public.conversaciones_chat (id, docente_id) values ('${CONV(1)}', '${A}'), ('${CONV(2)}', '${A}'), ('${CONV(3)}', '${A}');`)
  if (!fixture.ok) {
    console.error('No se pudieron crear los datos ficticios:', fixture.salida)
    process.exit(1)
  }

  try {
    // 1. Eliminación en curso (lock 2 s) → el INSERT espera y se rechaza.
    const [elim1, ins1, otra] = await Promise.all([
      sesion(`begin; ${COMO_A} select public.eliminar_conversacion('${CONV(1)}'); select pg_sleep(2); commit;`),
      sesion(`${COMO_A} ${insertarMensaje(CONV(1), 'tardio')};`, 500),
      sesion(`${COMO_A} ${insertarMensaje(CONV(3), 'control')};`, 500),
    ])
    verificar(elim1.ok && ins1.ms >= 1200, `1a. El INSERT simultáneo esperó a la eliminación (${ins1.ms} ms)`)
    verificar(!ins1.ok && /row-level security|seguridad de registros|42501/i.test(ins1.salida), '1b. Al terminar la eliminación, el INSERT se rechazó por RLS')
    verificar(mensajesDe(CONV(1)) === 0, '1c. No quedó ningún mensaje dentro de la conversación eliminada')
    verificar(otra.ok && otra.ms < 1000 && mensajesDe(CONV(3)) === 1, `3a. Control: escribir en otra conversación no se bloquea (${otra.ms} ms)`)

    // 2. INSERT en curso (lock 2 s) → la eliminación espera y lo borra.
    const [ins2, elim2] = await Promise.all([
      sesion(`begin; ${COMO_A} ${insertarMensaje(CONV(2), 'en-curso')}; select pg_sleep(2); commit;`),
      sesion(`${COMO_A} select public.eliminar_conversacion('${CONV(2)}');`, 500),
    ])
    verificar(ins2.ok && elim2.ok && elim2.ms >= 1200, `2a. La eliminación esperó al INSERT en curso (${elim2.ms} ms)`)
    verificar(/"mensajes": 1/.test(elim2.salida) && mensajesDe(CONV(2)) === 0, '2b. La eliminación borró también el mensaje que se estaba insertando')
  } finally {
    limpiar()
  }
  verificar(Number(psql(`select count(*) from public.conversaciones_chat where docente_id = '${A}'`).salida.trim()) === 0, '4a. Datos ficticios eliminados al terminar')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  }
  console.log('Todas las pruebas pasaron.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
