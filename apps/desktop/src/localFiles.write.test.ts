import { beforeEach, expect, it, vi } from "vitest";
import { writeLocalTextFile } from "./localFiles";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("./runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => invoke.mockReset());

it("passes the same path and authorization scope to the local write command", async () => {
  invoke.mockResolvedValue(undefined);
  await writeLocalTextFile(
    "/cache/已粘贴的文本.txt",
    "updated",
    "/workspace",
    ["/attached"],
    ["/cache/已粘贴的文本.txt"],
  );
  expect(invoke).toHaveBeenCalledExactlyOnceWith("write_local_text_file", {
    path: "/cache/已粘贴的文本.txt",
    content: "updated",
    workspacePath: "/workspace",
    workspacePaths: ["/attached"],
    authorizedFiles: ["/cache/已粘贴的文本.txt"],
  });
});
