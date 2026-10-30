export interface ModelPerformanceSeriesPoint {
  ts: number;
  availability: number | null;
  samples: number;
}

export interface ModelPerformanceMetric {
  availability: number | null;
  throughput: number | null;
  samples: number;
  series: ModelPerformanceSeriesPoint[];
}

export interface ModelPerformanceResult {
  windowHours: number;
  models: Record<string, ModelPerformanceMetric>;
}

export function formatPerformanceValue(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 2,
  }).format(value);
}