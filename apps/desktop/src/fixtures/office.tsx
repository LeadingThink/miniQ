import { useEffect, useState } from "react";
import { DocxPreview, PptxPreview } from "../components/OfficePreview";

const samples = {
  docx: "https://raw.githubusercontent.com/VolodymyrBaydalka/docxjs/master/tests/render-test/table/document.docx",
  pptx: "https://501351981.github.io/pptx-preview/examples/dist/test.pptx",
};

// Public upstream compatibility samples; loaded only from the development QA page.
export function OfficeFixture({ kind }: { kind: "docx" | "pptx" }) {
  const [data, setData] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const reader = new FileReader();
    setData(null);
    setError("");
    reader.onload = () => {
      if (!controller.signal.aborted)
        setData(String(reader.result).split(",", 2)[1]);
    };
    reader.onerror = () => {
      if (!controller.signal.aborted) setError("样例读取失败");
    };
    void fetch(samples[kind], { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`样例加载失败：${response.status}`);
        const blob = await response.blob();
        if (!controller.signal.aborted) reader.readAsDataURL(blob);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(String(cause));
      });
    return () => {
      controller.abort();
      if (reader.readyState === FileReader.LOADING) reader.abort();
    };
  }, [kind]);
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p role="status">正在加载上游 Office 兼容样例</p>;
  return kind === "docx" ? (
    <DocxPreview dataBase64={data} onError={setError} />
  ) : (
    <PptxPreview dataBase64={data} onError={setError} />
  );
}
