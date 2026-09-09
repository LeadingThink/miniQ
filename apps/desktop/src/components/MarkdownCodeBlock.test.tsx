// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Md } from "./Md";
afterEach(cleanup);
it("copies only complete code and keeps wrapping during content updates", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const code = "const 值 = '保留全部内容';\n";
  const view = render(<Md>{`\`\`\`js\n${code}\`\`\``}</Md>);
  fireEvent.click(screen.getByRole("button", { name: "代码自动换行" }));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "复制代码" })),
  );
  expect(writeText).toHaveBeenCalledWith(code);
  view.rerender(<Md>{`\`\`\`js\n${code}console.log(值);\n\`\`\``}</Md>);
  expect(
    screen
      .getByRole("button", { name: "代码自动换行" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});
it("keeps an unchanged Markdown subtree mounted and routes file links to the latest callback", () => {
  const first = vi.fn();
  const second = vi.fn();
  const content = "[report](report.md)\n\n```js\nconsole.log(1)\n```";
  const view = render(
    <Md workspacePath="/project" onOpenFile={first}>
      {content}
    </Md>,
  );
  const link = screen.getByRole("link", { name: "report" });
  const code = view.container.querySelector("pre");
  view.rerender(
    <Md workspacePath="/project" onOpenFile={second}>
      {content}
    </Md>,
  );
  expect(screen.getByRole("link", { name: "report" })).toBe(link);
  expect(view.container.querySelector("pre")).toBe(code);
  fireEvent.click(link);
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith({
    path: "/project/report.md",
    line: null,
    column: null,
  });
});
