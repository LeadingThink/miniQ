import { Capacitor } from "@capacitor/core";
import { isIosIapAvailable } from "./iosIap";

/** Phone-number login and API Key management work on every native phone app. */
export function isMobileAccountAvailable(): boolean {
  return isIosIapAvailable() || Capacitor.getPlatform() === "android";
}
