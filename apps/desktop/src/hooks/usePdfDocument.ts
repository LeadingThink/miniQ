import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { loadPdfRuntime } from "../pdfRuntime";
import { decodeBase64 } from "../previewBinary";

export function usePdfDocument(
  dataBase64: string,
  onError: (message: string) => void,
) {
  const report = useRef(onError);
  report.current = onError;
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [password, setPassword] = useState<{
    incorrect: boolean;
    submit: (value: string) => void;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    setPdf(null);
    setFailed(false);
    setPassword(null);
    void loadPdfRuntime()
      .then(async (pdfjs) => {
        if (cancelled) return;
        const resources = new URL(
          `${import.meta.env.BASE_URL}pdfjs/`,
          document.baseURI,
        );
        task = pdfjs.getDocument({
          data: new Uint8Array(decodeBase64(dataBase64)),
          cMapUrl: new URL("cmaps/", resources).href,
          cMapPacked: true,
          standardFontDataUrl: new URL("standard_fonts/", resources).href,
          wasmUrl: new URL("wasm/", resources).href,
          isEvalSupported: false,
        });
        task.onPassword = (update: (value: string) => void, reason: number) => {
          if (!cancelled)
            setPassword({
              incorrect: reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD,
              submit: (value) => {
                setPassword(null);
                update(value);
              },
            });
        };
        const result = await task.promise;
        if (!cancelled) setPdf(result);
      })
      .catch((error) => {
        if (!cancelled) {
          setFailed(true);
          setPassword(null);
          report.current(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      cancelled = true;
      void task?.destroy().catch(() => {});
    };
  }, [dataBase64]);
  return { pdf, password, failed };
}
