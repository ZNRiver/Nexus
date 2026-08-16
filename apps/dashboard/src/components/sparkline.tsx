import { cn } from "@/lib/utils";

interface SparklineProps {
  data: number[];
  /** Fixed pixel width when set; otherwise the SVG fills its container. */
  width?: number;
  height?: number;
  stroke?: string;
  fill?: boolean;
  className?: string;
}

export function Sparkline({ data, width, height = 32, stroke = "rgb(var(--primary))", fill = true, className }: SparklineProps) {
  if (data.length < 2) {
    return <div className={className} style={{ width, height }} aria-hidden="true" />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  // viewBox coordinate space — independent from the rendered size, so the
  // sparkline scales fluidly instead of overflowing on narrow screens.
  const vbW = width ?? 100;
  const step = vbW / (data.length - 1);
  const points = data.map((v, i) => {
    const x = i * step;
    const y = height - 2 - ((v - min) / range) * (height - 4);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = points.join(" ");
  const area = `0,${height} ${line} ${vbW},${height}`;
  const id = `spark-${stroke.replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg
      viewBox={`0 0 ${vbW} ${height}`}
      preserveAspectRatio="none"
      className={cn("h-auto", width ? "" : "w-full", className)}
      style={width ? { width, height } : undefined}
      aria-hidden="true"
    >
      {fill && (
        <>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.2" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon points={area} fill={`url(#${id})`} />
        </>
      )}
      <polyline points={line} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
