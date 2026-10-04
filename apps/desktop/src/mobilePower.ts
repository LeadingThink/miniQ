import { Capacitor, registerPlugin } from "@capacitor/core";

export interface MobilePowerState {
  lowPower: boolean;
}

interface MiniqPowerPlugin {
  getState(): Promise<MobilePowerState>;
}

const MiniqPower = registerPlugin<MiniqPowerPlugin>("MiniqPower");

/** Unknown state stays null so callers can apply their own policy. */
export async function getState(): Promise<MobilePowerState | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const state = await MiniqPower.getState();
    return typeof state?.lowPower === "boolean" ? { lowPower: state.lowPower } : null;
  } catch {
    return null;
  }
}
