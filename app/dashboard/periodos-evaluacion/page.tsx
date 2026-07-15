"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Periodo = {
  id: string;
  numero_periodo: number;
  nombre: string;
  fecha_inicio: string | null;
  fecha_fin: string | null;
};

export default function PeriodosEvaluacionPage() {
  const [periodos, setPeriodos] = useState<Periodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [guardandoId, setGuardandoId] = useState<string | null>(null);

  const cargarPeriodos = async () => {
    setLoading(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const res = await fetch("/api/periodos-evaluacion", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const json = await res.json();
    setPeriodos(json.periodos ?? []);
    setLoading(false);
  };

  useEffect(() => { cargarPeriodos(); }, []);

  const actualizarCampo = (id: string, campo: "fecha_inicio" | "fecha_fin", valor: string) => {
    setPeriodos((prev) => prev.map((p) => (p.id === id ? { ...p, [campo]: valor } : p)));
  };

  const guardarPeriodo = async (periodo: Periodo) => {
    setGuardandoId(periodo.id);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    await fetch("/api/periodos-evaluacion", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        id: periodo.id,
        fecha_inicio: periodo.fecha_inicio,
        fecha_fin: periodo.fecha_fin,
      }),
    });
    setGuardandoId(null);
    cargarPeriodos();
  };

  if (loading) return <p className="p-4">Cargando periodos de evaluación...</p>;

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">Periodos de evaluación</h1>

      {periodos.map((p) => (
        <div key={p.id} className="border rounded-lg p-4 space-y-2">
          <h2 className="font-medium">{p.nombre}</h2>

          {(!p.fecha_inicio || !p.fecha_fin) && (
            <p className="text-amber-600 text-sm">
              Los periodos de evaluación de este ciclo escolar todavía no han sido configurados.
            </p>
          )}

          <div className="flex gap-2 items-center flex-wrap">
            <input
              type="date"
              value={p.fecha_inicio ?? ""}
              onChange={(e) => actualizarCampo(p.id, "fecha_inicio", e.target.value)}
              className="border rounded px-2 py-1"
            />
            <input
              type="date"
              value={p.fecha_fin ?? ""}
              onChange={(e) => actualizarCampo(p.id, "fecha_fin", e.target.value)}
              className="border rounded px-2 py-1"
            />
            <button
              disabled={guardandoId === p.id}
              onClick={() => guardarPeriodo(p)}
              className="bg-blue-600 text-white rounded px-3 py-1 text-sm"
            >
              {guardandoId === p.id ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
