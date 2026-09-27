// scripts/verificar-hoja-canonica-por-proyecto.ts
//
// Blindaje "una hoja_evaluacion canónica por proyecto" — migración
// 20260927000000_hoja_canonica_por_proyecto.sql
// (UNIQUE (proyecto_id) en hojas_evaluacion).
//
// Verificación estructural (sin credenciales, sin red, sin datos
// reales — mismo criterio que el resto de esta familia de scripts):
// 1. la migración contiene EXCLUSIVAMENTE el ALTER TABLE ADD
//    CONSTRAINT aprobado (ningún otro DDL, ningún UNIQUE de la huella
//    de proyectos_seguimiento, ninguna otra tabla tocada);
// 2. lib/seguimiento/generarYGuardarHoja.ts sigue siendo el ÚNICO
//    sitio de todo el repositorio con un .insert() real contra
//    hojas_evaluacion — la premisa sobre la que se apoyó la decisión
//    de agregar el constraint (ver auditoría "diseño del contexto
//    histórico canónico del proyecto", sección 3).
//
// Se ejecuta con `npx tsx scripts/verificar-hoja-canonica-por-proyecto.ts`.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const raiz = (...partes: string[]) => join(__dirname, '..', ...partes)

// ============================================================
// 1. Contenido exacto de la migración.
// ============================================================
const rutaMigracion = raiz('supabase', 'migrations', '20260927000000_hoja_canonica_por_proyecto.sql')
const migracion = readFileSync(rutaMigracion, 'utf-8')
const sinComentarios = migracion
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .trim()

verificar(
  sinComentarios === 'alter table public.hojas_evaluacion\n  add constraint hojas_evaluacion_proyecto_id_key\n  unique (proyecto_id);',
  '1. La migración contiene EXCLUSIVAMENTE el ALTER TABLE ADD CONSTRAINT UNIQUE(proyecto_id) aprobado, sin ningún otro statement'
)
verificar(!/alter table.*proyectos_seguimiento/i.test(sinComentarios), '2. La migración NO toca proyectos_seguimiento (el UNIQUE de la huella queda explícitamente fuera de esta fase)')
verificar(!/drop |delete |truncate /i.test(sinComentarios), '3. La migración no contiene ningún DROP/DELETE/TRUNCATE — es puramente aditiva')
verificar(!/create (function|table)|revoke|grant/i.test(sinComentarios), '4. La migración no crea funciones/tablas ni toca privilegios — solo el constraint')

// ============================================================
// 2. generarYGuardarHoja.ts sigue siendo el único INSERT real.
// ============================================================
function listarArchivosTs(dir: string): string[] {
  const resultado: string[] = []
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    if (entrada.name === 'node_modules' || entrada.name.startsWith('.')) continue
    const ruta = join(dir, entrada.name)
    if (entrada.isDirectory()) resultado.push(...listarArchivosTs(ruta))
    else if (entrada.name.endsWith('.ts') || entrada.name.endsWith('.tsx')) resultado.push(ruta)
  }
  return resultado
}

const archivosApp = listarArchivosTs(raiz('app'))
const archivosLib = listarArchivosTs(raiz('lib'))
const sitiosConInsertHojas: string[] = []
for (const archivo of [...archivosApp, ...archivosLib]) {
  const contenido = readFileSync(archivo, 'utf-8')
  // Detecta el patrón real usado en el repo: .from('hojas_evaluacion')
  // seguido, en las líneas siguientes, de un .insert( — sin importar
  // el nombre de la variable que reciba el resultado.
  const lineas = contenido.split('\n')
  for (let i = 0; i < lineas.length; i++) {
    if (lineas[i].includes(".from('hojas_evaluacion')")) {
      const ventana = lineas.slice(i, i + 3).join('\n')
      if (/\.insert\(/.test(ventana)) sitiosConInsertHojas.push(archivo.replace(raiz(), '').replace(/^\//, ''))
    }
  }
}

verificar(
  sitiosConInsertHojas.length === 1 && sitiosConInsertHojas[0] === 'lib/seguimiento/generarYGuardarHoja.ts',
  `5. lib/seguimiento/generarYGuardarHoja.ts sigue siendo el ÚNICO sitio con .insert() contra hojas_evaluacion en todo app/+lib/ (encontrados: ${JSON.stringify(sitiosConInsertHojas)})`
)

const generarYGuardarHoja = readFileSync(raiz('lib', 'seguimiento', 'generarYGuardarHoja.ts'), 'utf-8')
verificar(
  /\.eq\('proyecto_id', datos\.proyectoId\)\s*\n\s*\.maybeSingle\(\)/.test(generarYGuardarHoja),
  '6. generarYGuardarHoja.ts sigue buscando por proyecto_id con .maybeSingle() ANTES de insertar (comportamiento con el que el nuevo UNIQUE es coherente, nunca contradictorio)'
)
verificar(
  /if \(hojaExistente && hojaExistente\.storage_path\)/.test(generarYGuardarHoja),
  '7. generarYGuardarHoja.ts sigue siendo un no-op idempotente cuando ya existe una hoja completa para el proyecto — nunca inserta una segunda'
)

console.log('')
if (fallos > 0) {
  console.error(`${fallos} prueba(s) fallaron.`)
  process.exit(1)
} else {
  console.log('Todas las pruebas pasaron.')
}
