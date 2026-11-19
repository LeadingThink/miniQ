import { useEffect, useState } from "react";

const MODAL_SELECTOR = 'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';

export function useOpenDialog() {
  const [open, setOpen] = useState(
    () =>
      typeof document !== "undefined" &&
      Boolean(document.querySelector(MODAL_SELECTOR)),
  );
  useEffect(() => {
    const read = () => setOpen(Boolean(document.querySelector(MODAL_SELECTOR)));
    const observer = new MutationObserver(read);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "role", "aria-modal"],
    });
    read();
    return () => observer.disconnect();
  }, []);
  return open;
}
