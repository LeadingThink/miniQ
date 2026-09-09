import { useEffect, useRef, useState } from "react";
import { SpreadsheetDataView } from "./SpreadsheetPreview";
import CsvWorker from "../delimitedPreview.worker?worker";

export function DelimitedPreview(props: {
  content: string;
  path: string;
  onError: (message: string) => void;
}) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [failed, setFailed] = useState(false);
  const report = useRef(props.onError);
  report.current = props.onError;
  useEffect(() => {
    let cancelled = false;
    let worker: Worker;
    setRows(null);
    setFailed(false);
    try {
      worker = new CsvWorker();
    } catch (cause) {
      setFailed(true);
      report.current(String(cause));
      return;
    }
    worker.onmessage = (
      event: MessageEvent<{ rows?: string[][]; error?: string }>,
    ) => {
      if (cancelled) return;
      if (event.data.error) {
        setFailed(true);
        report.current(event.data.error);
      } else setRows(event.data.rows ?? []);
      worker.terminate();
    };
    worker.onerror = () => {
      if (cancelled) return;
      setFailed(true);
      report.current("表格解析线程失败");
      worker.terminate();
    };
    try {
      worker.postMessage({
        content: props.content,
        delimiter: /\.tsv$/i.test(props.path) ? "\t" : ",",
      });
    } catch (cause) {
      setFailed(true);
      report.current(String(cause));
      worker.terminate();
    }
    return () => {
      cancelled = true;
      worker.terminate();
    };
  }, [props.content, props.path]);
  return rows ? (
    <SpreadsheetDataView
      sheets={[
        { sheet: props.path.split(/[\\/]/).at(-1) ?? "Data", data: rows },
      ]}
      onError={props.onError}
    />
  ) : (
    <div className="diff-empty">
      {failed ? "表格解析失败" : "正在解析表格..."}
    </div>
  );
}
