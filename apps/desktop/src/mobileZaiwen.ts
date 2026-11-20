import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface MobileZaiwenState { loading: boolean; canGoBack: boolean; error: string | null }
export type MobileZaiwenLayout = { visible: false } | {
  visible: true; x: number; y: number; width: number; height: number; viewportWidth: number;
};
interface MiniqZaiwenPlugin {
  update(layout: MobileZaiwenLayout): Promise<MobileZaiwenState>;
  getState(): Promise<MobileZaiwenState>;
  reload(): Promise<MobileZaiwenState>;
  goBack(): Promise<{ navigated: boolean }>;
  addListener(event: "platformMenuRequested", listener: () => void): Promise<PluginListenerHandle>;
}
const plugin = registerPlugin<MiniqZaiwenPlugin>("MiniqZaiwen");

export function mobileZaiwenCapabilities() {
  const supported = Capacitor.isNativePlatform() && ["ios", "android"].includes(Capacitor.getPlatform())
    && Capacitor.isPluginAvailable("MiniqZaiwen");
  return { embeddedView: supported, persistentSession: supported, navigation: supported,
    domAutomation: false, screenshot: false, syntheticInput: false, ssoKeySelection: false };
}

// Native calls finish on the UI thread. Serialize updates so a late open cannot
// overtake a hide requested while switching platforms or disposing the shell.
let pending: Promise<unknown> = Promise.resolve();
function command<T>(action: () => Promise<T>): Promise<T> {
  if (!mobileZaiwenCapabilities().embeddedView) return Promise.reject(new Error("请使用包含在问切换功能的原生手机版。"));
  const result = pending.then(action);
  pending = result.catch(() => {});
  return result;
}
export const updateMobileZaiwen = (layout: MobileZaiwenLayout) => command(() => plugin.update(layout));
export const readMobileZaiwenState = () => command(() => plugin.getState());
export const reloadMobileZaiwen = () => command(() => plugin.reload());
export const goBackMobileZaiwen = () => command(() => plugin.goBack());
export const listenMobilePlatformMenu = (listener: () => void) => plugin.addListener("platformMenuRequested", listener);
