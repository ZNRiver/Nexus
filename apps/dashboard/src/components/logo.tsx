export function Logo({ size = 26, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="rgb(var(--primary))" />
      <path d="M9 22V10l14 12V10" stroke="rgb(var(--primary-foreground))" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function BrandLogo({ size = 26, className = "" }: { size?: number; className?: string }) {
  return <Logo size={size} className={className} />;
}
