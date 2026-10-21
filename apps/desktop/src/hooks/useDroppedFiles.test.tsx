// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useDroppedFiles } from "./useDroppedFiles";
import { imageTooLarge } from "../imageLimits";

const fake = vi.hoisted(() => ({
  subscribe: vi.fn(),
  drop: null as null | ((event: unknown) => void),
  invoke: vi.fn(),
}));
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: async (callback: (event: unknown) => void) => {
      fake.subscribe();
      fake.drop = callback;
      return () => {};
    },
  }),
}));
afterEach(cleanup);

function Target(props: { name: string; onFiles: (name: string, paths: string[]) => void; onError?: () => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useDroppedFiles(input, (paths) => props.onFiles(props.name, paths), props.onError);
  return <textarea aria-label={props.name} ref={input} />;
}

const drop = (paths: string[]) => act(() => fake.drop!({ payload: { type: "drop", paths } }));

it("keeps one native subscription while callbacks change and routes a drop to one composer", async () => {
  const onFiles = vi.fn();
  const view = render(<><Target name="a" onFiles={onFiles} /><Target name="b" onFiles={onFiles} /></>);
  await vi.waitFor(() => expect(fake.drop).not.toBeNull());
  view.rerender(<><Target name="a" onFiles={onFiles} onError={() => {}} /><Target name="b" onFiles={onFiles} onError={() => {}} /></>);
  drop(["/work/latest.png"]);
  expect(onFiles).toHaveBeenCalledExactlyOnceWith("b", ["/work/latest.png"]);
  (view.getByLabelText("a") as HTMLTextAreaElement).focus();
  drop(["/work/focused.png"]);
  expect(onFiles).toHaveBeenLastCalledWith("a", ["/work/focused.png"]);
  fake.drop!({ payload: { type: "over", position: { x: 0, y: 0 } } });
  expect(onFiles).toHaveBeenCalledTimes(2);
  expect(fake.subscribe).toHaveBeenCalledOnce();
});

it("never delivers a drop to a composer inside an inactive host", async () => {
  const onFiles = vi.fn();
  render(<><Target name="visible" onFiles={onFiles} /><div inert><Target name="hidden" onFiles={onFiles} /></div></>);
  await vi.waitFor(() => expect(fake.drop).not.toBeNull());
  drop(["/work/report.pdf"]);
  expect(onFiles).toHaveBeenCalledExactlyOnceWith("visible", ["/work/report.pdf"]);
});

it("saves an image dragged from a browser, which carries no file path", async () => {
  const onFiles = vi.fn();
  fake.invoke.mockResolvedValueOnce("/cache/pasted-images/dragged.png");
  render(<Target name="a" onFiles={onFiles} />);
  await vi.waitFor(() => expect(fake.drop).not.toBeNull());
  drop([]);
  await vi.waitFor(() => expect(onFiles).toHaveBeenCalledExactlyOnceWith("a", ["/cache/pasted-images/dragged.png"]));
  expect(fake.invoke).toHaveBeenCalledWith("save_dragged_image");
});

it("ignores a path-less drop without an image and reports save failures", async () => {
  const onFiles = vi.fn();
  const onError = vi.fn();
  fake.invoke.mockClear();
  render(<Target name="a" onFiles={onFiles} onError={onError} />);
  await vi.waitFor(() => expect(fake.drop).not.toBeNull());
  fake.invoke.mockResolvedValueOnce(null);
  drop([]);
  await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalledTimes(1));
  fake.invoke.mockRejectedValueOnce(imageTooLarge());
  drop([]);
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(`无法接收拖入图片: ${imageTooLarge().message}`));
  expect(onFiles).not.toHaveBeenCalled();
});
