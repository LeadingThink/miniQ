import { createContext } from "react";

/** True while the app renders under RemoteWorkbench's device bar, which
 * already names the selected computer. */
export const RemoteDeviceBarContext = createContext(false);
