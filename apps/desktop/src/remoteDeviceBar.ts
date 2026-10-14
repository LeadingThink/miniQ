import { createContext } from "react";
import type { RemoteDesktop } from "./remoteDevices";

/** Selected computer provided by RemoteWorkbench. On wide screens its device
 * bar already names the computer; on phones that bar is hidden and the
 * session header shows the name and offers these actions instead. */
export interface RemoteDeviceBar {
  name: string;
  /** null while the device directory is loading or failed. */
  online: boolean | null;
  devices: RemoteDesktop[];
  selected: RemoteDesktop | null;
  loading: boolean;
  error: string | null;
  onSelect: (device: RemoteDesktop) => void;
  onRefresh: () => void;
  onSwitch: () => void;
  onSwitchMode?: () => void;
  onAppearance?: () => void;
}

export const RemoteDeviceBarContext = createContext<RemoteDeviceBar | null>(null);
