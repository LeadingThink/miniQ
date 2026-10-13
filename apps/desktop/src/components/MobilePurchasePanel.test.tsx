// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ catalog: vi.fn(), context: vi.fn(), purchase: vi.fn(), retry: vi.fn(),
  observe: vi.fn(), appListener: vi.fn(), removeStorefront: vi.fn(), removeApp: vi.fn() }));
vi.mock("@capacitor/app", () => ({ App: { addListener: mocks.appListener } }));
vi.mock("../iosIap", async (original) => ({ ...(await original<typeof import("../iosIap")>()),
  loadIosIapCatalog: mocks.catalog, purchaseIosCredits: mocks.purchase, retryIosTransactions: mocks.retry,
  observeIosStorefront: mocks.observe,
}));
vi.mock("../mobileIapAccount", async (original) => ({ ...(await original<typeof import("../mobileIapAccount")>()),
  loadIapPurchaseContext: mocks.context,
}));
import { MobilePurchasePanel } from "./MobilePurchasePanel";
const product = { productId: "com.leadingthink.miniq.credits.5", displayName: "5 元额度", description: "",
  displayPrice: "$0.99", currencyCode: "USD", price: "0.99" };
const storefront = { countryCode: "CHN", countryName: "中国大陆", id: "143465" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.catalog.mockResolvedValue({ products: [product], storefront });
  mocks.context.mockResolvedValue({ accountId: "u1", appAccountToken: "token", environment: "Sandbox" });
  mocks.retry.mockResolvedValue(0);
  mocks.removeStorefront.mockResolvedValue(undefined); mocks.removeApp.mockResolvedValue(undefined);
  mocks.observe.mockResolvedValue({ remove: mocks.removeStorefront });
  mocks.appListener.mockResolvedValue({ remove: mocks.removeApp });
});
afterEach(cleanup);
function renderPanel() {
  return render(<MobilePurchasePanel disabled={false} onBusyChange={() => {}} onSettled={async () => {}} />);
}
it("shows the actual China storefront and USD price without claiming the user is abroad", async () => {
  renderPanel();
  await screen.findByText("Apple 商店地区：中国大陆（CHN），商店 ID：143465");
  expect(screen.getByText("币种不支持：Apple 返回 USD，目前仅支持人民币（CNY）。")).toBeTruthy();
  expect(screen.getByText("Apple 售价：USD 0.99；要求：CNY 5.00")).toBeTruthy();
  expect(screen.queryByText("当前地区或价格暂不支持")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("本次重新查询后仍不一致");
  const button = screen.getByRole("button", { name: /5 元额度/ });
  expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.click(button);
  expect(mocks.purchase).not.toHaveBeenCalled();
});
it("reports unavailable storefront without inferring it from CNY, and explains a price mismatch", async () => {
  mocks.catalog.mockResolvedValue({ storefront: null, products: [{ ...product, currencyCode: "CNY", price: "6", displayPrice: "¥6.00" }] });
  renderPanel();
  await screen.findByText("Apple 商店地区：Apple 暂未返回，无法确认商店地区。");
  expect(screen.getByText("售价不匹配：Apple 返回 CNY 6，此额度包要求 CNY 5.00。")).toBeTruthy();
  expect(screen.getByRole("button", { name: /5 元额度/ }).hasAttribute("disabled")).toBe(true);
});
it("reloads storefront and price, enabling a correctly priced pack", async () => {
  mocks.catalog.mockResolvedValueOnce({ products: [product], storefront: { id: "143441", countryCode: "USA", countryName: "美国" } });
  renderPanel();
  await screen.findByText("Apple 商店地区：美国（USA），商店 ID：143441");
  const reload = screen.getByRole("button", { name: "重新加载购买项目" });
  await waitFor(() => expect(reload.hasAttribute("disabled")).toBe(false));
  mocks.catalog.mockResolvedValue({ storefront, products: [{ ...product, currencyCode: "CNY", price: "5", displayPrice: "¥5.00" }] });
  fireEvent.click(reload);
  await screen.findByText("Apple 商店地区：中国大陆（CHN），商店 ID：143465");
  expect(screen.getByText("Apple 售价：CNY 5；要求：CNY 5.00")).toBeTruthy();
  expect(screen.queryByText(/币种不支持/)).toBeNull();
  const buy = screen.getByRole("button", { name: /5 元额度/ });
  await waitFor(() => expect(buy.hasAttribute("disabled")).toBe(false));
  mocks.purchase.mockResolvedValue({ status: "credited", creditedCents: 500 });
  fireEvent.click(buy);
  await screen.findByText("购买已确认，到账 ¥5.00。请在下方创建或复制 Key。");
  expect(mocks.purchase).toHaveBeenCalledWith(product.productId, expect.objectContaining({ accountId: "u1" }));
});
it("clears stale product diagnostics if reloading fails", async () => {
  renderPanel();
  await screen.findByText(/Apple 商店地区：中国大陆/);
  const reload = screen.getByRole("button", { name: "重新加载购买项目" });
  await waitFor(() => expect(reload.hasAttribute("disabled")).toBe(false));
  mocks.catalog.mockRejectedValue(new Error("无法加载 App 内购买项目"));
  fireEvent.click(reload);
  await screen.findByText("无法加载 App 内购买项目");
  expect(screen.queryByLabelText("Apple 商品信息")).toBeNull();
  expect(screen.queryByRole("button", { name: /5 元额度/ })).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const chinaCatalog = { storefront, products: [{ ...product, currencyCode: "CNY", price: "5", displayPrice: "¥5.00" }] };
it("clears prices on storefront changes and discards older responses that finish last", async () => {
  const oldRequest = deferred<typeof chinaCatalog>();
  mocks.catalog.mockReturnValueOnce(oldRequest.promise);
  renderPanel();
  await waitFor(() => expect(mocks.catalog).toHaveBeenCalledTimes(1));
  mocks.catalog.mockResolvedValue(chinaCatalog);
  await act(async () => { mocks.observe.mock.calls[0][0](); });
  await screen.findByText("Apple 售价：CNY 5；要求：CNY 5.00");
  await act(async () => { oldRequest.resolve({ storefront, products: [product] }); });
  expect(screen.getByText("Apple 售价：CNY 5；要求：CNY 5.00")).toBeTruthy();
  expect(screen.queryByText(/币种不支持/)).toBeNull();
});
it("refreshes on foreground without rerunning account settlement or keeping old prices visible", async () => {
  renderPanel();
  await screen.findByText("Apple 售价：USD 0.99；要求：CNY 5.00");
  const refreshRequest = deferred<typeof chinaCatalog>();
  mocks.catalog.mockReturnValue(refreshRequest.promise);
  await act(async () => { mocks.appListener.mock.calls[0][1]({ isActive: false }); });
  expect(mocks.catalog).toHaveBeenCalledTimes(1);
  await act(async () => { mocks.appListener.mock.calls[0][1]({ isActive: true }); });
  expect(screen.queryByText(/Apple 售价：USD/)).toBeNull();
  expect(screen.queryByRole("button", { name: /5 元额度/ })).toBeNull();
  await act(async () => { refreshRequest.resolve(chinaCatalog); });
  await screen.findByText("Apple 售价：CNY 5；要求：CNY 5.00");
  expect(mocks.context).toHaveBeenCalledTimes(1);
  expect(mocks.retry).toHaveBeenCalledTimes(1);
});
it("ignores stale request errors and removes listeners even when registration finishes after unmount", async () => {
  const oldRequest = deferred<typeof chinaCatalog>();
  const lateHandle = deferred<{ remove: typeof mocks.removeStorefront }>();
  mocks.catalog.mockReturnValueOnce(oldRequest.promise);
  mocks.observe.mockReturnValueOnce(lateHandle.promise);
  const panel = renderPanel();
  mocks.catalog.mockResolvedValue(chinaCatalog);
  await act(async () => { mocks.observe.mock.calls[0][0](); });
  await screen.findByText("Apple 售价：CNY 5；要求：CNY 5.00");
  await act(async () => { oldRequest.reject(new Error("stale failure")); });
  expect(screen.queryByRole("alert")).toBeNull();
  panel.unmount();
  await act(async () => { lateHandle.resolve({ remove: mocks.removeStorefront }); });
  expect(mocks.removeApp).toHaveBeenCalledTimes(1);
  expect(mocks.removeStorefront).toHaveBeenCalledTimes(1);
  const calls = mocks.catalog.mock.calls.length;
  await act(async () => { mocks.observe.mock.calls[0][0](); });
  expect(mocks.catalog).toHaveBeenCalledTimes(calls);
});
