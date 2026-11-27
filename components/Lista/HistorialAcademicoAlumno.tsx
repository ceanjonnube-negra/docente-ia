// components/Lista/HistorialAcademicoAlumno.tsx
//
// Pestaña Evaluaciones de la ficha (Hito 3b): resultados CONFIRMADOS del
// alumno (historial académico canónico), por ciclo → inscripción →
// periodo → proyecto → indicadores. Solo presenta: niveles reales con sus
// etiquetas de la hoja, una distribución sencilla y tres estados que no se
// mezclan — «Requiere apoyo» (nivel confirmado), «Sin evaluar» (indicador
// sin marca) y «Sin registro» (sin resultados en ese proyecto). Sin
// calificaciones, promedios ni conclusiones.

import { IconoCampo, IconoHoja } from '@/components/Planeacion/Iconos'
import DistribucionNiveles from '@/components/ui/DistribucionNiveles'
import { COLOR_NIVEL_CANONICO as COLOR_NIVEL, ETIQUETA_NIVEL_CANONICO } from '@/lib/seguimiento/conversionCalificacion'
import type { HistorialAlumno, ProyectoEnHistorialAlumno } from '@/lib/seguimiento/historialGrupo'

const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }) : null)

function TarjetaProyecto({ item }: { item: ProyectoEnHistorialAlumno }) {
  const p = item.proyecto
  const campos = p.campoFormativo ?? (p.camposFormativos.length ? p.camposFormativos.join(' · ') : null)
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${item.estado === 'sin_registro' ? 'border-dashed border-gray-200 bg-gray-50/60' : 'border-gray-100 bg-white shadow-sm'}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-semibold text-gray-900">{p.nombre ?? 'Proyecto sin nombre'}</p>
        {p.confirmadoEn && <span className="flex-shrink-0 text-[11px] text-gray-400">{fecha(p.confirmadoEn)}</span>}
      </div>
      {campos && (
        <p className="mt-0.5 flex items-center gap-1 text-[11px] text-gray-500">
          <IconoCampo className="h-3.5 w-3.5 flex-shrink-0 text-green-700" />
          <span className="truncate">{campos}</span>
        </p>
      )}
      {item.estado === 'sin_registro' ? (
        <p className="mt-2 text-xs text-gray-500">Sin registro: este alumno no tiene resultados en este proyecto.</p>
      ) : (
        <>
          <DistribucionNiveles distribucion={item.distribucion} />
          {item.resultado.conteo.requiereApoyo > 0 && (
            <p className="mt-1.5 text-xs font-medium text-red-700">
              {item.resultado.conteo.requiereApoyo === 1 ? '1 indicador en Requiere apoyo' : `${item.resultado.conteo.requiereApoyo} indicadores en Requiere apoyo`}
            </p>
          )}
          <details className="group mt-2">
            <summary className="cursor-pointer list-none text-xs font-semibold text-green-700 hover:text-green-800">
              <span className="group-open:hidden">Ver indicadores ({item.resultado.indicadores.length})</span>
              <span className="hidden group-open:inline">Ocultar indicadores</span>
            </summary>
            <ol className="mt-2 space-y-1.5">
              {item.resultado.indicadores.map((i) => (
                <li key={i.indicadorNumero} className="flex items-start justify-between gap-3 text-xs">
                  <span className="min-w-0 text-gray-700"><span className="font-semibold text-gray-400">{i.indicadorNumero}.</span> {i.indicadorEspecifico}</span>
                  <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${COLOR_NIVEL[i.nivel]}`}>{ETIQUETA_NIVEL_CANONICO[i.nivel]}</span>
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </div>
  )
}

export default function HistorialAcademicoAlumno({ historial, error }: { historial: HistorialAlumno | null; error: boolean }) {
  if (error) return <p role="alert" className="rounded-xl border border-red-100 bg-red-50 px-3.5 py-3 text-sm text-red-700">No se pudieron cargar los resultados de evaluación. Intenta de nuevo.</p>
  const vacio = !historial || historial.ciclos.every((c) => c.inscripciones.every((i) => i.periodos.length === 0))
  if (vacio) {
    return (
      <div className="flex flex-col items-center rounded-2xl border border-gray-100 bg-white px-6 py-10 text-center shadow-sm">
        <IconoHoja className="mb-2 h-7 w-7 text-gray-300" />
        <p className="text-sm text-gray-500">Aún no hay resultados confirmados de hojas de evaluación.</p>
      </div>
    )
  }
  const varias = historial.ciclos.length > 1 || historial.ciclos[0].inscripciones.length > 1
  return (
    <div className="space-y-5">
      <p className="text-xs text-gray-500">
        {historial.proyectosConResultados.length === 1 ? '1 proyecto con resultados confirmados' : `${historial.proyectosConResultados.length} proyectos con resultados confirmados`}
        {historial.ultimaConfirmacion && ` · Última confirmación: ${fecha(historial.ultimaConfirmacion)}`}
      </p>
      {historial.ciclos.map((ciclo) => (
        <section key={ciclo.cicloEscolarId} className="space-y-3">
          {varias && <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Ciclo {ciclo.cicloNombre ?? 'escolar'}</h3>}
          {ciclo.inscripciones.map(({ inscripcion, periodos }) => (
            <div key={inscripcion.inscripcionId} className="space-y-3">
              {varias && (
                <p className="text-xs font-semibold text-gray-700">
                  {inscripcion.grupoNombre ?? 'Grupo'}
                  {inscripcion.estatus && inscripcion.estatus !== 'activo' && <span className="ml-1.5 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">{inscripcion.estatus === 'baja' ? 'Baja' : inscripcion.estatus}</span>}
                </p>
              )}
              {periodos.length === 0 && <p className="text-xs text-gray-500">Sin proyectos confirmados en esta inscripción.</p>}
              {periodos.map((g) => (
                <div key={g.periodo?.id ?? 'sin-periodo'}>
                  <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-green-800">
                    <span aria-hidden="true" className="h-3 w-0.5 rounded-full bg-green-600" />
                    {g.periodo?.nombre ?? 'Sin periodo asignado'}
                  </p>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {g.proyectos.map((item) => <TarjetaProyecto key={item.proyecto.proyectoId} item={item} />)}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}
      <p className="text-[11px] leading-relaxed text-gray-400">
        Niveles confirmados de las hojas de evaluación. «Sin evaluar»: indicador sin marca en la hoja. «Sin registro»: el alumno no tiene resultados en ese proyecto.
      </p>
      {historial.entradasExcluidas > 0 && <p className="text-[11px] text-amber-700">{historial.entradasExcluidas} registro(s) con datos inconsistentes no se muestran.</p>}
    </div>
  )
}
