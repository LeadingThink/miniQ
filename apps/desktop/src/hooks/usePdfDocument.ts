import type { RemotePreviewSource } from "../remoteTransfer";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { loadPdfRuntime } from "../pdfRuntime";
import { decodeBase64 } from "../previewBinary";

export function usePdfDocument(
  dataBase64: string | Blob,
  onError: (message: string) => void,
  remoteSource?: RemotePreviewSource,
) {
  const report = useRef(onError);
  report.current = onError;
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [password, setPassword] = useState<{
    incorrect: boolean;
    submit: (value: string) => void;
  } | null>(null);
  const [renewal, setRenewal] = useState<{ original: RemotePreviewSource; source: RemotePreviewSource }>();
  const activeSource = renewal?.original === remoteSource ? renewal?.source : remoteSource;
  const renewRef = useRef<() => Promise<boolean>>(async () => false);
  const renew = useCallback(() => renewRef.current(), []);
  const renewed = useRef(false);
  useEffect(() => { renewed.current = false; }, [remoteSource]);
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    setPdf(null);
    setFailed(false);
    setPassword(null);
    let refreshing: Promise<boolean> | undefined;
    renewRef.current = () => {
      if (refreshing) return refreshing;
      if (cancelled || !remoteSource || !activeSource || renewed.current) return Promise.resolve(false);
      renewed.current = true;
      refreshing = activeSource.refresh().then(source => {
        if (!cancelled) setRenewal({ original: remoteSource, source });
        return true;
      }).catch(() => false);
      return refreshing;
    };
    if (activeSource && activeSource.expiresAt <= Date.now()) {
      void renew().then(success => {
        if (!success && !cancelled) { setFailed(true); report.current("预览链接已过期，请重新加载文件"); }
      });
      return () => { cancelled = true; };
    }
    void loadPdfRuntime()
      .then(async (pdfjs) => {
        if (cancelled) return;
        const resources = new URL(
          `${import.meta.env.BASE_URL}pdfjs/`,
          document.baseURI,
        );
        task = pdfjs.getDocument({
          ...(activeSource ? {
            url: activeSource.getUrl,
            disableAutoFetch: true,
            disableStream: true,
            rangeChunkSize: 256 * 1024,
            withCredentials: false,
          } : { data: typeof dataBase64 === "string" ? decodeBase64(dataBase64) : new Uint8Array(await dataBase64.arrayBuffer()) }),
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
      .catch(async (error) => {
        if (cancelled || await renew()) return;
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
  }, [dataBase64, activeSource, remoteSource, renew]);
  return { pdf, password, failed, renew };
}
