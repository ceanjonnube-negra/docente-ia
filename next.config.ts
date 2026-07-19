import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // /dashboard/chat es un alias heredado (varios enlaces existentes,
  // ej. el ícono central de Inicio, todavía apuntan aquí) — la decisión
  // de a dónde va vive en la configuración de rutas, no en un
  // useEffect + router.replace() dentro de un componente (ver RFC-0001:
  // Chat IA como Entry Point). /dashboard ya abre el panel del Chat IA
  // directo al montar (ver app/dashboard/page.tsx), así que este alias
  // solo necesita aterrizar ahí — nunca ejecuta código de React.
  async redirects() {
    return [
      {
        source: "/dashboard/chat",
        destination: "/dashboard",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
