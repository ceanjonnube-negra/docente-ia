// Iconografía discreta de Planeación: SVG de trazo, hereda el color del texto.

type Props = { className?: string }
const base = (className = 'w-4 h-4') => ({
  className,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
})

export function IconoCalendario({ className }: Props) {
  return <svg {...base(className)}><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 9.5h17M8 3v4M16 3v4" /></svg>
}
export function IconoSesiones({ className }: Props) {
  return <svg {...base(className)}><path d="M12 3.5 3.5 8 12 12.5 20.5 8 12 3.5Z" /><path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5" /></svg>
}
export function IconoCampo({ className }: Props) {
  return <svg {...base(className)}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5" /></svg>
}
export function IconoHoja({ className }: Props) {
  return <svg {...base(className)}><rect x="5" y="4" width="14" height="17" rx="2.5" /><path d="M9 4V3h6v1M8.5 10h7M8.5 14h7M8.5 18h4" /></svg>
}
export function IconoDocumento({ className }: Props) {
  return <svg {...base(className)}><path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8l-5-5Z" /><path d="M14 3v5h5" /></svg>
}
export function IconoHistorial({ className }: Props) {
  return <svg {...base(className)}><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3.5 4v4h4M12 7.5V12l3 2" /></svg>
}
export function IconoAtras({ className }: Props) {
  return <svg {...base(className)}><path d="m14.5 5.5-6.5 6.5 6.5 6.5" /></svg>
}
export function IconoSiguiente({ className }: Props) {
  return <svg {...base(className)}><path d="m9.5 5.5 6.5 6.5-6.5 6.5" /></svg>
}
export function IconoBiblioteca({ className }: Props) {
  return <svg {...base(className)}><path d="M5 4h3v16H5zM10 4h3v16h-3z" /><path d="m15.5 5 2.9-.8 3.1 15.3-2.9.8z" /></svg>
}
