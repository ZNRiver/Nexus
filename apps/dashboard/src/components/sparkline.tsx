interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: boolean;
  className?: string;
}

export function Sparkline({ data, width = 120, height = 32, stroke = "rgb(var(--primary))", fill = true, className }: SparklineProps) {
  if (data.length < 2) {
    return <div className={className} style={{ width, height }} />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const points = data.map((v, i) => {
    const x = i * step;
    const y = height - 2 - ((v - min) / range) * (height - 4);
    return `${x},${y}`;
  });
  const line = points.join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  const id = `spark-${stroke.replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg width={width} height={height} className={className} aria-hidden="true">
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
      <polyline points={line} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-sm" />
    </svg>
  );
}
