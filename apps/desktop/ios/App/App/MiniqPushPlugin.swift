import Capacitor
import Foundation
import UIKit
import UserNotifications

/// iOS side of `registerPlugin("MiniqPush")` (apps/desktop/src/remotePush.ts).
///
/// iOS receives pushes through @capacitor/push-notifications; this plugin only
/// shares the relay decryption key with the Notification Service Extension.
/// `getToken` and `notificationOpened` are Android (JPush) features.
@objc(MiniqPushPlugin)
public class MiniqPushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MiniqPushPlugin"
    public let jsName = "MiniqPush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "markBadge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearBadge", returnType: CAPPluginReturnPromise),
    ]

    public override func load() {
        MiniqNotificationCategories.register()
    }

    @objc func setKey(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), MiniqPushCrypto.base64URLDecode(key)?.count == 32 else {
            call.reject("invalid key")
            return
        }
        if MiniqPushKeyStore.save(key) {
            call.resolve()
        } else {
            // Usually a missing App Group / keychain entitlement: pushes still
            // arrive, but only with the generic fallback text.
            call.reject("keychain unavailable")
        }
    }

    @objc func clearKey(_ call: CAPPluginCall) {
        MiniqPushKeyStore.clear()
        call.resolve()
    }

    @objc func getToken(_ call: CAPPluginCall) {
        call.unavailable("iOS registers through @capacitor/push-notifications")
    }

    /// Local notification posted for `session`: count it on the icon badge.
    @objc func markBadge(_ call: CAPPluginCall) {
        guard let session = call.getString("session"), !session.isEmpty else {
            call.reject("missing session")
            return
        }
        let count = MiniqBadgeStore.mark(session)
        Self.applyBadge(count)
        call.resolve(["count": count])
    }

    /// The user is looking at miniQ: everything counted so far has been seen.
    @objc func clearBadge(_ call: CAPPluginCall) {
        MiniqBadgeStore.clear()
        Self.applyBadge(0)
        call.resolve(["count": 0])
    }

    private static func applyBadge(_ count: Int) {
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
        } else {
            DispatchQueue.main.async { UIApplication.shared.applicationIconBadgeNumber = count }
        }
    }
}
