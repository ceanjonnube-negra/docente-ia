import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getClient(accessToken: string) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
}

export async function GET(req: NextRequest) {
  const accessToken = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!accessToken) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const supabase = getClient(accessToken);
  const { data, error } = await supabase
    .from("periodos_evaluacion")
    .select("*")
    .order("numero_periodo", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ periodos: data });
}

export async function PUT(req: NextRequest) {
  const accessToken = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!accessToken) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const { id, fecha_inicio, fecha_fin } = await req.json();
  if (!id) return NextResponse.json({ error: "Falta id del periodo" }, { status: 400 });

  const supabase = getClient(accessToken);
  const { data, error } = await supabase
    .from("periodos_evaluacion")
    .update({ fecha_inicio, fecha_fin, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ periodo: data });
}
