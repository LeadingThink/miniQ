import { createContext } from "react";

/** Selected computer provided by RemoteWorkbench. On wide screens its device
 * bar already names the computer; on phones that bar is hidden and the
 * session header shows the name and offers these actions instead. */
export interface RemoteDeviceBar {
  name: string;
  /** null while the device directory is loading or failed. */
  online: boolean | null;
  onSwitch: () => void;
  onAppearance?: () => void;
}

export const RemoteDeviceBarContext = createContext<RemoteDeviceBar | null>(null);
