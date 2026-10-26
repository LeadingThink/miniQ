import { HttpsProxyAgent } from "https-proxy-agent";
import type { ProxyOptions } from "vite";
import { DEV_MODEL_API_PREFIX, PRODUCTION_API_BASE_URL } from "./src/mobileApiEndpoints";

/** Vite pipes responses directly so chat remains streaming during USB development. */
export function mobileModelProxy(env: Record<string, string>): Record<string, ProxyOptions> {
  const networkProxy = env.HTTPS_PROXY || env.HTTP_PROXY;
  return {
    [DEV_MODEL_API_PREFIX]: {
      target: (env.VITE_MINIQ_API_BASE_URL || PRODUCTION_API_BASE_URL).replace(/\/+$/, ""),
      changeOrigin: true,
      ...(networkProxy ? { agent: new HttpsProxyAgent(networkProxy) } : {}),
      rewrite: (path) => path.replace(new RegExp(`^${DEV_MODEL_API_PREFIX}`), ""),
      bypass: (request) => {
        delete request.headers.origin;
      },
    },
  };
}
