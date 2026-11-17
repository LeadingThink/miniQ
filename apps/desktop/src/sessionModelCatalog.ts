import type { ApiProtocol, ModelDescription } from "./modelSelection";
import type { ModelPerformanceResult } from "./modelPerformance";

/** Model picker data supplied by the current conversation's backend. */
export interface SessionModelCatalog {
  list: () => Promise<{ models: string[] }>;
  describe: (model: string, protocol: ApiProtocol) => Promise<ModelDescription>;
  performance?: () => Promise<ModelPerformanceResult>;
  defaultModel: string;
}
