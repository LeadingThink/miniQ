// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { uploadRemoteFile } from "../remoteTransfer";
import { HeroPage } from "./HeroPage";

vi.mock("../runtime", () => ({ isTauriRuntime: () => false }));
vi.mock("../remoteTransfer", () => ({ uploadRemoteFile: vi.fn() }));
vi.mock("../remoteUploadSource", () => ({
  usesNativeUploadPicker: () => false,
  stageBrowserUploadSources: vi.fn(async (files) => files),
  releaseUploadSources: vi.fn(async () => {}),
}));
vi.mock("./SessionModelControls", () => ({ SessionModelControls: () => null }));
vi.mock("./VoiceInput", () => ({ VoiceInput: () => null }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

function app(withProject: boolean) {
  const workspace = { id: "workspace-1", name: "stock_news", path: "/stock_news" };
  return {
    client: { mode: "remote", storageScope: "remote-a", call: vi.fn().mockResolvedValue({ skills: [] }) },
    catalog: { selectedWorkspace: withProject ? workspace : undefined, workspaces: [workspace] },
    connection: { providerConfigured: true, approvalMode: "auto", changeApprovalMode: vi.fn() },
    navigation: { setPage: vi.fn(), openSettings: vi.fn() },
    sessionModel: {},
    actions: { selectProject: vi.fn(), startTask: vi.fn().mockResolvedValue(true) },
    setError: vi.fn(),
  } as unknown as MiniqAppController;
}
function openAttachment() {
  fireEvent.click(screen.getByRole("button", { name: "更多输入方式" }));
  fireEvent.click(screen.getByRole("button", { name: "附加远程文件" }));
}

it("new-session screen uploads from the phone into the selected project's inbox", async () => {
  const controller = app(true);
  vi.mocked(uploadRemoteFile).mockResolvedValueOnce({ status: "completed", path: "/stock_news/inbox/u/a.jpg", size: 1, sha256: "a".repeat(64) });
  render(<HeroPage app={controller} slashCommands={[]} />);
  openAttachment();
  const file = new File(["x"], "a.jpg", { type: "image/jpeg" });
  fireEvent.change(screen.getByLabelText("选择本机文件"), { target: { files: [file] } });
  await waitFor(() => expect(uploadRemoteFile).toHaveBeenCalledOnce());
  expect(vi.mocked(uploadRemoteFile).mock.calls[0].slice(0, 3)).toEqual([controller.client, { workspaceId: "workspace-1" }, file]);
  await waitFor(() => expect(screen.getByRole("button", { name: "移除附件 a.jpg" })).toBeTruthy());
  expect(controller.actions.startTask).not.toHaveBeenCalled();
  expect(Object.keys(localStorage).some((key) => key.includes("attachments") && localStorage.getItem(key)?.includes("/stock_news/inbox/u/a.jpg"))).toBe(true);
});
it("new-session screen without a project asks the user to choose one instead of uploading", () => {
  render(<HeroPage app={app(false)} slashCommands={[]} />);
  openAttachment();
  expect(screen.getByText(/请先选择一个项目/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "上传照片原件" })).toBeNull();
  expect(uploadRemoteFile).not.toHaveBeenCalled();
});
