// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactCard } from "./TimelineInteractions";
import type { Artifact } from "../types";

afterEach(cleanup);

const artifact = (path: string, kind: string): Artifact => ({
  id: path,
  sessionId: "sess_1",
  path,
  kind,
  title: path.split("/").at(-1)!,
  createdAt: "2026-10-10T08:00:00Z",
});

function renderCard(item: Artifact) {
  const { container } = render(
    <ArtifactCard artifact={item} workspacePath="/w" onOpenFile={vi.fn()} onError={vi.fn()} />,
  );
  return container;
}

describe("ArtifactCard file types", () => {
  it.each([
    ["/w/a.pdf", "pdf", "is-pdf", "PDF"],
    ["/w/b.docx", "docx", "is-word", "Word"],
    ["/w/c.xlsx", "xlsx", "is-excel", "Excel"],
    ["/w/d.pptx", "pptx", "is-ppt", "PPT"],
    ["/w/e.png", "media", "is-image", "图片"],
  ])("shows a typed icon and label for %s", (path, kind, iconClass, label) => {
    const container = renderCard(artifact(path, kind));
    expect(container.querySelector(".artifact-file-icon")?.classList.contains(iconClass)).toBe(true);
    expect(screen.getByText(label).classList.contains("badge")).toBe(true);
  });

  it("falls back to a generic file icon", () => {
    const container = renderCard(artifact("/w/blob", "media"));
    expect(container.querySelector(".artifact-file-icon")?.classList.contains("is-other")).toBe(true);
  });
});
