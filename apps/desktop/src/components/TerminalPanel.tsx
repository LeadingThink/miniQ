import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import "./TerminalPanel.css";

interface TerminalRead {
  status: "running" | "completed" | "failed" | "killed";
  stdout: string;
  stdoutPage: { nextOffset: number };
}

export function TerminalPanel({
  client,
  sessionId,
}: {
  client: RpcClient;
  sessionId: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<"starting" | "running" | "ended" | "error">("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const instance = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: 13,
      theme: { background: "#111315", foreground: "#e7e4dc", cursor: "#f4b942" },
    });
    const fitAddon = new FitAddon();
    instance.loadAddon(fitAddon);
    instance.open(element);
    terminal.current = instance;
    fit.current = fitAddon;
    let terminalId: string | null = null;
    let offset = 0;
    let disposed = false;
    const abort = new AbortController();
    let pendingInput = "";
    let inputTimer: number | null = null;
    let inputQueue = Promise.resolve();

    const flushInput = () => {
      inputTimer = null;
      if (!terminalId || !pendingInput || disposed) return;
      const data = pendingInput;
      pendingInput = "";
      inputQueue = inputQueue
        .then(() => client.call("terminal.input", { sessionId, terminalId, data }))
        .then(() => undefined)
        .catch((reason) => {
          if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
        });
    };

    const sendResize = () => {
      if (!terminalId || instance.rows < 1 || instance.cols < 1) return;
      void client.call("terminal.resize", {
        sessionId,
        terminalId,
        rows: instance.rows,
        cols: instance.cols,
      }).catch(() => undefined);
    };
    const resize = new ResizeObserver(() => {
      fitAddon.fit();
      sendResize();
    });
    resize.observe(element);
    const input = instance.onData((data) => {
      if (!terminalId) return;
      pendingInput += data;
      if (inputTimer === null) inputTimer = window.setTimeout(flushInput, 8);
    });

    const run = async () => {
      try {
        fitAddon.fit();
        const created = await client.call<{ terminalId: string }>("terminal.create", {
          sessionId,
          rows: Math.max(instance.rows, 1),
          cols: Math.max(instance.cols, 1),
        }, { signal: abort.signal });
        terminalId = created.terminalId;
        if (disposed) {
          await client.call("terminal.close", { sessionId, terminalId }).catch(() => undefined);
          return;
        }
        setState("running");
        instance.focus();
        while (!disposed) {
          const result = await client.call<TerminalRead>("terminal.read", {
            sessionId,
            terminalId,
            offset,
            waitMs: 1000,
          }, { signal: abort.signal, timeoutMs: 5000 });
          if (result.stdout) instance.write(result.stdout);
          offset = result.stdoutPage.nextOffset;
          if (result.status !== "running") {
            setState("ended");
            break;
          }
        }
      } catch (reason) {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setState("error");
        }
      }
    };
    void run();
    return () => {
      disposed = true;
      abort.abort();
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      resize.disconnect();
      input.dispose();
      if (terminalId)
        void client.call("terminal.close", { sessionId, terminalId }).catch(() => undefined);
      instance.dispose();
      terminal.current = null;
      fit.current = null;
    };
  }, [client, sessionId, generation]);

  return (
    <section className="terminal-panel" aria-label="内嵌终端">
      <div className="terminal-stage" ref={host} />
      {state !== "running" && (
        <div className="terminal-status" role="status">
          <span>{state === "starting" ? "正在启动终端…" : error ?? "终端已退出"}</span>
          {state !== "starting" && (
            <button type="button" className="ghost" onClick={() => {
              setError(null);
              setState("starting");
              setGeneration((value) => value + 1);
            }}>
              <RotateCw size={14} />重新启动
            </button>
          )}
        </div>
      )}
    </section>
  );
}
