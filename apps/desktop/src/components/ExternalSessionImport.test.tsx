// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { ExternalSessionScan, Workspace } from "../types";
import { ExternalSessionImportDialog } from "./ExternalSessionImport";

const scan: ExternalSessionScan = {
  providers: [],
  sessions: [],
  errors: [],
};

const workspaces: Workspace[] = [
  {
    id: "workspace-1",
    path: "C:/work/one",
    additionalPaths: [],
    name: "项目一",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "workspace-2",
    path: "C:/work/two",
    additionalPaths: [],
    name: "项目二",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

afterEach(cleanup);

describe("ExternalSessionImportDialog", () => {
  it("updates the target project when the webview emits an input event", async () => {
    const call = vi.fn().mockResolvedValue(scan);
    render(
      <ExternalSessionImportDialog
        client={{ call } as unknown as RpcClient}
        workspaces={workspaces}
        onClose={vi.fn()}
        onImported={vi.fn(async () => {})}
        onOpenSession={vi.fn(async () => {})}
      />,
    );

    await waitFor(() => expect(call).toHaveBeenCalledWith("externalSession.scan"));
    const select = screen.getByRole("combobox", {
      name: "目标项目",
    }) as HTMLSelectElement;
    fireEvent.input(select, { target: { value: "workspace-2" } });

    expect(select.value).toBe("workspace-2");
    const selectedOption = screen.getByRole("option", {
      name: "项目二",
    }) as HTMLOptionElement;
    expect(selectedOption.selected).toBe(true);
  });
});
