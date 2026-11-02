import type { ModelPerformanceMetric } from "../modelPerformance";
import { formatPerformanceValue } from "../modelPerformance";

export function ModelPerformanceIndicator({
  modelId,
  metric,
}: {
  modelId: string;
  metric?: ModelPerformanceMetric;
}) {
  if (!metric || metric.availability === null) {
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
  return (
    <span
      className="model-performance"
      aria-label={`${modelId} 可用性 ${availability}%`}
    >
      <span className="model-performance-value" aria-hidden="true">
        <span>可用性</span>
        <b>{availability}%</b>
      </span>
    </span>
  );
}