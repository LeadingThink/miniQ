export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    // Let the browser begin consuming the object URL before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
