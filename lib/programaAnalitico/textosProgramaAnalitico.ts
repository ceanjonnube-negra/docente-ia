// lib/programaAnalitico/textosProgramaAnalitico.ts
//
// PA-4D — construcción determinista de los textos de respuesta del
// Chat para el Programa Analítico. 0 IA: todos los datos ya vienen
// calculados (resúmenes, resultados) — esta capa solo los redacta en
// español natural. Nunca imprime el catálogo completo ni los 85
// contenidos (ver construirResumenPropuesta, PA-4B).

import type { ResumenPropuesta } from './borradorProgramaAnalitico'
import type { ItemVigente } from './consultarProgramaAnaliticoVigente'

export function textoPreguntaContexto(gradoGrupo: string | null, nivelEducativo: string | null): string {
  const referenciaGrupo = gradoGrupo && nivelEducativo ? ` tu grupo de ${gradoGrupo}.° de ${nivelEducativo}` : ' tu grupo'
  return `Ya tengo identificado${referenciaGrupo} y el currículo correspondiente. Para contextualizar tu Programa Analítico, cuéntame brevemente qué características, necesidades o situaciones de tu grupo o comunidad quieres que tome en cuenta. Si no hay nada particular por ahora, también puedes decirme que continúe con el currículo oficial tal cual.`
}

export function textoResumenPropuestaGenerada(resumen: ResumenPropuesta): string {
  const partes: string[] = ['He preparado una propuesta para tu Programa Analítico.', '']
  const piezas: string[] = []
  piezas.push(`se conservaron ${resumen.sinAjuste.cantidad} contenido${resumen.sinAjuste.cantidad === 1 ? '' : 's'} oficial${resumen.sinAjuste.cantidad === 1 ? '' : 'es'} sin cambios`)
  if (resumen.contextualizados.length > 0) {
    piezas.push(`contextualicé ${resumen.contextualizados.length} para las necesidades que me comentaste`)
  }
  if (resumen.nuevos.length > 0) {
    piezas.push(`agregué ${resumen.nuevos.length} contenido${resumen.nuevos.length === 1 ? '' : 's'} local${resumen.nuevos.length === 1 ? '' : 'es'}`)
  } else {
    piezas.push('no agregué contenidos locales nuevos')
  }
  if (resumen.excluidos.length > 0) {
    piezas.push(`excluí ${resumen.excluidos.length}`)
  }
  partes.push(piezas.join(', ') + '.')

  if (resumen.contextualizados.length > 0 || resumen.nuevos.length > 0 || resumen.excluidos.length > 0) {
    partes.push('', 'Los principales ajustes fueron:')
    for (const c of resumen.contextualizados) partes.push(`• ${c.tituloOficial}: ${c.textoContextualizado}`)
    for (const n of resumen.nuevos) partes.push(`• Nuevo: ${n.textoLocal}`)
    for (const e of resumen.excluidos) partes.push(`• Se excluyó: ${e.tituloOficial}`)
  }

  partes.push('', 'Si quieres, puedo ajustar algo antes de dejarlo como versión vigente. Cuando estés de acuerdo, dime que lo confirme.')
  return partes.join('\n')
}

export function textoYaHayBorradorPendiente(resumen: ResumenPropuesta): string {
  return `Ya tienes una propuesta de Programa Analítico pendiente de confirmar (${resumen.sinAjuste.cantidad} sin ajuste, ${resumen.contextualizados.length} contextualizados, ${resumen.nuevos.length} nuevos, ${resumen.excluidos.length} excluidos). Puedes pedirme un ajuste, o decirme que la confirme para dejarla como versión vigente.`
}

export function textoConfirmacionPublicada(numeroVersion: number): string {
  return `Listo, publiqué tu Programa Analítico como versión ${numeroVersion}. Ya queda como la versión vigente de tu grupo.`
}

export function textoNoHayNadaQueConfirmar(): string {
  return 'No tengo ninguna propuesta de Programa Analítico pendiente para confirmar en este momento. ¿Quieres que empecemos una?'
}

export function textoAjusteAplicado(resumen: ResumenPropuesta): string {
  return `Listo, apliqué ese ajuste. Tu propuesta ahora tiene ${resumen.sinAjuste.cantidad} sin ajuste, ${resumen.contextualizados.length} contextualizados, ${resumen.nuevos.length} nuevos y ${resumen.excluidos.length} excluidos. ¿Quieres otro ajuste, o la confirmo?`
}

export function textoAjusteAmbiguo(opciones: string[]): string {
  if (opciones.length === 0) return 'No estoy seguro a cuál contenido te refieres, ¿me lo puedes precisar?'
  return `No estoy seguro a cuál te refieres. ¿Hablas de: ${opciones.map((o) => `"${o}"`).join(', ')}?`
}

export function textoAjusteNoReconocido(): string {
  return 'No logré identificar con seguridad qué ajuste quieres hacer. ¿Me lo puedes explicar de otra forma?'
}

export function textoNoHayPaVigente(): string {
  return 'Todavía no hay un Programa Analítico publicado para tu grupo. ¿Quieres que empecemos a armarlo?'
}

export function textoIdentidadCurricularCambio(): string {
  return 'El currículo oficial de tu grupo cambió desde que empezamos esta propuesta, así que no puedo continuar con ella de forma segura. ¿Quieres que empecemos una propuesta nueva?'
}

export function textoConsultaPaVigente(items: ItemVigente[], numeroVersion: number, filtroCampoNombre: string | null): string {
  if (items.length === 0) {
    return filtroCampoNombre
      ? `No encontré contenidos de ${filtroCampoNombre} en tu Programa Analítico vigente (versión ${numeroVersion}).`
      : `Tu Programa Analítico vigente (versión ${numeroVersion}) no tiene contenidos registrados.`
  }
  const encabezado = filtroCampoNombre
    ? `En tu Programa Analítico vigente (versión ${numeroVersion}), en ${filtroCampoNombre} tienes:`
    : `Tu Programa Analítico vigente (versión ${numeroVersion}) incluye ${items.length} contenidos. Estos son algunos:`
  const lista = items.slice(0, 15).map((i) => {
    const titulo = i.tituloOficial ?? i.textoLocal ?? '(sin título)'
    const sufijo = i.tipoDecision === 'nuevo' ? ' (local)' : i.tipoDecision === 'contextualizado' ? ' (contextualizado)' : ''
    return `• ${titulo}${sufijo}`
  })
  const partes = [encabezado, ...lista]
  if (items.length > 15) partes.push(`... y ${items.length - 15} más.`)
  return partes.join('\n')
}
