export type ComputerPermissionState = "granted" | "denied" | "notRequired" | "unsupported" | "unknown";
export type ComputerPermission = "screenRecording" | "accessibility";
export interface ComputerPermissions {
  platform: string;
  processId: number;
  executable: string;
  screenRecording: ComputerPermissionState;
  accessibility: ComputerPermissionState;
  displayServer: string | null;
}

export const permissionLabels: Record<ComputerPermissionState, string> = {
  granted: "已授权",
  denied: "未授权",
  notRequired: "无需单独授权",
  unsupported: "当前环境不支持",
  unknown: "需实际检查",
};

export function permissionReady(state: ComputerPermissionState) {
  return state === "granted" || state === "notRequired";
}
