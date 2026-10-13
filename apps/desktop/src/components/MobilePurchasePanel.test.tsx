// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ catalog: vi.fn(), context: vi.fn(), purchase: vi.fn(), retry: vi.fn() }));
vi.mock("../iosIap", async (original) => ({ ...(await original<typeof import("../iosIap")>()),
  loadIosIapCatalog: mocks.catalog, purchaseIosCredits: mocks.purchase, retryIosTransactions: mocks.retry,
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
  await screen.findByRole("alert");
  expect(screen.queryByLabelText("Apple 商品信息")).toBeNull();
  expect(screen.queryByRole("button", { name: /5 元额度/ })).toBeNull();
});
