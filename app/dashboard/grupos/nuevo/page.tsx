'use client';

import { useEffect, useState, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

type Institucion = {
  id: string;
  nombre: string;
};

type CicloEscolar = {
  id: string;
  nombre: string;
};

type NivelEducativo = 'preescolar' | 'primaria' | 'secundaria';

const GRADOS_POR_NIVEL: Record<NivelEducativo, string[]> = {
  preescolar: ['1', '2', '3'],
  primaria: ['1', '2', '3', '4', '5', '6'],
  secundaria: ['1', '2', '3'],
};

const NIVELES: {
  valor: NivelEducativo;
  etiqueta: string;
  icono: ReactNode;
}[] = [
  {
    valor: 'preescolar',
    etiqueta: 'Preescolar',
    icono: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-7 w-7">
        <path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4L12 3z" strokeLinejoin="round" />
        <path d="M5 19c1.5-2 12.5-2 14 0" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    valor: 'primaria',
    etiqueta: 'Primaria',
    icono: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-7 w-7">
        <path d="M4 6.5c2.5-1.3 5.5-1.3 8 0v11c-2.5-1.3-5.5-1.3-8 0v-11z" strokeLinejoin="round" />
        <path d="M20 6.5c-2.5-1.3-5.5-1.3-8 0v11c2.5-1.3 5.5-1.3 8 0v-11z" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    valor: 'secundaria',
    etiqueta: 'Secundaria',
    icono: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-7 w-7">
        <path d="M2 8l10-4 10 4-10 4-10-4z" strokeLinejoin="round" />
        <path d="M6 10.5v4.5c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2v-4.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M22 8v6" strokeLinecap="round" />
      </svg>
    ),
  },
];

const ETIQUETA_NIVEL: Record<NivelEducativo, string> = {
  preescolar: 'Preescolar',
  primaria: 'Primaria',
  secundaria: 'Secundaria',
};

export default function NuevoGrupoPage() {
  const router = useRouter();

  const [docenteId, setDocenteId] = useState<string | null>(null);

  const [instituciones, setInstituciones] = useState<Institucion[]>([]);
  const [institucionId, setInstitucionId] = useState<string>('');

  const [ciclos, setCiclos] = useState<CicloEscolar[]>([]);
  const [cicloEscolarId, setCicloEscolarId] = useState<string>('');

  const [nivelEducativo, setNivelEducativo] = useState<NivelEducativo | ''>('');
  const [grado, setGrado] = useState('');
  const [grupo, setGrupo] = useState('');

  const [cargando, setCargando] = useState(true);
  const [cargandoCiclos, setCargandoCiclos] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function cargarInstituciones() {
      setCargando(true);
      setError(null);

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setError('No se encontró una sesión activa. Inicia sesión de nuevo.');
        setCargando(false);
        return;
      }
      setDocenteId(user.id);

      const { data: perfil, error: perfilError } = await supabase
        .from('perfiles_docentes')
        .select('institucion_id, instituciones(id, nombre)')
        .eq('id', user.id)
        .single();

      if (perfilError || !perfil) {
        setError('No se pudo encontrar tu perfil docente.');
        setCargando(false);
        return;
      }

      const { data: extra } = await supabase
        .from('docente_instituciones')
        .select('institucion_id, instituciones(id, nombre)')
        .eq('docente_id', user.id);

      const listaMap = new Map<string, Institucion>();

      const principal = perfil.instituciones as unknown as Institucion | null;
      if (principal) {
        listaMap.set(principal.id, principal);
      }

      (extra ?? []).forEach((row: any) => {
        const inst = row.instituciones as Institucion | null;
        if (inst) listaMap.set(inst.id, inst);
      });

      const lista = Array.from(listaMap.values());

      if (lista.length === 0) {
        setError('No tienes ninguna institución asignada todavía.');
        setCargando(false);
        return;
      }

      setInstituciones(lista);

      const { data: contexto } = await supabase
        .from('docente_contexto_activo')
        .select('institucion_id, ciclo_escolar_id')
        .eq('docente_id', user.id)
        .single();

      const institucionInicial =
        contexto?.institucion_id && listaMap.has(contexto.institucion_id)
          ? contexto.institucion_id
          : lista[0].id;

      setInstitucionId(institucionInicial);
      setCargando(false);
    }

    cargarInstituciones();
  }, []);

  useEffect(() => {
    if (!institucionId) return;

    async function cargarCiclos() {
      setCargandoCiclos(true);
      setError(null);
      setCicloEscolarId('');

      const { data, error: cicloError } = await supabase
        .from('ciclos_escolares')
        .select('id, nombre')
        .eq('institucion_id', institucionId)
        .eq('activo', true)
        .order('creado_en', { ascending: false });

      if (cicloError || !data || data.length === 0) {
        setError('No hay ciclos escolares activos para esta institución.');
        setCiclos([]);
        setCargandoCiclos(false);
        return;
      }

      setCiclos(data);

      const { data: contexto } = await supabase
        .from('docente_contexto_activo')
        .select('ciclo_escolar_id')
        .eq('docente_id', docenteId ?? '')
        .single();

      const cicloValido = data.find((c) => c.id === contexto?.ciclo_escolar_id);
      setCicloEscolarId(cicloValido ? cicloValido.id : data[0].id);

      setCargandoCiclos(false);
    }

    cargarCiclos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [institucionId]);

  function handleSeleccionarNivel(nivel: NivelEducativo) {
    setNivelEducativo(nivel);
    setGrado('');
  }

  function handleGrupoChange(valor: string) {
    const limpio = valor.replace(/[^a-zA-Z]/g, '').slice(0, 1).toUpperCase();
    setGrupo(limpio);
  }

  const cicloSeleccionado = ciclos.find((c) => c.id === cicloEscolarId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!institucionId || !cicloEscolarId) {
      setError('Selecciona institución y ciclo escolar.');
      return;
    }
    if (!nivelEducativo) {
      setError('Selecciona el nivel educativo.');
      return;
    }
    if (!grado || !grupo) {
      setError('Selecciona el grado y escribe la letra del grupo.');
      return;
    }
    if (!docenteId) {
      setError('Falta información de sesión. Recarga la página e intenta de nuevo.');
      return;
    }

    setGuardando(true);

    const { data: nuevoGrupo, error: insertError } = await supabase
      .from('grupos')
      .insert({
        institucion_id: institucionId,
        docente_id: docenteId,
        ciclo_escolar_id: cicloEscolarId,
        nivel_educativo: nivelEducativo,
        grado,
        grupo,
      })
      .select('id')
      .single();

    if (insertError || !nuevoGrupo) {
      setGuardando(false);
      if (insertError?.code === '23505') {
        setError('Ya tienes un grupo con ese grado y letra en este ciclo escolar.');
      } else {
        setError('Ocurrió un error al guardar el grupo. Intenta de nuevo.');
      }
      return;
    }

    await supabase.from('docente_contexto_activo').upsert({
      docente_id: docenteId,
      institucion_id: institucionId,
      ciclo_escolar_id: cicloEscolarId,
      grupo_id: nuevoGrupo.id,
      actualizado_en: new Date().toISOString(),
    });

    setGuardando(false);
    router.push(`/dashboard/grupos/${nuevoGrupo.id}/configuracion-inicial`);
  }

  if (cargando) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        Cargando...
      </div>
    );
  }

  const gradosDisponibles = nivelEducativo ? GRADOS_POR_NIVEL[nivelEducativo] : [];
  const listo = !!nivelEducativo && !!grado && !!grupo;

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-lg px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
        Configura tu grupo
      </h1>
      <p className="mt-1 mb-6 text-sm text-gray-500">
        Configura tu grupo para comenzar a utilizar todas las herramientas de Docente IA.
      </p>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {instituciones.length > 1 && (
        <div className="mb-5">
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Institución
          </label>
          <select
            value={institucionId}
            onChange={(e) => setInstitucionId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-4 py-2 text-base focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          >
            {instituciones.map((inst) => (
              <option key={inst.id} value={inst.id}>
                {inst.nombre}
              </option>
            ))}
          </select>
        </div>
      )}

      {cargandoCiclos ? (
        <p className="mb-5 text-sm text-gray-500">Cargando ciclos escolares...</p>
      ) : (
        ciclos.length > 1 && (
          <div className="mb-5">
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Ciclo escolar
            </label>
            <select
              value={cicloEscolarId}
              onChange={(e) => setCicloEscolarId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 text-base focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            >
              {ciclos.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </select>
          </div>
        )
      )}

      {ciclos.length === 1 && (
        <p className="mb-6 text-sm text-gray-500">
          Ciclo escolar <span className="font-medium text-gray-700">{ciclos[0].nombre}</span>
        </p>
      )}

      {/* Nivel educativo — tarjetas horizontales */}
      <div className="mb-6">
        <span className="mb-2 block text-sm font-medium text-gray-700">
          Nivel educativo
        </span>
        <div className="grid grid-cols-3 gap-3">
          {NIVELES.map((n) => {
            const activo = nivelEducativo === n.valor;
            return (
              <button
                key={n.valor}
                type="button"
                onClick={() => handleSeleccionarNivel(n.valor)}
                className={`flex flex-col items-center gap-2 rounded-2xl border-2 px-3 py-5 text-center transition-all duration-200 ${
                  activo
                    ? 'scale-[1.03] border-emerald-600 bg-emerald-50 text-emerald-800 shadow-sm'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                }`}
              >
                {n.icono}
                <span className="text-sm font-medium">{n.etiqueta}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Grado — botones grandes */}
      {nivelEducativo && (
        <div className="mb-6">
          <span className="mb-2 block text-sm font-medium text-gray-700">Grado</span>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {gradosDisponibles.map((g) => {
              const activo = grado === g;
              return (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGrado(g)}
                  className={`aspect-square rounded-2xl text-lg font-semibold transition-colors duration-200 ${
                    activo
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {g}°
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Grupo — campo angosto, una sola letra */}
      {nivelEducativo && (
        <div className="mb-6">
          <span className="mb-2 block text-sm font-medium text-gray-700">Grupo</span>
          <input
            type="text"
            value={grupo}
            onChange={(e) => handleGrupoChange(e.target.value)}
            placeholder="B"
            maxLength={1}
            className="w-20 rounded-2xl border border-gray-300 px-4 py-3 text-center text-lg font-semibold uppercase focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
      )}

      {/* Tarjeta resumen */}
      {listo && (
        <div className="mb-6 rounded-2xl border border-gray-200 bg-gray-50 px-5 py-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
            Resumen
          </p>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Nivel educativo</dt>
              <dd className="font-medium text-gray-900">
                {nivelEducativo && ETIQUETA_NIVEL[nivelEducativo]}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Grado</dt>
              <dd className="font-medium text-gray-900">{grado}°</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Grupo</dt>
              <dd className="font-medium text-gray-900">{grupo}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Ciclo escolar</dt>
              <dd className="font-medium text-gray-900">
                {cicloSeleccionado?.nombre ?? '—'}
              </dd>
            </div>
          </dl>
        </div>
      )}

      <button
        type="submit"
        disabled={guardando || cargandoCiclos || !listo}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 py-3.5 text-base font-medium text-white shadow-sm transition-all duration-150 hover:bg-emerald-700 hover:shadow active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
        {guardando ? 'Guardando...' : 'Crear grupo'}
      </button>
    </form>
  );
}
