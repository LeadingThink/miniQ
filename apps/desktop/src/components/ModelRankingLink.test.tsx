// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelRankingLink } from "./ModelRankingLink";
import { openExternalUrl } from "../externalLinks";
import { MODEL_RANKING_NOTICE, MODEL_RANKING_URL } from "../modelSelection";

vi.mock("../externalLinks", () => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("opens the ranking in the system browser without submitting or changing form state", () => {
  const submit = vi.fn();
  render(<form onSubmit={submit}><input aria-label="模型搜索" defaultValue="claude" /><ModelRankingLink /></form>);
  const link = screen.getByRole("link", { name: "查看模型热度榜" });
  expect(link.getAttribute("href")).toBe(MODEL_RANKING_URL);
  expect(link.getAttribute("title")).toBe(MODEL_RANKING_NOTICE);
  fireEvent.click(link);
  expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(MODEL_RANKING_URL);
  expect(submit).not.toHaveBeenCalled();
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("claude");
});

it("reports an opening failure and allows retry", async () => {
  vi.mocked(openExternalUrl).mockRejectedValueOnce(new Error("failed"));
  render(<ModelRankingLink />);
  fireEvent.click(screen.getByRole("link"));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("link"));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(openExternalUrl).toHaveBeenCalledTimes(2);
});
