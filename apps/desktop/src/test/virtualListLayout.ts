import { afterEach, vi } from "vitest";

const scrollToDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);
afterEach(() => {
  if (scrollToDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollTo",
      scrollToDescriptor,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

/** jsdom has no layout. Give virtual lists a viewport and measured row sizes. */
export function mockVirtualListLayout() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches(".sidebar-scroll, .slash-results") ? 360 : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(264);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.closest(".slash-results") ? 76 : 36;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return Array.from(
        this.querySelectorAll<HTMLElement>(".virtual-list"),
      ).reduce(
        (sum, list) =>
          sum +
          (Number.parseFloat(list.style.height) || list.childElementCount * 36),
        0,
      );
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const root = this.closest<HTMLElement>(".sidebar-scroll, .slash-results");
      const top = this === root ? 0 : -(root?.scrollTop ?? 0);
      return {
        x: 0,
        y: top,
        top,
        bottom: top + 360,
        left: 0,
        right: 264,
        width: 264,
        height: 360,
        toJSON() {},
      };
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: function (this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? this.scrollTop;
    },
  });
}
