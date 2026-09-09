// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HtmlPreview } from "./HtmlPreview";
import { openHtmlPreview, closeHtmlPreview } from "../localHtmlPreview";

vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("../localHtmlPreview", () => ({
  openHtmlPreview: vi.fn(),
  closeHtmlPreview: vi.fn().mockResolvedValue(undefined),
}));
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
const file = {
  path: "/workspace/index.html",
  workspacePath: "/workspace",
  workspacePaths: [],
};

it("uses an isolated URL without granting app-origin privileges and revokes on close", async () => {
  vi.mocked(openHtmlPreview).mockResolvedValue({
    id: "one",
    url: "http://127.0.0.1:1111/one/index.html",
  });
  const view = render(
    <HtmlPreview content="<h1>Document</h1>" label="Document" file={file} />,
  );
  await waitFor(() =>
    expect(screen.getByTitle("Document").getAttribute("src")).toContain(
      "/one/index.html",
    ),
  );
  expect(screen.getByTitle("Document").getAttribute("srcdoc")).toBeNull();
  expect(screen.getByTitle("Document").getAttribute("sandbox")).toBe(
    "allow-scripts",
  );
  expect(openHtmlPreview).toHaveBeenCalledWith(file, false);
  view.unmount();
  expect(closeHtmlPreview).toHaveBeenCalledWith("one");
});

it("revokes a late response after switching files and never renders the old origin", async () => {
  let finish!: (value: { id: string; url: string }) => void;
  vi.mocked(openHtmlPreview)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({
      id: "two",
      url: "http://127.0.0.1:2222/two/second.html",
    });
  const view = render(
    <HtmlPreview content="one" label="Document" file={file} />,
  );
  view.rerender(
    <HtmlPreview
      content="two"
      label="Document"
      file={{ ...file, path: "/workspace/second.html" }}
    />,
  );
  await waitFor(() =>
    expect(screen.getByTitle("Document").getAttribute("src")).toContain(
      "/two/second.html",
    ),
  );
  finish({ id: "one", url: "http://127.0.0.1:1111/one/index.html" });
  await waitFor(() => expect(closeHtmlPreview).toHaveBeenCalledWith("one"));
  expect(screen.getByTitle("Document").getAttribute("src")).toContain(
    "/two/second.html",
  );
});

it("recreates the grant when network access changes and permits retrying a failed open", async () => {
  vi.mocked(openHtmlPreview)
    .mockRejectedValueOnce(new Error("file unavailable"))
    .mockResolvedValueOnce({
      id: "one",
      url: "http://127.0.0.1:1111/one/index.html",
    })
    .mockResolvedValueOnce({
      id: "two",
      url: "http://127.0.0.1:2222/two/index.html",
    });
  render(<HtmlPreview content="one" label="Document" file={file} />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "重试 HTML 预览" }));
  await screen.findByTitle("Document");
  fireEvent.click(screen.getByRole("checkbox", { name: "联网资源" }));
  await waitFor(() =>
    expect(openHtmlPreview).toHaveBeenLastCalledWith(file, true),
  );
  expect(closeHtmlPreview).toHaveBeenCalledWith("one");
  await waitFor(() =>
    expect(screen.getByTitle("Document").getAttribute("src")).toContain(
      "/two/index.html",
    ),
  );
});
