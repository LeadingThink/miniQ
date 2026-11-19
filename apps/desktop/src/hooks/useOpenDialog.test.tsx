// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Dialog } from "../components/ui/Dialog";
import { useOpenDialog } from "./useOpenDialog";

afterEach(cleanup);
it("suspends for dynamically opened dialogs and clears after close or removal", async () => {
  const { result } = renderHook(useOpenDialog);
  expect(result.current).toBe(false);
  const dialog = document.createElement("dialog");
  document.body.append(dialog);
  await act(async () => dialog.setAttribute("open", ""));
  await waitFor(() => expect(result.current).toBe(true));
  await act(async () => dialog.removeAttribute("open"));
  expect(result.current).toBe(false);
  await act(async () => dialog.setAttribute("open", ""));
  expect(result.current).toBe(true);
  await act(async () => dialog.remove());
  expect(result.current).toBe(false);
});

it("suspends native WebViews for portal dialogs and resumes after dismissal", async () => {
  const hook = renderHook(() => useOpenDialog());
  expect(hook.result.current).toBe(false);
  const dialog = render(<Dialog open title="导入 API Key" onClose={() => {}} />);
  await waitFor(() => expect(hook.result.current).toBe(true));
  dialog.rerender(<Dialog open={false} title="导入 API Key" onClose={() => {}} />);
  await waitFor(() => expect(hook.result.current).toBe(false));
});

it("ignores ordinary nonmodal regions and observes modal attribute changes", async () => {
  const hook = renderHook(() => useOpenDialog());
  const region = render(<div role="dialog" aria-modal="false" />);
  await waitFor(() => expect(hook.result.current).toBe(false));
  region.rerender(<div role="dialog" aria-modal="true" />);
  await waitFor(() => expect(hook.result.current).toBe(true));
  region.rerender(<div role="dialog" aria-modal="false" />);
  await waitFor(() => expect(hook.result.current).toBe(false));
});
