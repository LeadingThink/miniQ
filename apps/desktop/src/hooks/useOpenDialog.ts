import { useEffect, useState } from "react";

export function useOpenDialog() {
  const [open, setOpen] = useState(
    () =>
      typeof document !== "undefined" &&
      Boolean(document.querySelector("dialog[open]")),
  );
  useEffect(() => {
    const read = () => setOpen(Boolean(document.querySelector("dialog[open]")));
    const observer = new MutationObserver(read);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    read();
    return () => observer.disconnect();
  }, []);
  return open;
}
