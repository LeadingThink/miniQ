import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RpcClient } from "../rpc";
import { VoiceInput } from "./VoiceInput";

describe("VoiceInput", () => {
  it("renders an accessible voice input control", () => {
    const html = renderToStaticMarkup(
      <VoiceInput
        client={{} as RpcClient}
        onStart={() => undefined}
        onTranscribed={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="语音输入"');
    expect(html).toContain("lucide-mic");
  });
});
