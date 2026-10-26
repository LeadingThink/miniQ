import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createViteServer } from "vite";
import { expect, it } from "vitest";
import { mobileModelProxy } from "./devModelProxy";

it("forwards the configured service with exactly one version prefix", () => {
  const rule = mobileModelProxy({ VITE_MINIQ_API_BASE_URL: "https://staging.example/v1/" })["/__miniq_model_api"];
  expect(rule.target).toBe("https://staging.example/v1");
  expect(rule.rewrite?.("/__miniq_model_api/models?test=1")).toBe("/models?test=1");
  expect(mobileModelProxy({})["/__miniq_model_api"].target).toBe("https://oneapi.zaiwenai.com/v1");
});

it.each([false, true])("preserves authorization and streaming without the WebView origin (network proxy: %s)", async (useNetworkProxy) => {
  let upstreamResponse: ServerResponse | undefined;
  let request: { url?: string; authorization?: string; origin?: string; body: string } | undefined;
  const upstream = createHttpServer(async (incoming, outgoing) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    request = { url: incoming.url, authorization: incoming.headers.authorization, origin: incoming.headers.origin, body };
    upstreamResponse = outgoing;
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.write("data: first\n\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const tunnels = new Set<Socket>();
  const networkProxy = createHttpServer();
  networkProxy.on("connect", (_request, socket, head) => {
    const destination = connect(upstreamPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      destination.write(head);
      socket.pipe(destination).pipe(socket);
    });
    tunnels.add(destination);
    destination.on("close", () => tunnels.delete(destination));
    socket.on("close", () => destination.destroy());
  });
  await new Promise<void>((resolve) => networkProxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (networkProxy.address() as AddressInfo).port;
  // Keep test optimization and cleanup away from an active development server.
  const root = await mkdtemp(join(tmpdir(), "miniq-model-proxy-"));
  const vite = await createViteServer({
    root, configFile: false, logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, proxy: mobileModelProxy({
      VITE_MINIQ_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      ...(useNetworkProxy ? { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` } : {}),
    }) },
  });
  try {
    await vite.listen();
    const port = (vite.httpServer!.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/__miniq_model_api/chat/completions`, {
      method: "POST", headers: { Authorization: "Bearer test-key", Origin: "http://localhost:1420", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-model", stream: true }), signal: AbortSignal.timeout(5000),
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    expect(upstreamResponse?.writableEnded).toBe(false);
    expect(request).toEqual({ url: "/v1/chat/completions", authorization: "Bearer test-key", origin: undefined, body: '{"model":"test-model","stream":true}' });
    upstreamResponse!.end("data: [DONE]\n\n");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: [DONE]\n\n");
    expect((await reader.read()).done).toBe(true);
  } finally {
    upstreamResponse?.end();
    await vite.close();
    for (const socket of tunnels) socket.destroy();
    await new Promise<void>((resolve) => networkProxy.close(() => resolve()));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
