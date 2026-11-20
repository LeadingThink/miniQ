import { createContext } from "react";

/** Hidden, still-mounted mobile pages must not consume the hardware back button. */
export const MobilePageActivity = createContext(true);
