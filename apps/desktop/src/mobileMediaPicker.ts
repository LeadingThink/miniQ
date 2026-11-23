import { Sha256 } from "./incrementalSha256";
import { validateMobileMedia } from "./mobileChatMedia";
import { readNativeUploadChunk } from "./nativeFileTransfer";
import { decodeBase64 } from "./remoteBlob";
import { pickUploadSources, releaseUploadSources } from "./remoteUploadSource";

/** Share the original-file picker with remote uploads, without needing a desktop. */
export async function pickMobileMediaFile(): Promise<File | null> {
  const sources = await pickUploadSources("photos");
  try {
    if (!sources.length) return null;
    if (sources.length !== 1) throw new Error("移动问答每次只能附加一张照片或一个视频，请重新选择");
    const source = sources[0];
    if (source.kind !== "native") throw new Error("本机文件缓存信息无效，请重新选择");
    const { type } = validateMobileMedia({ ...source, type: "" });
    const chunks: BlobPart[] = [];
    const hash = new Sha256();
    for (let offset = 0; offset < source.size; offset += 262144) {
      const length = Math.min(262144, source.size - offset);
      const bytes = new Uint8Array(decodeBase64(await readNativeUploadChunk(source.id, offset, length)));
      if (bytes.length !== length) throw new Error("所选文件读取不完整，请重新选择");
      hash.update(bytes);
      chunks.push(bytes);
    }
    if (hash.hex() !== source.sha256) throw new Error("所选文件完整性验证失败，请重新选择");
    return new File(chunks, source.name, { type });
  } finally {
    await releaseUploadSources(sources);
  }
}
