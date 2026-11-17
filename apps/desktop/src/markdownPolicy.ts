import { createContext } from "react";

/** API-backed conversations have no access to the local workspace. */
export const MarkdownLocalFilesContext = createContext(true);

export function webMarkdownUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.startsWith("#")) return value;
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Relative paths and opaque asset keys are not web URLs. */ }
  return "";
}
