// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ModelPerformanceMetric } from "../modelPerformance";
import { ModelPerformanceIndicator } from "./ModelPerformanceIndicator";

function metricWithSeries(length: number): ModelPerformanceMetric {
  return {
    availability: 100,
    throughput: 12.5,
    samples: length,
    series: Array.from({ length }, (_, index) => ({
      ts: index + 1,
      availability: (index + 1) * 10,
      samples: 1,
    })),
  };
}

it("renders only the latest ten performance samples", () => {
  const { container } = render(
    <ModelPerformanceIndicator
      modelId="gpt-test"
      metric={metricWithSeries(12)}
      windowHours={72}
    />,
  );
  const bars = container.querySelectorAll(".model-performance-bar");

  expect(bars).toHaveLength(10);
  expect(bars[0]?.getAttribute("style")).toContain("height: 3px");
  expect(bars[9]?.getAttribute("style")).toContain("height: 12px");
});

it("renders all performance samples when there are fewer than ten", () => {
  const { container } = render(
    <ModelPerformanceIndicator
      modelId="gpt-test"
      metric={metricWithSeries(3)}
      windowHours={72}
    />,
  );

  expect(container.querySelectorAll(".model-performance-bar")).toHaveLength(3);
});