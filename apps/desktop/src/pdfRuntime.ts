let runtime:
  | Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>
  | undefined;

export function loadPdfRuntime() {
  runtime ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ])
    .then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })
    .catch((error) => {
      runtime = undefined;
      throw error;
    });
  return runtime;
}
