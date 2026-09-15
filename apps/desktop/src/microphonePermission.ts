import { Capacitor } from "@capacitor/core";
import { isTauriRuntime } from "./runtime";

export function isMicrophonePermissionError(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError");
}

export function microphonePermissionGuidance(): { canOpenSettings: boolean; steps: string[] } {
  const userAgent = navigator.userAgent;
  if (isTauriRuntime()) {
    if (/Macintosh|Mac OS X/.test(userAgent)) return {
      canOpenSettings: true,
      steps: ["在“系统设置 → 隐私与安全性 → 麦克风”中，开启 miniQ 的权限。", "返回 miniQ，点击“已开启，重试”。如果系统提示需要退出应用，请先保存工作，再退出并重新打开 miniQ。"],
    };
    if (/Windows/.test(userAgent)) return {
      canOpenSettings: true,
      steps: ["在“设置 → 隐私和安全性（或隐私）→ 麦克风”中，开启“麦克风访问”和“允许桌面应用访问麦克风”。", "返回 miniQ，点击“已开启，重试”。"],
    };
    return {
      canOpenSettings: false,
      steps: ["请在系统的隐私或声音设置中允许 miniQ 访问麦克风。", "返回 miniQ，点击“已开启，重试”。"],
    };
  }
  if (Capacitor.isNativePlatform()) return {
    canOpenSettings: false,
    steps: [Capacitor.getPlatform() === "ios"
      ? "打开“设置 → 隐私与安全性 → 麦克风”，允许 miniQ 使用麦克风。"
      : "打开“设置 → 应用 → miniQ → 权限 → 麦克风”，选择允许。",
    "返回 miniQ，点击“已开启，重试”。"],
  };
  return {
    canOpenSettings: false,
    steps: ["打开当前浏览器的网站设置，将此网站的“麦克风”权限改为“允许”。", "如果仍被拒绝，请在系统的麦克风权限设置中允许当前浏览器使用麦克风。", "返回此页面，点击“已开启，重试”。录音使用的是当前设备的麦克风，无需修改远端电脑的权限。"],
  };
}

export async function openMicrophoneSettings(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_microphone_settings");
}
