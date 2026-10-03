// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_STORAGE_KEY, getActiveBackground, initializeBackground } from "../background";
import { BACKGROUNDS } from "../backgroundCatalog";
import { BackgroundPicker } from "./BackgroundPicker";
import { LivingBackground } from "./LivingBackground";

beforeEach(() => {
  localStorage.clear();
  initializeBackground();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const radios = () =>
  within(screen.getByRole("radiogroup", { name: "背景" })).getAllByRole("radio") as HTMLInputElement[];

describe("background picker", () => {
  it("defaults to the plain interface and lists every background once", () => {
    render(<BackgroundPicker />);
    const values = radios().map((radio) => radio.value);
    expect(values).toEqual(BACKGROUNDS.map((item) => item.id));
    expect(values).toHaveLength(25);
    expect((screen.getByRole("radio", { name: "纯净界面" }) as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.dataset.background).toBeUndefined();
  });

  it("persists the choice and mirrors it on the root element", () => {
    render(<BackgroundPicker />);
    fireEvent.click(screen.getByRole("radio", { name: "雨夜便利店" }));
    expect(localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBe("05-rainstore");
    expect(document.documentElement.dataset.background).toBe("05-rainstore");
    expect(document.documentElement.dataset.backgroundKind).toBe("video");
    fireEvent.click(screen.getByRole("radio", { name: "语义星云" }));
    expect(document.documentElement.dataset.backgroundTone).toBe("light");
    fireEvent.click(screen.getByRole("radio", { name: "纯净界面" }));
    expect(document.documentElement.dataset.background).toBeUndefined();
  });

  it("ignores unknown stored values", () => {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, "missing");
    initializeBackground();
    expect(getActiveBackground().id).toBe("none");
  });
});

describe("living background", () => {
  it("renders nothing by default", () => {
    const { container } = render(<LivingBackground />);
    expect(container.firstChild).toBeNull();
  });

  it("keeps the bundled cover when the video cannot be downloaded", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    localStorage.setItem(BACKGROUND_STORAGE_KEY, "01-spacecat");
    initializeBackground();
    const { container } = render(<LivingBackground />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const poster = container.querySelector("img.living-background-poster") as HTMLImageElement;
    expect(poster.getAttribute("src")).toMatch(/backgrounds\/01-spacecat\.jpg$/);
    expect(container.querySelector("video")).toBeNull();
  });
});
