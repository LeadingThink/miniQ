import type { ModelPerformanceMetric } from "../modelPerformance";
import { formatPerformanceValue } from "../modelPerformance";

export function ModelPerformanceIndicator({
  modelId,
  metric,
  windowHours,
}: {
  modelId: string;
  metric?: ModelPerformanceMetric;
  windowHours: number | null;
}) {
  if (!metric || metric.availability === null || metric.throughput === null) {
    return (
      <span
        className="model-performance model-performance-empty"
        aria-label={`${modelId} 暂无可用性统计`}
      >
        暂无统计
      </span>
    );
  }
  const availability = formatPerformanceValue(metric.availability);
  const throughput = formatPerformanceValue(metric.throughput);
  const hours = windowHours ?? 0;
  return (
    <span
      className="model-performance"
      aria-label={`${modelId} 可用性 ${availability}%，吞吐 ${throughput} t/s，${hours} 小时样本 ${metric.samples}`}
    >
      <span className="model-performance-values" aria-hidden="true">
        <span className="model-performance-value">
          <span>可用性</span>
          <b>{availability}%</b>
        </span>
        <span className="model-performance-divider" />
        <span className="model-performance-value">
          <span>吞吐</span>
          <b>{throughput} t/s</b>
        </span>
      </span>
      {metric.series.length > 0 && (
        <span className="model-performance-chart" aria-hidden="true">
          {metric.series.map((point, index) => (
            <span
              className="model-performance-bar"
              data-empty={point.samples === 0 || point.availability === null || undefined}
              key={`${point.ts}-${index}`}
              style={{ height: `${Math.max(2, (point.availability ?? 0) / 10)}px` }}
            />
          ))}
        </span>
      )}
    </span>
  );
}