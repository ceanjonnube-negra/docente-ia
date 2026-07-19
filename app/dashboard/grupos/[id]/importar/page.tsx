'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import ImportacionInteligente from '@/components/ImportacionInteligente';
import type { GrupoParaImportar } from '@/lib/importacionInteligente';

type Grupo = GrupoParaImportar & { nombre_grupo: string };

export default function ImportarAlumnosPage() {
  const params = useParams();
  const router = useRouter();
  const grupoId = params.id as string;

  const [grupo, setGrupo] = useState<Grupo | null>(null);
  const [cargandoGrupo, setCargandoGrupo] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function cargarGrupo() {
      setCargandoGrupo(true);
      const { data, error: grupoError } = await supabase
        .from('grupos')
        .select('id, nombre_grupo, institucion_id, docente_id, ciclo_escolar_id')
        .eq('id', grupoId)
        .single();

      if (grupoError || !data) {
        setError('No se pudo encontrar el grupo.');
      } else {
        setGrupo(data);
      }
      setCargandoGrupo(false);
    }
    if (grupoId) cargarGrupo();
  }, [grupoId]);

  if (cargandoGrupo) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        Cargando...
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
        Importar lista oficial
      </h1>
      <p className="mt-1 mb-6 text-sm text-gray-500">
        Grupo {grupo?.nombre_grupo}
      </p>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!error && (
        <ImportacionInteligente
          grupo={grupo}
          autoAbrir
          triggerClassName="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700"
          onImportacionCompleta={() => router.push('/dashboard/lista?importado=1')}
        />
      )}
    </div>
  );
}
