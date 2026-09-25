"use client";
import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

// EVAL-1F — pantalla mínima de revisión/corrección: para cada alumno x
// indicador ya transcrito en EVAL-1D/EVAL-1D.2, muestra el nivel leído
// y resalta las celdas que EVAL-1E marcó como bloqueantes (lectura
// ambigua o confianza no-alta). El docente corrige a mano UNA celda a
// la vez (corregir-celda) y confirma cuando ya no queda ninguna
// bloqueante (confirmar-hoja) — mismo criterio "un solo dato, una sola
// vez" del proyecto: nunca reescribe celdas limpias, solo las que de
// verdad lo necesitan.

type Lectura =
  | { estado: "nivel"; nivel: 1 | 2 | 3 | 4 }
  | { estado: "no_evaluado" }
  | { estado: "lectura_dudosa" };

type Celda = {
  numeroIndicador: number;
  indicadorEspecifico: string;
  lectura: Lectura;
  confianza: "alta" | "media" | "baja";
  bloqueante: boolean;
  corregidoManualmente: boolean;
};

type Alumno = {
  alumnoId: string;
  posicion: number;
  nombre: string;
  cubierto: boolean;
  celdas: Celda[];
};

type Matriz = {
  alumnos: Alumno[];
  coberturaCompleta: boolean;
  totalBloqueantes: number;
  listaParaConfirmar: boolean;
};

const ETIQUETA_NIVEL: Record<1 | 2 | 3 | 4, string> = {
  4: "4 — Dominio destacado",
  3: "3 — Logro esperado",
  2: "2 — En proceso",
  1: "1 — Requiere apoyo",
};

function textoLectura(lectura: Lectura): string {
  if (lectura.estado === "nivel") return String(lectura.nivel);
  if (lectura.estado === "no_evaluado") return "—";
  return "?";
}

export default function RevisarHojaPage() {
  const params = useParams();
  const proyectoId = params.id as string;

  const [matriz, setMatriz] = useState<Matriz | null>(null);
  const [estadoProyecto, setEstadoProyecto] = useState<string>("");
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [celdaGuardando, setCeldaGuardando] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [confirmado, setConfirmado] = useState(false);

  const cargarMatriz = useCallback(async () => {
    setCargando(true);
    setError(null);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setError("Tu sesión expiró. Vuelve a iniciar sesión.");
      setCargando(false);
      return;
    }
    const res = await fetch(`/api/proyectos-seguimiento/${proyectoId}/revisar-hoja`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "No se pudo cargar la revisión de esta hoja.");
      setCargando(false);
      return;
    }
    setMatriz(json.matriz);
    setEstadoProyecto(json.estado);
    setConfirmado(json.estado === "confirmado");
    setCargando(false);
  }, [proyectoId]);

  useEffect(() => {
    cargarMatriz();
  }, [cargarMatriz]);

  const corregirCelda = async (posicion: number, numeroIndicador: number, nivel: 1 | 2 | 3 | 4 | null) => {
    const claveCelda = `${posicion}-${numeroIndicador}`;
    setCeldaGuardando(claveCelda);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setError("Tu sesión expiró. Vuelve a iniciar sesión.");
      setCeldaGuardando(null);
      return;
    }
    const res = await fetch(`/api/proyectos-seguimiento/${proyectoId}/corregir-celda`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: session.access_token, posicion, numeroIndicador, nivel }),
    });
    const json = await res.json();
    setCeldaGuardando(null);
    if (!res.ok) {
      setError(json.error || "No se pudo guardar la corrección.");
      return;
    }
    // Actualiza solo esa celda en el estado local — evita recargar
    // toda la matriz por cada corrección.
    setMatriz((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        totalBloqueantes: json.totalBloqueantes,
        listaParaConfirmar: prev.coberturaCompleta && json.totalBloqueantes === 0,
        alumnos: prev.alumnos.map((alumno) =>
          alumno.posicion !== posicion
            ? alumno
            : {
                ...alumno,
                celdas: alumno.celdas.map((celda) =>
                  celda.numeroIndicador !== numeroIndicador
                    ? celda
                    : {
                        ...celda,
                        lectura: json.celda.lectura,
                        confianza: json.celda.confianza,
                        bloqueante: json.celda.bloqueante,
                        corregidoManualmente: json.celda.corregidoManualmente,
                      }
                ),
              }
        ),
      };
    });
  };

  const confirmar = async () => {
    setConfirmando(true);
    setError(null);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setError("Tu sesión expiró. Vuelve a iniciar sesión.");
      setConfirmando(false);
      return;
    }
    const res = await fetch(`/api/proyectos-seguimiento/${proyectoId}/confirmar-hoja`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: session.access_token }),
    });
    const json = await res.json();
    setConfirmando(false);
    if (!res.ok) {
      setError(json.error || "No se pudo confirmar la hoja.");
      return;
    }
    setConfirmado(true);
    setEstadoProyecto("confirmado");
  };

  if (cargando) return <p className="p-4">Cargando revisión de la hoja...</p>;
  if (error && !matriz) return <p className="p-4 text-red-600">{error}</p>;
  if (!matriz) return null;

  return (
    <div className="p-4 space-y-4 max-w-2xl mx-auto">
      <h1 className="text-xl font-semibold">Revisar resultados</h1>

      {error && <p className="text-red-600 text-sm">{error}</p>}

      {confirmado && (
        <p className="text-green-700 bg-green-50 border border-green-200 rounded-lg p-3 text-sm">
          Esta hoja ya fue confirmada. Los resultados quedaron guardados.
        </p>
      )}

      {!matriz.coberturaCompleta && (
        <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
          La fotografía no cubrió a todos los alumnos de esta hoja — vuelve a fotografiar y analizar la hoja completa antes de poder confirmar.
        </p>
      )}

      {matriz.coberturaCompleta && matriz.totalBloqueantes > 0 && !confirmado && (
        <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
          {matriz.totalBloqueantes} celda(s) tienen una lectura ambigua o poco confiable — corrígelas abajo antes de confirmar.
        </p>
      )}

      <div className="space-y-3">
        {matriz.alumnos.map((alumno) => (
          <div key={alumno.alumnoId} className="border rounded-lg p-3 space-y-2">
            <h2 className="font-medium">
              {alumno.posicion}. {alumno.nombre}
            </h2>

            {!alumno.cubierto ? (
              <p className="text-sm text-gray-500">Sin fotografía legible para este alumno.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {alumno.celdas.map((celda) => {
                  const clave = `${alumno.posicion}-${celda.numeroIndicador}`;
                  const guardando = celdaGuardando === clave;
                  return (
                    <div key={clave} className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-gray-600 min-w-[90px]">
                        I{celda.numeroIndicador}
                      </span>
                      <span
                        className={
                          "inline-flex items-center justify-center w-7 h-7 rounded text-sm font-medium " +
                          (celda.corregidoManualmente
                            ? "bg-green-100 text-green-800"
                            : celda.bloqueante
                            ? "bg-amber-100 text-amber-800"
                            : "bg-gray-100 text-gray-700")
                        }
                      >
                        {textoLectura(celda.lectura)}
                      </span>
                      {celda.bloqueante && !confirmado && (
                        <div className="flex gap-1 flex-wrap">
                          {([4, 3, 2, 1] as const).map((n) => (
                            <button
                              key={n}
                              disabled={guardando}
                              onClick={() => corregirCelda(alumno.posicion, celda.numeroIndicador, n)}
                              className="text-xs border rounded px-2 py-1 hover:bg-gray-50 disabled:opacity-50"
                              title={ETIQUETA_NIVEL[n]}
                            >
                              {n}
                            </button>
                          ))}
                          <button
                            disabled={guardando}
                            onClick={() => corregirCelda(alumno.posicion, celda.numeroIndicador, null)}
                            className="text-xs border rounded px-2 py-1 hover:bg-gray-50 disabled:opacity-50"
                          >
                            No evaluado
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {!confirmado && (
        <button
          disabled={!matriz.listaParaConfirmar || confirmando}
          onClick={confirmar}
          className="w-full bg-blue-600 text-white rounded-lg py-2 font-medium disabled:opacity-40"
        >
          {confirmando ? "Confirmando..." : "Confirmar resultados"}
        </button>
      )}
    </div>
  );
}
