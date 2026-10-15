// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderKeyField } from "./ProviderKeyField";

afterEach(cleanup);

describe("ProviderKeyField", () => {
  it("masks, reveals, edits, and copies the saved key", async () => {
    const onChange = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ProviderKeyField value="sk-saved" onChange={onChange} />);
    const input = screen.getByLabelText("在问 API Key") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "显示 API Key" }));
    expect(input.type).toBe("text");
    fireEvent.change(input, { target: { value: "sk-edited" } });
    expect(onChange).toHaveBeenCalledWith("sk-edited");
    fireEvent.click(screen.getByRole("button", { name: "复制 API Key" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("sk-saved"));
  });

  it("disables key controls while loading", () => {
    render(<ProviderKeyField value="" loading onChange={() => undefined} />);
    expect(screen.getByLabelText("在问 API Key").hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "显示 API Key" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "复制 API Key" }).hasAttribute("disabled")).toBe(true);
  });
});
