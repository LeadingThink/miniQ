// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    expect(screen.getByText(label).classList.contains("artifact-card-format")).toBe(true);
  });

  it("falls back to a generic file icon", () => {
    const container = renderCard(artifact("/w/blob", "media"));
    expect(container.querySelector(".artifact-file-icon")?.classList.contains("is-other")).toBe(true);
  });

  it("renders the artifact directory as one readable path", () => {
    renderCard(artifact("D:/study/.miniq/media/sess_97dc4c7cc8/image.png", "media"));

    expect(screen.getByTitle("D:/study/.miniq/media/sess_97dc4c7cc8").className).toBe("artifact-path");
  });
});

describe("ArtifactCard narrow WebView layout", () => {
  it("shrinks the file path beside fixed actions", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/ArtifactCard.css"), "utf8");
    const rule = (selector: string) => css.match(new RegExp(`\\${selector} \\{([^}]*)\\}`))?.[1] ?? "";

    expect(rule(".artifact-file")).toMatch(/flex:\s*1 1 auto/);
    expect(rule(".artifact-file")).toMatch(/min-width:\s*0/);
    expect(rule(".artifact-file-copy")).toMatch(/flex:\s*1 1 auto/);
    expect(rule(".artifact-file-copy")).toMatch(/overflow:\s*hidden/);
    expect(rule(".artifact-file-name")).toMatch(/width:\s*100%/);
    expect(rule(".artifact-open")).toMatch(/flex:\s*1 1 auto/);
    expect(rule(".artifact-open")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".artifact-open")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".artifact-actions")).toMatch(/flex:\s*none/);
  });

  it("moves fixed actions below the file details when its panel is narrow", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/ArtifactCard.css"), "utf8");

    expect(css).toMatch(/\.artifact-card\s*\{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(
      /@container\s*\(max-width:\s*480px\)\s*\{[\s\S]*?\.artifact-item\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*stretch;[^}]*\}[\s\S]*?\.artifact-actions\s*\{[^}]*align-self:\s*flex-end;/,
    );
    expect(css).toMatch(
      /@container\s*\(max-width:\s*480px\)\s*\{[\s\S]*?\.artifact-path\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/,
    );
  });
});
