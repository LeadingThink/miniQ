// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
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
