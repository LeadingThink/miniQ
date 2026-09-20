import {
  createContext,
  Fragment,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "./errorMessage";

interface DesktopHost {
  host: string | null;
  pending: boolean;
  error: string | null;
  selectHost: (host: string | null) => Promise<void>;
}

const Context = createContext<DesktopHost | null>(null);

/** A host switch replaces the entire task UI, so no session, draft or pending
 * request from one computer can accidentally be reused on another computer. */
export function DesktopHostProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switching = useRef(false);

  async function selectHost(next: string | null) {
    if (switching.current || next === host) return;
    switching.current = true;
    setPending(true);
    setError(null);
    try {
      // Validate before replacing the current workspace. Failed authentication
      // keeps the current host and all unsent input visible.
      if (next) await invoke("ssh_connect", { host: next });
      else await invoke("ssh_disconnect");
      setHost(next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      switching.current = false;
      setPending(false);
    }
  }

  return (
    <Context.Provider value={{ host, pending, error, selectHost }}>
      <Fragment key={host === null ? "local" : `ssh:${host}`}>
        {children}
      </Fragment>
    </Context.Provider>
  );
}

export const useDesktopHost = () => useContext(Context);

export function hostDraftKey(host: string | null | undefined, key: string) {
  return host ? `ssh:${encodeURIComponent(host)}:${key}` : key;
}
