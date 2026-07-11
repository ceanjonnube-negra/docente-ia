'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

type Grupo = {
  id: string;
  nombre_grupo: string;
  institucion_id: string;
  docente_id: string;
};

type AlumnoPreview = {
  numero_lista: number | null;
  nombre: string;
  curp: string | null;
  sexo: string | null;
};

type Estado = 'inicial' | 'analizando' | 'revisando' | 'guardando' | 'listo';

export default function ImportarAlumnosPage() {
  const params = useParams();
  const router = useRouter();
  const grupoId = params.id as string;
  const inputArchivoRef = useRef<HTMLInputElement>(null);
  const inputFotoRef = useRef<HTMLInputElement>(null);

  const [grupo, setGrupo] = useState<Grupo | null>(null);
  const [cargandoGrupo, setCargandoGrupo] = useState(true);
  const [estado, setEstado] = useState<Estado>('inicial');
  const [alumnos, setAlumnos] = useState<AlumnoPreview[]>([]);
  const [nombreArchivo, setNombreArchivo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [totalGuardados, setTotalGuardados] = useState(0);

  useEffect(() => {
    async function cargarGrupo() {
      setCargandoGrupo(true);
      const { data, error: grupoError } = await supabase
        .from('grupos')
        .select('id, nombre_grupo, institucion_id, docente_id')
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

  async function procesarArchivo(archivo: File) {
    setError(null);
    setNombreArchivo(archivo.name);
    setEstado('analizando');

    const formData = new FormData();
    formData.append('archivo', archivo);

    try {
      const res = await fetch('/api/importar-alumnos', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Ocurrió un error al analizar el archivo.');
        setEstado('inicial');
        return;
      }

      setAlumnos(data.alumnos);
      setEstado('revisando');
    } catch {
      setError('Ocurrió un error de conexión al analizar el archivo.');
      setEstado('inicial');
    }
  }

  function handleArchivoSeleccionado(e: React.ChangeEvent<HTMLInputElement>) {
    const archivo = e.target.files?.[0];
    if (archivo) procesarArchivo(archivo);
  }

  function actualizarAlumno(index: number, campo: keyof AlumnoPreview, valor: string) {
    setAlumnos((prev) =>
      prev.map((a, i) =>
        i === index
          ? {
              ...a,
              [campo]: campo === 'numero_lista' ? (valor ? parseInt(valor, 10) : null) : valor || null,
            }
          : a
      )
    );
  }

  function eliminarAlumno(index: number) {
    setAlumnos((prev) => prev.filter((_, i) => i !== index));
  }

  function agregarFilaVacia() {
    setAlumnos((prev) => [
      ...prev,
      { numero_lista: prev.length + 1, nombre: '', curp: null, sexo: null },
    ]);
  }

  async function confirmarImportacion() {
    if (!grupo) return;
    setError(null);

    const alumnosValidos = alumnos.filter((a) => a.nombre.trim().length > 0);

    if (alumnosValidos.length === 0) {
      setError('No hay alumnos válidos para importar. Verifica que tengan nombre.');
      return;
    }

    setEstado('guardando');

    const registros = alumnosValidos.map((a) => ({
      institucion_id: grupo.institucion_id,
      docente_id: grupo.docente_id,
      grupo_id: grupo.id,
      nombre: a.nombre.trim(),
      numero_lista: a.numero_lista,
      curp: a.curp,
      sexo: a.sexo,
    }));

    const { error: insertError } = await supabase.from('alumnos').insert(registros);

    if (insertError) {
      setError('Ocurrió un error al guardar los alumnos. Intenta de nuevo.');
      setEstado('revisando');
      return;
    }

    setTotalGuardados(registros.length);
    setEstado('listo');
  }

  if (cargandoGrupo) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        Cargando...
      </div>
    );
  }

  if (estado === 'listo') {
    return (
      <div className="mx-auto max-w-lg px-4 py-8 text-center">
        <div className="mb-6 rounded-2xl bg-emerald-50 px-5 py-6">
          <p className="text-lg font-semibold text-emerald-800">
            ¡{totalGuardados} alumno{totalGuardados === 1 ? '' : 's'} agregado
            {totalGuardados === 1 ? '' : 's'} correctamente!
          </p>
          <p className="mt-1 text-sm text-emerald-700">
            Tu grupo {grupo?.nombre_grupo} ya está listo para usar asistencia,
            planeaciones, evaluaciones y fichas descriptivas.
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.push('/dashboard/chat')}
          className="w-full rounded-2xl bg-emerald-600 py-3.5 text-base font-medium text-white transition hover:bg-emerald-700"
        >
          Ir al Chat IA
        </button>
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

      {estado === 'inicial' && (
        <div className="rounded-2xl border-2 border-dashed border-gray-300 px-6 py-10 text-center">
          <p className="mb-5 text-sm text-gray-600">
            Toma una foto de tu lista impresa, o sube un archivo de Excel, PDF
            o Word.
          </p>

          <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
            <input
              ref={inputFotoRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleArchivoSeleccionado}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => inputFotoRef.current?.click()}
              className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-emerald-700"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
                <path d="M4 8a2 2 0 012-2h1.5l1-1.5h7l1 1.5H18a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V8z" strokeLinejoin="round" />
                <circle cx="12" cy="13" r="3.5" />
              </svg>
              Tomar foto
            </button>

            <input
              ref={inputArchivoRef}
              type="file"
              accept=".xlsx,.xls,.pdf,.doc,.docx"
              onChange={handleArchivoSeleccionado}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => inputArchivoRef.current?.click()}
              className="flex items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-5 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
                <path d="M12 3v12m0 0l-4-4m4 4l4-4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Seleccionar archivo
            </button>
          </div>
        </div>
      )}

      {estado === 'analizando' && (
        <div className="rounded-2xl border border-gray-200 px-6 py-10 text-center">
          <p className="text-sm font-medium text-gray-700">
            Analizando {nombreArchivo}...
          </p>
          <p className="mt-1 text-sm text-gray-500">
            La IA está identificando a los alumnos, esto puede tardar unos segundos.
          </p>
        </div>
      )}

      {(estado === 'revisando' || estado === 'guardando') && (
        <div>
          <p className="mb-3 text-sm text-gray-600">
            Revisa y corrige los datos antes de guardar. Se detectaron{' '}
            <span className="font-medium">{alumnos.length}</span> alumnos.
          </p>

          <div className="mb-4 overflow-x-auto rounded-2xl border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Nombre completo</th>
                  <th className="px-3 py-2">CURP</th>
                  <th className="px-3 py-2">Sexo</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {alumnos.map((a, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        value={a.numero_lista ?? ''}
                        onChange={(e) => actualizarAlumno(i, 'numero_lista', e.target.value)}
                        className="w-14 rounded-lg border border-gray-200 px-2 py-1 text-center"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="text"
                        value={a.nombre}
                        onChange={(e) => actualizarAlumno(i, 'nombre', e.target.value)}
                        className="w-full min-w-[180px] rounded-lg border border-gray-200 px-2 py-1"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="text"
                        value={a.curp ?? ''}
                        onChange={(e) => actualizarAlumno(i, 'curp', e.target.value)}
                        className="w-36 rounded-lg border border-gray-200 px-2 py-1 uppercase"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <select
                        value={a.sexo ?? ''}
                        onChange={(e) => actualizarAlumno(i, 'sexo', e.target.value)}
                        className="rounded-lg border border-gray-200 px-2 py-1"
                      >
                        <option value="">—</option>
                        <option value="H">H</option>
                        <option value="M">M</option>
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <button
                        type="button"
                        onClick={() => eliminarAlumno(i)}
                        className="text-gray-400 hover:text-red-600"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            onClick={agregarFilaVacia}
            className="mb-6 text-sm font-medium text-emerald-700 hover:text-emerald-800"
          >
            + Agregar alumno
          </button>

          <button
            type="button"
            onClick={confirmarImportacion}
            disabled={estado === 'guardando'}
            className="w-full rounded-2xl bg-emerald-600 py-3.5 text-base font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50"
          >
            {estado === 'guardando' ? 'Guardando...' : 'Confirmar e importar'}
          </button>
        </div>
      )}
    </div>
  );
}
