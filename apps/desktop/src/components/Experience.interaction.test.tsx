// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerCard } from "./Composer";
import { CopyButton } from "./CopyButton";
import { ToolPayload } from "./ToolPayload";
import { HtmlPreview } from "./HtmlPreview";
import { MarkdownPreview } from "./MarkdownPreview";

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("reliable composer", () => {
  it("keeps text and attachments when sending is rejected", async () => {
    localStorage.setItem("miniq.draft.a", "original draft");
    localStorage.setItem(
      "miniq.draft.a.attachments",
      JSON.stringify(["/tmp/evidence.md"])
    );
    const onSend = vi.fn().mockResolvedValue(false);
    render(
      <ComposerCard
        busy={false}
        placeholder="message"
        draftKey="a"
        onSend={onSend}
      />
    );
    fireEvent.click(screen.getByTitle("发送"));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("original draft", [
        "/tmp/evidence.md",
      ])
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "original draft"
    );
    expect(screen.getByText("evidence.md")).toBeTruthy();
    expect(localStorage.getItem("miniq.draft.a")).toBe("original draft");
  });
  it("blocks duplicate submissions and does not clear a different session draft", async () => {
    let resolve!: (value: boolean) => void;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        })
    );
    localStorage.setItem("miniq.draft.a", "one");
    localStorage.setItem("miniq.draft.b", "two");
    const { rerender } = render(
      <ComposerCard
        busy={false}
        placeholder="message"
        draftKey="a"
        onSend={onSend}
      />
    );
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    rerender(
      <ComposerCard
        busy={false}
        placeholder="message"
        draftKey="b"
        onSend={onSend}
      />
    );
    await act(async () => {
      resolve(true);
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "two"
    );
    expect(localStorage.getItem("miniq.draft.a")).toBeNull();
    expect(localStorage.getItem("miniq.draft.b")).toBe("two");
  });
  it("does not send IME composition and reports rejected promises", async () => {
    const error = vi.fn();
    render(
      <ComposerCard
        busy={false}
        placeholder="message"
        onSend={() => Promise.reject(new Error("offline"))}
        onError={error}
      />
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "draft" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(error).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(error).toHaveBeenCalledWith("offline"));
    expect((input as HTMLTextAreaElement).value).toBe("draft");
  });
});

describe("inspectable evidence and previews", () => {
  it("renders stdout as real lines while retaining complete JSON", () => {
    const { container } = render(
      <ToolPayload
        label="Result"
        value={{ stdout: "one\ntwo", stderr: "warning", exitCode: 1 }}
      />
    );
    expect(container.querySelectorAll(".payload-line")).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect(container.querySelector("pre")?.textContent).toContain(
      '"exitCode": 1'
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "stderr" },
    });
    expect(container.querySelector("pre")?.textContent).toContain("warning");
  });
  it("copies the complete payload even while a search and later page are selected", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const value = Array.from({ length: 201 }, (_, i) => `row-${i}`).join("\n");
    render(<ToolPayload label="Output" value={value} />);
    fireEvent.click(screen.getByRole("button", { name: "Output下一页" }));
    expect(screen.getByText("row-150", { exact: false })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "row-200" },
    });
    fireEvent.click(screen.getByRole("button", { name: "复制完整Output" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(value));
  });
  it("makes clipboard failures visible", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(<CopyButton label="Copy" content="evidence" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("复制失败")
    );
  });
  it("isolates HTML from the parent origin and requires opt-in for external resources", () => {
    render(
      <HtmlPreview
        content="<h1>artifact</h1><script>window.test=1</script>"
        label="test.html"
      />
    );
    const frame = screen.getByTitle("test.html") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.srcdoc).toContain("connect-src 'none'");
    expect(frame.srcdoc).toContain("window.test=1");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(frame.srcdoc).toContain("connect-src https: http:");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });
  it("navigates Markdown anchors locally and opens exact source lines", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const open = vi.fn();
    render(
      <MarkdownPreview
        content={"# Title\n[go](#title)\n## Next"}
        workspacePath="/tmp"
        currentFilePath="/tmp/test.md"
        onOpenFile={open}
      />
    );
    fireEvent.click(screen.getByRole("link", { name: "go" }));
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    fireEvent.click(screen.getByRole("button", { name: "查看 Next 的源码" }));
    expect(open).toHaveBeenCalledWith({
      path: "/tmp/test.md",
      line: 3,
      column: 1,
    });
  });
});
