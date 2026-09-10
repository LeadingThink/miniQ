// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteFileBrowser } from "./RemoteFileBrowser";
import type { FileReadOptions, RemoteDirectory } from "../remoteFiles";

afterEach(cleanup);
const entry = (name: string, directory = false) => ({
  name,
  path: `/project/${name}`,
  directory,
  size: 10,
});
const page = (
  entries: RemoteDirectory["entries"],
  nextCursor: string | null = null,
): RemoteDirectory => ({
  path: "/project",
  parent: null,
  roots: ["/project"],
  entries,
  nextCursor,
});

it("keeps earlier pages, browses folders, and opens the exact selected file", async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce(page([entry("a.md")], "a.md"))
    .mockResolvedValueOnce(page([entry("docs", true)], null))
    .mockResolvedValueOnce({
      ...page([entry("docs/报告.md")]),
      path: "/project/docs",
      parent: "/project",
    });
  const client = { mode: "remote", call } as FileReadOptions["client"];
  const onOpen = vi.fn();
  render(
    <RemoteFileBrowser access={{ client, sessionId: "one" }} onOpen={onOpen} />,
  );
  await screen.findByRole("button", { name: /a.md/ });
  fireEvent.click(screen.getByRole("button", { name: "加载更多文件" }));
  await screen.findByRole("button", { name: /docs\s*文件夹/ });
  expect(screen.getByRole("button", { name: /a.md/ })).toBeTruthy();
  expect(call.mock.calls[1][1]).toMatchObject({
    sessionId: "one",
    after: "a.md",
  });
  fireEvent.click(screen.getByRole("button", { name: /docs\s*文件夹/ }));
  fireEvent.click(await screen.findByRole("button", { name: /docs\/报告.md/ }));
  expect(call.mock.calls[2][1]).toMatchObject({ path: "/project/docs" });
  expect(onOpen).toHaveBeenCalledWith("/project/docs/报告.md");
});

it("aborts the previous session and ignores its late directory response", async () => {
  let finish!: (value: RemoteDirectory) => void;
  const call = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<RemoteDirectory>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(
      page([{ ...entry("current.md"), unavailable: true }]),
    );
  const client = { mode: "remote", call } as FileReadOptions["client"];
  const view = render(
    <RemoteFileBrowser
      access={{ client, sessionId: "one" }}
      onOpen={vi.fn()}
    />,
  );
  const signal = call.mock.calls[0][2].signal as AbortSignal;
  view.rerender(
    <RemoteFileBrowser
      access={{ client, sessionId: "two" }}
      onOpen={vi.fn()}
    />,
  );
  expect(signal.aborted).toBe(true);
  expect(
    (
      (await screen.findByRole("button", {
        name: /current.md\s*不可访问/,
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await act(async () => finish(page([entry("old.md")])));
  expect(screen.queryByRole("button", { name: /old.md/ })).toBeNull();
});
