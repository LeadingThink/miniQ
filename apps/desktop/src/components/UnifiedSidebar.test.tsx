// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UnifiedSidebar } from "./UnifiedSidebar";
import { useDesktopHost } from "../desktopHost";
import { emptyCatalog, hostKey } from "../hostWorkspace";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import type { SidebarHostGroup } from "./Sidebar";

vi.mock("../desktopHost", () => ({ useDesktopHost: vi.fn() }));
vi.mock("./AppSidebar", () => ({ AppSidebar: ({ hostGroups }: { hostGroups: SidebarHostGroup[] }) => <>
  {hostGroups.map((host) => <button key={host.key} onClick={host.onRetry}>{host.label}: {host.catalogStatus} {host.catalogError}</button>)}
</> }));
afterEach(cleanup);

it("passes catalog failure state through and catches a rejected project retry for the correct host", async () => {
  const cause = new Error("retry failed");
  const refreshCatalog = vi.fn().mockRejectedValue(cause);
  const reportHostError = vi.fn();
  vi.mocked(useDesktopHost).mockReturnValue({
    catalogs: { [hostKey("ssh")]: { ...emptyCatalog("ssh", "服务器"), catalogStatus: "error", catalogError: "首次失败" } },
    root: { mode: "local" }, host: null, refreshCatalog, reportHostError,
  } as unknown as NonNullable<ReturnType<typeof useDesktopHost>>);
  const app = { catalog: {}, navigation: {}, actions: {}, client: {} } as unknown as MiniqAppController;
  render(<UnifiedSidebar app={app} />);
  fireEvent.click(screen.getByRole("button", { name: "服务器: error 首次失败" }));
  await waitFor(() => expect(reportHostError).toHaveBeenCalledWith("ssh", cause));
  expect(refreshCatalog).toHaveBeenCalledExactlyOnceWith("ssh");
});
