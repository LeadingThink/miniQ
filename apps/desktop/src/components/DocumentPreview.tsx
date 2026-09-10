import { FileWarning } from "lucide-react";
export { PdfPreview } from "./PdfPreview";
export { SpreadsheetPreview } from "./SpreadsheetPreview";
export { BlobPreview } from "./MediaPreview";
export { DocxPreview, PptxPreview } from "./OfficePreview";

export function UnsupportedPreview({ remote = false }: { remote?: boolean }) {
  return (
    <div className="unsupported-preview">
      <FileWarning size={32} />
      <strong>暂不支持内嵌预览此格式</strong>
      <span>{remote ? "可下载到当前设备查看，或让 AI 转换为 PDF 等预览格式。" : "可以使用右上角按钮在系统默认应用中打开。"}</span>
    </div>
  );
}
