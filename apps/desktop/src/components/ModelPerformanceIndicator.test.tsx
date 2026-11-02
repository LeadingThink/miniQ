// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ModelPerformanceMetric } from "../modelPerformance";
import { ModelPerformanceIndicator } from "./ModelPerformanceIndicator";

afterEach(cleanup);

function metric(overrides: Partial<ModelPerformanceMetric> = {}): ModelPerformanceMetric {
  return {
    availability: 99.94,
    throughput: 12.5,
    samples: 20,
    series: [{ ts: 1, availability: 99.94, samples: 20 }],
    ...overrides,
  };
}

it("renders only model availability", () => {
  const { container } = render(
    <ModelPerformanceIndicator modelId="gpt-test" metric={metric()} />,
  );

  expect(screen.getByLabelText("gpt-test 可用性 99.94%")).toBeTruthy();
  expect(container.textContent).toBe("可用性99.94%");
  expect(container.textContent).not.toContain("吞吐");
  expect(container.querySelector(".model-performance-chart")).toBeNull();
});

it("does not require throughput or history to show availability", () => {
  render(
    <ModelPerformanceIndicator
      modelId="gpt-test"
      metric={metric({ throughput: null, series: [] })}
    />,
  );

  expect(screen.getByLabelText("gpt-test 可用性 99.94%")).toBeTruthy();
});

it("shows the empty state when availability is missing", () => {
  render(
    <ModelPerformanceIndicator
      modelId="gpt-test"
      metric={metric({ availability: null })}
    />,
  );

  expect(screen.getByLabelText("gpt-test 暂无可用性统计")).toBeTruthy();
});