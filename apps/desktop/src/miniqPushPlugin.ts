import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * Native helper shared by remote push and the icon badge (iOS:
 * ios/App/App/MiniqPushPlugin.swift, Android: push/MiniqPushPlugin.java).
 * Registered once here: Capacitor refuses a second registerPlugin call.
 */
export interface MiniqPushPlugin {
  setKey(options: { key: string }): Promise<void>;
  clearKey(): Promise<void>;
  getToken(): Promise<{ platform: "jpush"; token: string }>;
  /** Counts an unseen alert for one session; returns the new badge number. */
  markBadge(options: { session: string }): Promise<{ count: number }>;
  clearBadge(): Promise<{ count: number }>;
  addListener(
    event: "notificationOpened",
    listener: (data: Record<string, unknown>) => void,
  ): Promise<PluginListenerHandle>;
}

export const MiniqPush = registerPlugin<MiniqPushPlugin>("MiniqPush");
