import { invoke } from "@tauri-apps/api/core";
import { throwIfAborted } from "./abortSignal";
import { stageUploadInputs, validateUploadSize, type UploadFileInput } from "./remoteUploadSource";

interface DesktopUploadFile { name: string; size: number; modified: string }

/** Native drops carry local paths. Read them only on this device, in chunks. */
export async function stageDesktopUploadSources(paths: readonly string[], signal?: AbortSignal) {
  const inputs: UploadFileInput[] = [];
  for (const path of paths) {
    throwIfAborted(signal);
    const file = await invoke<DesktopUploadFile>("local_upload_file_info", { path });
    validateUploadSize(file.size);
    inputs.push({
      name: file.name, size: file.size,
      readChunk: (start, end) => invoke<ArrayBuffer>("read_local_upload_chunk", {
        path, offset: start, length: end - start, expectedSize: file.size, expectedModified: file.modified,
      }),
    });
  }
  return stageUploadInputs(inputs, signal);
}
