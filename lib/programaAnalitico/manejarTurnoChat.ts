// lib/programaAnalitico/manejarTurnoChat.ts
//
// PA-4D — punto único de integración del Programa Analítico con el
// Chat. app/api/chat/route.ts solo llama a
// manejarTurnoProgramaAnalitico(...) dentro del short-circuit de
// intencion_principal==='programa_analitico' (mismo patrón real ya
// usado para planeacion_generar/aprobar — nunca pasa por Sonnet en
// este turno salvo las 2 llamadas IA acotadas ya existentes:
// generación inicial y, cuando aplica, interpretación de un ajuste).
//
// "El estado manda, no la IA" (PA-4D §4): el sub-flujo real se decide
// consultando programa_analitico_borrador por grupo_id (vía
// buscarBorradorPendientePorGrupo), nunca confiando en que Nivel 0
// "recuerde" si hay una propuesta pendiente.

import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolverContextoCurricularGrupo } from '../curriculo/resolverContextoCurricularGrupo'
import { recuperarCatalogoCurricularCerrado } from './candidatosCurriculares'
import {
  ajustarBorradorProgramaAnalitico,
  buscarBorradorPendientePorGrupo,
  confirmarBorradorProgramaAnalitico,
  obtenerBorradorProgramaAnalitico,
  prepararBorradorProgramaAnalitico,
  type ErrorOrquestacionBorrador,
  type OperacionAjusteBorrador,
} from './orquestarBorrador'
import { consultarProgramaAnaliticoVigente, detectarCampoFormativoEnTexto, filtrarItemsPorCampo } from './consultarProgramaAnaliticoVigente'
import { interpretarAjusteBorrador } from './interpretarAjusteBorrador'
import {
  textoAjusteAmbiguo,
  textoAjusteAplicado,
  textoAjusteNoReconocido,
  textoConfirmacionPublicada,
  textoConsultaPaVigente,
  textoIdentidadCurricularCambio,
  textoNoHayNadaQueConfirmar,
  textoNoHayPaVigente,
  textoPreguntaContexto,
  textoResumenPropuestaGenerada,
  textoYaHayBorradorPendiente,
} from './textosProgramaAnalitico'

export type SesionMinimaProgramaAnalitico = {
  grupo_activo_id: string | null
  grado_grupo: string | null
  nivel_educativo_grupo: string | null
}

export type ResultadoTurnoProgramaAnalitico = { texto: string; llamadasIa: number }

function textoErrorOrquestacion(error: ErrorOrquestacionBorrador): string {
  switch (error.tipo) {
    case 'IDENTIDAD_CURRICULAR_CAMBIO':
      return textoIdentidadCurricularCambio()
    case 'BORRADOR_NO_ENCONTRADO':
    case 'BORRADOR_CORRUPTO':
      return 'No pude recuperar tu propuesta de Programa Analítico en este momento. Intenta de nuevo.'
    case 'BORRADOR_DESCARTADO':
      return 'Esa propuesta de Programa Analítico ya fue descartada. ¿Quieres que empecemos una nueva?'
    case 'BORRADOR_YA_PUBLICADO':
      return 'Esa propuesta ya se había publicado antes.'
    case 'YA_HAY_BORRADOR_PENDIENTE':
      return 'Ya tienes una propuesta de Programa Analítico pendiente. Puedes pedirme un ajuste o confirmarla.'
    case 'CONTEXTO_CURRICULAR_NO_RESUELTO':
      return 'No pude verificar el currículo de tu grupo en este momento. Intenta de nuevo en unos segundos.'
    case 'DELTA_CONTENIDO_DUPLICADO':
    case 'DELTA_CONTENIDO_NO_ENCONTRADO_EN_BASE':
      return 'Ese ajuste no se pudo aplicar sobre la propuesta actual. Intenta describirlo de otra forma.'
    case 'ERROR_PERSISTENCIA':
    case 'ERROR_PUBLICACION':
    case 'NO_AUTENTICADO':
    default:
      return 'No pude completar esa acción del Programa Analítico en este momento. Intenta de nuevo.'
  }
}

export async function manejarTurnoProgramaAnalitico(
  sb: SupabaseClient,
  anthropic: Anthropic,
  sesion: SesionMinimaProgramaAnalitico,
  accion: 'gestionar' | 'confirmar' | 'consultar' | null,
  mensaje: string
): Promise<ResultadoTurnoProgramaAnalitico> {
  const grupoId = sesion.grupo_activo_id
  if (!grupoId) return { texto: 'No tengo identificado un grupo activo todavía — configura tu grupo primero en la sección Lista.', llamadasIa: 0 }

  const pendiente = await buscarBorradorPendientePorGrupo(sb, grupoId)

  // --- CONFIRMAR ---
  if (accion === 'confirmar') {
    if (!pendiente) return { texto: textoNoHayNadaQueConfirmar(), llamadasIa: 0 }
    const resultado = await confirmarBorradorProgramaAnalitico(sb, pendiente.id)
    if (!resultado.ok) {
      const error = 'diagnostico' in resultado.error ? { tipo: 'ERROR_PUBLICACION' as const, mensaje: 'propuesta_invalida_al_confirmar' } : resultado.error
      return { texto: textoErrorOrquestacion(error), llamadasIa: 0 }
    }
    return { texto: textoConfirmacionPublicada(resultado.resultado.numeroVersion), llamadasIa: 0 }
  }

  // --- CONSULTAR (solo lectura, 0 IA) ---
  if (accion === 'consultar') {
    if (pendiente) {
      const r = await obtenerBorradorProgramaAnalitico(sb, pendiente.id)
      if (r.ok) return { texto: textoYaHayBorradorPendiente(r.resumen), llamadasIa: 0 }
    }
    const vigente = await consultarProgramaAnaliticoVigente(sb, grupoId)
    if (!vigente.existe) return { texto: textoNoHayPaVigente(), llamadasIa: 0 }
    const campoDetectado = detectarCampoFormativoEnTexto(mensaje)
    const items = campoDetectado ? filtrarItemsPorCampo(vigente.items, campoDetectado) : vigente.items
    const nombreCampo = campoDetectado ? (items[0]?.campoFormativoNombre ?? null) : null
    return { texto: textoConsultaPaVigente(items, vigente.numeroVersion, nombreCampo), llamadasIa: 0 }
  }

  // --- GESTIONAR: sin pendiente -> iniciar/aportar contexto (misma
  //     ruta: el mensaje actual ES el contextoDocente candidato;
  //     evaluarRequiereContexto ya decide internamente si alcanza). ---
  if (!pendiente) {
    const resultado = await prepararBorradorProgramaAnalitico(sb, anthropic, { grupoId, contextoDocente: mensaje })
    if (!resultado.ok) {
      if ('requiereContexto' in resultado) return { texto: textoPreguntaContexto(sesion.grado_grupo, sesion.nivel_educativo_grupo), llamadasIa: 0 }
      if ('requiereInformacion' in resultado) {
        return { texto: 'No pude preparar tu Programa Analítico porque falta información del currículo oficial de tu grupo.', llamadasIa: 0 }
      }
      if (resultado.error.tipo === 'YA_HAY_BORRADOR_PENDIENTE') return { texto: textoErrorOrquestacion(resultado.error), llamadasIa: 0 }
      return { texto: 'No pude generar tu propuesta de Programa Analítico en este momento. Intenta de nuevo.', llamadasIa: 1 }
    }
    return { texto: textoResumenPropuestaGenerada(resultado.resumen), llamadasIa: 1 }
  }

  // --- GESTIONAR: con pendiente -> interpretar como AJUSTE. ---
  const borradorActual = await obtenerBorradorProgramaAnalitico(sb, pendiente.id)
  if (!borradorActual.ok) return { texto: textoErrorOrquestacion(borradorActual.error), llamadasIa: 0 }

  const contexto = await resolverContextoCurricularGrupo(sb, grupoId)
  if (!contexto.ok) return { texto: 'No pude verificar el currículo de tu grupo en este momento. Intenta de nuevo.', llamadasIa: 0 }
  const catalogo = await recuperarCatalogoCurricularCerrado(sb, contexto.contexto)
  const candidatos = catalogo.contenidos.map((c) => ({ id: c.id, titulo: c.titulo }))

  const interpretado = await interpretarAjusteBorrador(anthropic, mensaje, borradorActual.resumen, candidatos)
  const llamadasIaAjuste = interpretado.llamadaIa ? 1 : 0
  if (!interpretado.ok) {
    if ('ambiguo' in interpretado) return { texto: textoAjusteAmbiguo(interpretado.opciones), llamadasIa: llamadasIaAjuste }
    if ('noReconocido' in interpretado) return { texto: textoAjusteNoReconocido(), llamadasIa: llamadasIaAjuste }
    return { texto: 'No pude interpretar ese ajuste en este momento. Intenta de nuevo.', llamadasIa: llamadasIaAjuste }
  }

  const operacion = interpretado.operacion as OperacionAjusteBorrador
  const resultadoAjuste = await ajustarBorradorProgramaAnalitico(sb, pendiente.id, operacion)
  if (!resultadoAjuste.ok) return { texto: textoErrorOrquestacion(resultadoAjuste.error), llamadasIa: llamadasIaAjuste }

  return { texto: textoAjusteAplicado(resultadoAjuste.resumen), llamadasIa: llamadasIaAjuste }
}
