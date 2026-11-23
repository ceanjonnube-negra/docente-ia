// scripts/verificar-consulta-documentos-vs-produccion.ts
//
// consultar_documentos (consulta de los documentos guardados) nunca
// intercepta una petición explícita de PRODUCIR un documento —crear uno
// nuevo o convertir uno existente—, aunque el clasificador Nivel0 la
// devuelva (caso real en Preview: "Redacta un aviso… Entrégamelo en Word"
// justo después de "¿Cuántos documentos tengo generados?" respondió con la
// lista de documentos). La protección es determinista (pideProducirDocumento)
// y no agrega llamadas al modelo.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-consulta-documentos-vs-produccion.ts`.

import { readFileSync } from 'node:fs'
import { clasificarIntencionConFormato, contenidoParaArchivo, esDocumentoNuevoConFormato, pideProducirDocumento, tipoArchivoSolicitado } from '../lib/asistente/documentos'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

const tipo = (mensaje: string) => tipoArchivoSolicitado({ mensaje, esEdicionDocumento: false, formatoEntrega: undefined, finalizarArchivo: undefined })

// 1. Consultas legítimas del historial: la herramienta sigue respondiendo.
for (const consulta of [
  '¿Cuántos documentos tengo?',
  '¿Cuántos documentos tengo generados?',
  '¿Cuántos documentos de Word tengo?',
  'Muéstrame mis documentos PDF',
  '¿Qué documentos he generado esta semana?',
  'Quiero una lista de mis documentos',
  'Hazme un listado de los documentos que he generado',
]) {
  verificar(pideProducirDocumento(consulta) === null, `1. Consulta del historial → la atiende consultar_documentos: "${consulta}"`)
}

// 2. La acción explícita manda sobre las menciones incidentales a documentos.
for (const creacion of [
  'Redacta un aviso sobre los documentos que tengo que entregar mañana.',
  'Redacta un aviso sobre los documentos que tengo que entregar',
  'Hazme una lista de útiles para mis alumnos',
  'Redacta un aviso y entrégamelo en Word',
  'Redacta un aviso breve para las familias de 4.º B sobre la importancia de leer diariamente en casa. Entrégamelo en Word.',
]) {
  verificar(pideProducirDocumento(creacion) === 'crear', `2. Creación explícita → crear, aunque mencione documentos: "${creacion}"`)
}

// 3. Conversión de un documento existente a PDF (con su contexto).
const CITATORIO = '📨 CITATORIO\n\nEstimados padres de familia:\n- Fecha: 12 de noviembre\n- Hora: 8:00'
const conContexto = [{ role: 'user' as const, content: 'Hazme un citatorio para el viernes' }, { role: 'assistant' as const, content: CITATORIO }]
for (const conversion of ['Convierte el citatorio a PDF', 'Pásalo a PDF']) {
  const contenido = contenidoParaArchivo({ mensaje: conversion, finalizarArchivo: undefined, historial: conContexto })
  verificar(pideProducirDocumento(conversion) === 'convertir' && tipo(conversion) === 'pdf' && clasificarIntencionConFormato(conversion) === 'convertir'
    && contenido.fuente === 'historial' && 'texto' in contenido && contenido.texto === CITATORIO,
    `3. Conversión → convertir, con el citatorio existente como contenido del PDF: "${conversion}"`)
}

// 4. Creación sin formato explícito.
for (const creacion of ['Redacta un aviso para las familias sobre la lectura en casa.', 'Hazme un citatorio para mañana a las 8:00', 'Elabora un examen de fracciones para 4.º B']) {
  verificar(pideProducirDocumento(creacion) === 'crear' && tipo(creacion) === null,
    `4. Creación sin formato → crear, sin archivo (respuesta normal del modelo): "${creacion}"`)
}

// 4b. El aviso en Word conserva los datos que necesita el generador DOCX,
// también después de consultar el historial y con un documento previo en
// la conversación (no debe convertir la lista ni el citatorio anterior).
const AVISO_WORD = 'Redacta un aviso breve para las familias de 4.º B sobre la importancia de leer diariamente en casa. Entrégamelo en Word.'
const historialReal = [
  ...conContexto,
  { role: 'user' as const, content: '¿Cuántos documentos tengo generados?' },
  { role: 'assistant' as const, content: 'Tienes 25 documento(s) generado(s). Los más recientes:\n• CITATORIO (citatorio) — 15 nov 2026' },
]
const contenidoAviso = contenidoParaArchivo({ mensaje: AVISO_WORD, finalizarArchivo: undefined, historial: historialReal })
verificar(tipo(AVISO_WORD) === 'word', "4b-1. tipoHerramientaSolicitado = 'word' (se calcula del mensaje antes del atajo)")
verificar(esDocumentoNuevoConFormato(AVISO_WORD) && contenidoAviso.fuente === 'ninguna',
  "4b-2. Fuente 'ninguna': ni la lista de documentos ni el citatorio anterior se convierten; el aviso se redacta nuevo")
// 5. Mensajes que no son ni consulta ni producción: sin cambios (decide el clasificador).
verificar(pideProducirDocumento('Hola, buenos días') === null && pideProducirDocumento('¿Cuántos alumnos faltaron hoy?') === null,
  '5. Saludos y otras consultas no se desvían')

// 6. La ruta solo cambia el atajo de consultar_documentos, sin llamadas adicionales.
const ruta = readFileSync('app/api/chat/route.ts', 'utf8')
const bloque = ruta.slice(ruta.indexOf('const accionDocumental'), ruta.indexOf("marcarTelemetria('tool:execution_finished')"))
verificar(/const accionDocumental = clasificacion\.intencion_principal === 'consultar_documentos' \? pideProducirDocumento\(String\(mensaje \?\? ''\)\) : null/.test(bloque),
  '6a. La protección se aplica solo cuando Nivel0 devolvió consultar_documentos')
verificar(/const respuestaDeModulo = accionDocumental \? null : await ejecutarHerramientaDeModulo\(clasificacion,/.test(bloque),
  '6b. Si es incompatible, no se ejecuta la herramienta y el flujo continúa (respuestaDeModulo = null)')
verificar(!/messages\.create|clasificarNivel0\(/.test(bloque), '6c. Sin llamadas adicionales al modelo')
verificar((ruta.match(/ejecutarHerramientaDeModulo\(/g) || []).length === 1, '6d. Las demás herramientas siguen pasando por el mismo único atajo, sin cambios')

// 7. Datos que llegan al generador DOCX tras evitar el atajo (ruta real).
const iAtajo = ruta.indexOf('const accionDocumental')
const iCaso3 = ruta.indexOf('if (supabaseUser && userId && tipoHerramientaSolicitado) {', iAtajo)
const iTipo = ruta.indexOf('const tipoHerramientaSolicitado = tipoArchivoSolicitado({ mensaje: mensaje ||')
verificar(iTipo > 0 && iTipo < iAtajo, '7a. El formato solicitado (word) se calcula del mensaje original antes del atajo y no se modifica después')
verificar(ruta.slice(iTipo, iTipo + 6) === 'const ' && (ruta.match(/\b(let|var)\s+tipoHerramientaSolicitado\b/g) || []).length === 0, '7b. tipoHerramientaSolicitado es const: ningún paso posterior puede reasignarlo')
const tramo = ruta.slice(iAtajo, iCaso3)
verificar(iCaso3 > iAtajo && !/consultar_documentos'[^\n]*\)\s*\{?\s*\n?\s*return/.test(tramo), '7c. Entre el atajo y el CASO 3 ningún return depende de consultar_documentos')
const caso3 = ruta.slice(iCaso3, ruta.indexOf("return respuestaTexto(`Documento generado correctamente.", iCaso3))
verificar(caso3.includes("const instruccionDocente = esEdicionDocumento ? instruccionDeEdicion(mensaje || '') : (mensaje || '')"),
  '7d. CASO 3 toma la instrucción del docente del mensaje original')
verificar(caso3.includes('client.messages.create({ ...parametrosClaude, system: systemCaso3, stream: false }') && ruta.slice(ruta.indexOf('const parametrosClaude'), iCaso3).includes(': mensajeConDocumento'),
  '7e. El modelo recibe el mensaje del docente (mensajeConDocumento) para redactar el aviso')
verificar(caso3.includes('ejecutarHerramientaDocumento(tipoHerramientaSolicitado, texto, perfil, zonaHoraria, supabaseRAG, userId, opcionesArchivo)'),
  '7f. El generador recibe el formato word, el texto redactado, el perfil con grado y grupo, y el docente')

console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} verificación(es) fallaron`)
process.exit(fallos === 0 ? 0 : 1)
