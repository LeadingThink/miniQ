// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useRef } from "react";
import {
  PreviewViewProvider,
  PreviewViewStore,
  usePreviewScroll,
  usePreviewValue,
} from "./previewViewState";

afterEach(cleanup);
function Inspector() {
  const [zoom, setZoom] = usePreviewValue("zoom", 100);
  const scroll = usePreviewScroll<HTMLDivElement>("document");
  return (
    <>
      <button onClick={() => setZoom(200)}>{zoom}%</button>
      <div data-testid="viewport" {...scroll} />
    </>
  );
}

it("restores view state per session and file without cross-session leakage", () => {
  const store = new PreviewViewStore();
  const element = (scope: string, path: string) => (
    <PreviewViewProvider store={store} scope={scope} path={path}>
      <Inspector />
    </PreviewViewProvider>
  );
  const view = render(element("one", "/a"));
  fireEvent.click(screen.getByRole("button"));
  const first = screen.getByTestId("viewport");
  first.scrollTop = 450;
  first.scrollLeft = 30;
  fireEvent.scroll(first);
  view.rerender(element("one", "/b"));
  expect(screen.getByRole("button").textContent).toBe("100%");
  expect(screen.getByTestId("viewport").scrollTop).toBe(0);
  view.rerender(element("two", "/a"));
  expect(screen.getByRole("button").textContent).toBe("100%");
  view.rerender(element("one", "/a"));
  expect(screen.getByRole("button").textContent).toBe("200%");
  expect(screen.getByTestId("viewport").scrollTop).toBe(450);
  expect(screen.getByTestId("viewport").scrollLeft).toBe(30);
  view.rerender(element("two", "/a"));
  store.closeFile("one", "/a");
  view.rerender(element("one", "/a"));
  expect(screen.getByRole("button").textContent).toBe("100%");
});

it("restores a provided viewport only after document layout is ready", () => {
  const store = new PreviewViewStore();
  store
    .forFile("session", "/paper.pdf")
    .set("scroll:page", { top: 500, left: 60 });
  function Document({ ready }: { ready: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const scroll = usePreviewScroll("page", ready, ref);
    return <div data-testid="document" {...scroll} />;
  }
  const element = (ready: boolean) => (
    <PreviewViewProvider store={store} scope="session" path="/paper.pdf">
      <Document ready={ready} />
    </PreviewViewProvider>
  );
  const view = render(element(false));
  const viewport = screen.getByTestId("document");
  expect(viewport.scrollTop).toBe(0);
  fireEvent.scroll(viewport);
  view.rerender(element(true));
  expect(viewport.scrollTop).toBe(500);
  expect(viewport.scrollLeft).toBe(60);
});
