'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

type Grupo = {
  id: string;
  nombre_grupo: string;
};

export default function ConfiguracionInicialGrupoPage() {
  const params = useParams();
  const router = useRouter();
  const grupoId = params.id as string;

  const [grupo, setGrupo] = useState<Grupo | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function cargarGrupo() {
      setCargando(true);
      setError(null);

      const { data, error: grupoError } = await supabase
        .from('grupos')
        .select('id, nombre_grupo')
        .eq('id', grupoId)
        .single();

      if (grupoError || !data) {
        setError('No se pudo encontrar el grupo.');
        setCargando(false);
        return;
      }

      setGrupo(data);
      setCargando(false);
    }

    if (grupoId) cargarGrupo();
  }, [grupoId]);

  if (cargando) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        Cargando...
      </div>
    );
  }

  if (error || !grupo) {
    return (
      <div className="mx-auto max-w-lg px-4 py-8">
        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error ?? 'Ocurrió un error inesperado.'}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
        Configuración inicial del grupo
      </h1>

      <div className="mt-4 mb-8 rounded-2xl bg-emerald-50 px-5 py-4">
        <p className="text-base font-semibold text-emerald-800">
          ¡Tu grupo {grupo.nombre_grupo} fue creado correctamente!
        </p>
        <p className="mt-1 text-sm text-emerald-700">
          El siguiente paso es agregar la lista oficial de alumnos para comenzar
          a utilizar Docente IA.
        </p>
      </div>

      <button
        type="button"
        onClick={() => router.push(`/dashboard/grupos/${grupo.id}/importar`)}
        className="group relative mb-4 w-full rounded-2xl border-2 border-emerald-600 bg-white px-5 py-6 text-left shadow-sm transition-all duration-150 hover:shadow-md active:scale-[0.99]"
      >
        <span className="absolute -top-3 left-5 rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
          Recomendado
        </span>

        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-6 w-6">
              <path d="M12 3v12m0 0l-4-4m4 4l4-4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Importar lista oficial
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              Sube un archivo de Excel, PDF o Word. La IA detecta los datos
              automáticamente y te muestra una vista previa editable antes de
              guardar.
            </p>
            <span className="mt-4 inline-block rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors group-hover:bg-emerald-700">
              Importar lista
            </span>
          </div>
        </div>
      </button>

      <button
        type="button"
        onClick={() => router.push(`/dashboard/grupos/${grupo.id}/alumnos/nuevo`)}
        className="w-full rounded-2xl border border-gray-200 bg-white px-5 py-6 text-left transition-all duration-150 hover:border-gray-300 hover:bg-gray-50 active:scale-[0.99]"
      >
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-6 w-6">
              <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="9" cy="7" r="4" />
              <path d="M19 8v6M22 11h-6" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              Capturar alumnos manualmente
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              Agrega alumnos uno por uno si no cuentas con una lista oficial.
            </p>
            <span className="mt-4 inline-block rounded-xl bg-gray-800 px-4 py-2 text-sm font-medium text-white transition-colors group-hover:bg-gray-900">
              Agregar alumnos
            </span>
          </div>
        </div>
      </button>
    </div>
  );
}
