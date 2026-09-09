import { parseDelimited } from "./delimitedPreview";

self.onmessage = (
  event: MessageEvent<{ content: string; delimiter: "," | "\t" }>,
) => {
  try {
    self.postMessage({
      rows: parseDelimited(event.data.content, event.data.delimiter),
    });
  } catch (cause) {
    self.postMessage({
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
};
