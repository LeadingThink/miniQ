export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  /** Render a block of text lines instead of a single bar. */
  lines?: number;
  circle?: boolean;
  className?: string;
}

export function Skeleton({ width, height, lines, circle, className }: SkeletonProps) {
  const dimension = (value: number | string | undefined) =>
    typeof value === "number" ? `${value}px` : value;
  if (lines && lines > 1) {
    return (
      <div className={`ui-skeleton-lines ${className ?? ""}`.trim()} aria-hidden="true">
        {Array.from({ length: lines }, (_, index) => (
          <span
            key={index}
            className="ui-skeleton"
            style={{ width: index === lines - 1 ? "62%" : dimension(width) ?? "100%" }}
          />
        ))}
      </div>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`ui-skeleton ${circle ? "circle" : ""} ${className ?? ""}`.trim()}
      style={{ width: dimension(width), height: dimension(height) }}
    />
  );
}
