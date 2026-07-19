import AsistentePanel from '@/components/Asistente/AsistentePanel'
import BuildBadge from '@/components/BuildBadge'

// Layout persistente de /dashboard/*. AsistentePanel se monta aquí, una
// sola vez para toda la aplicación — no dentro de ninguna pantalla — así
// que la conversación y el contexto sobreviven a la navegación entre
// Lista, Planeación, Fichas, etc.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <AsistentePanel />
      <BuildBadge />
    </>
  )
}
