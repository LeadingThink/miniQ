import {
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { fileKind, type FileKind } from "../fileTreeModel";
import "./FileKindIcon.css";

const ICONS: Record<FileKind, LucideIcon> = {
  code: FileCode2,
  web: FileCode2,
  data: FileJson,
  sheet: FileSpreadsheet,
  doc: FileText,
  pdf: FileText,
  slides: Presentation,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  archive: FileArchive,
  text: File,
};

/** Colored icon for a file name, shared by the file tree, preview header and tabs. */
export function FileKindIcon({ name, size = 15 }: { name: string; size?: number }) {
  const kind = fileKind(name);
  const Icon = ICONS[kind];
  return <Icon size={size} className={`file-kind-icon file-kind-${kind}`} aria-hidden />;
}

