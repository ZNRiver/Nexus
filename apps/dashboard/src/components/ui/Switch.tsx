interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
  ariaLabel?: string;
  className?: string;
}

const DIMS = {
  sm: { track: "h-4 w-7", knob: "size-3", on: "translate-x-3.5", off: "translate-x-0.5" },
  md: { track: "h-5 w-9", knob: "size-4", on: "translate-x-[18px]", off: "translate-x-0.5" },
  lg: { track: "h-6 w-11", knob: "size-5", on: "translate-x-[22px]", off: "translate-x-0.5" },
} as const;

export function Switch({ checked, onChange, disabled = false, size = "md", ariaLabel, className = "" }: SwitchProps) {
  const dims = DIMS[size];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex ${dims.track} shrink-0 items-center rounded-full transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${
        checked ? "bg-primary" : "bg-muted-foreground/30"
      } ${className}`}
    >
      <span className={`inline-block ${dims.knob} transform rounded-full bg-white shadow-sm transition-all duration-200 ${checked ? dims.on : dims.off}`} />
    </button>
  );
}
