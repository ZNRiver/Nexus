export function Logo({ size = 26, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="logo-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="rgb(var(--primary))" />
          <stop offset="100%" stopColor="rgb(var(--primary))" stopOpacity="0.8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#logo-gradient)" />
      <path d="M9 22V10l14 12V10" stroke="rgb(var(--primary-foreground))" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function BrandLogo({ size = 26, className = "" }: { size?: number; className?: string }) {
  return <Logo size={size} className={className} />;
}
