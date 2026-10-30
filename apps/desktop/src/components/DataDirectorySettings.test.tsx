// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataDirectorySettings } from "./DataDirectorySettings";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
describe("desktop data directory settings", () => {
  beforeEach(() => {
    invoke.mockImplementation((command: string) => command === "current_data_directory"
      ? Promise.resolve({ path: "C:\\Users\\test\\AppData\\Local\\miniq", managedByEnvironment: false })
      : Promise.resolve("D:\\miniQ-data"));
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads the current directory and migrates it through the Tauri command", async () => {
    render(<DataDirectorySettings />);
    await waitFor(() => expect((screen.getByLabelText("当前目录") as HTMLInputElement).value).toBe("C:\\Users\\test\\AppData\\Local\\miniq"));

    fireEvent.click(screen.getByRole("button", { name: "更换数据目录" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("choose_data_directory"));
    expect((screen.getByLabelText("当前目录") as HTMLInputElement).value).toBe("D:\\miniQ-data");
    expect(screen.getByText(/数据已迁移/)).toBeTruthy();
  });
});
