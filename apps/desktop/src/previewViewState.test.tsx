// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
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
