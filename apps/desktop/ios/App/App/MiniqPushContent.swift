import CryptoKit
import Foundation
import Security
import UserNotifications

/// Shared by the app (MiniqPush plugin) and the Notification Service
/// Extension. The relay only ever sees the encrypted payload; this file owns
/// the key storage and turns a decrypted payload into notification text.
enum MiniqPushKeyStore {
    /// App Group used as the shared keychain access group (iOS allows app
    /// group identifiers as `kSecAttrAccessGroup`).
    static let accessGroup = "group.com.leadingthink.miniq"
    private static let service = "com.leadingthink.miniq.push"
    private static let account = "relay-encryption-key"

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
    }

    /// Stores the base64url AES-256 key. Readable after first unlock so the
    /// extension can decrypt while the phone is locked.
    @discardableResult
    static func save(_ key: String) -> Bool {
        guard let data = key.data(using: .utf8) else { return false }
        SecItemDelete(baseQuery as CFDictionary)
        var query = baseQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    static func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    static func load() -> SymmetricKey? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let text = String(data: data, encoding: .utf8),
              let raw = MiniqPushCrypto.base64URLDecode(text),
              raw.count == 32 else { return nil }
        return SymmetricKey(data: raw)
    }
}

enum MiniqPushCrypto {
    static func base64URLDecode(_ text: String) -> Data? {
        var value = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = value.count % 4
        if remainder > 0 { value += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: value)
    }

    /// AES-256-GCM, 12-byte nonce, ciphertext with the 16-byte tag appended
    /// (the layout produced by the daemon's `aes-gcm` crate).
    static func decrypt(nonce: String, ciphertext: String, key: SymmetricKey) -> [String: Any]? {
        guard let nonceData = base64URLDecode(nonce), nonceData.count == 12,
              let sealed = base64URLDecode(ciphertext), sealed.count > 16,
              let gcmNonce = try? AES.GCM.Nonce(data: nonceData),
              let box = try? AES.GCM.SealedBox(nonce: gcmNonce, ciphertext: sealed.dropLast(16), tag: sealed.suffix(16)),
              let plain = try? AES.GCM.open(box, using: key),
              let json = try? JSONSerialization.jsonObject(with: plain) as? [String: Any] else { return nil }
        return json
    }
}

struct MiniqPushText {
    let title: String
    let body: String
    let sessionId: String
    let approvalId: String?

    /// Mirrors `copy()` in apps/desktop/src/taskNotifications.ts.
    init?(payload: [String: Any]) {
        guard let sessionId = payload["sessionId"] as? String, !sessionId.isEmpty else { return nil }
        let kind = payload["kind"] as? String ?? ""
        let rawName = (payload["title"] as? String) ?? ""
        let name = rawName.isEmpty ? "当前会话" : rawName
        self.sessionId = sessionId
        self.approvalId = (payload["approvalId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        switch kind {
        case "attention":
            title = "miniQ · 需要你操作"
            if approvalId != nil {
                let tool = (payload["toolName"] as? String) ?? ""
                let reason = (payload["reason"] as? String) ?? ""
                var text = tool.isEmpty ? "「\(name)」请求执行操作，等待你批准。" : "「\(name)」请求使用 \(tool)，等待你批准。"
                if !reason.isEmpty { text += "\n\(reason)" }
                body = text
            } else {
                body = "「\(name)」正在等待你的回答，请返回 miniQ 处理。"
            }
        case "completed":
            title = "miniQ · 任务完成"
            body = "「\(name)」已完成，请返回 miniQ 查看结果。"
        case "failed":
            title = "miniQ · 任务未完成"
            let error = (payload["error"] as? String) ?? ""
            body = error.isEmpty
                ? "「\(name)」执行未完成，请返回 miniQ 查看详情并继续任务。"
                : "「\(name)」执行未完成：\(error)"
        default:
            return nil
        }
    }
}

enum MiniqNotificationCategories {
    static let attention = "MINIQ_ATTENTION"

    /// Same identifiers as apps/desktop/src/notificationActions.ts. Both
    /// actions open the app and require unlocking the device.
    static func register() {
        let approve = UNNotificationAction(identifier: "approve", title: "批准", options: [.foreground, .authenticationRequired])
        let reject = UNNotificationAction(identifier: "reject", title: "拒绝", options: [.foreground, .destructive, .authenticationRequired])
        let category = UNNotificationCategory(identifier: attention, actions: [approve, reject], intentIdentifiers: [], options: [])
        let center = UNUserNotificationCenter.current()
        center.getNotificationCategories { existing in
            var categories = existing.filter { $0.identifier != attention }
            categories.insert(category)
            center.setNotificationCategories(categories)
        }
    }
}


/// Icon badge = number of sessions with an alert the user has not seen yet.
/// Shared through the App Group so the Notification Service Extension (remote
/// pushes) and the app (local notifications) count the same sessions; the app
/// resets it when it comes to the foreground.
enum MiniqBadgeStore {
    private static let key = "miniq.badge.sessions"
    private static let limit = 99

    private static var defaults: UserDefaults? { UserDefaults(suiteName: MiniqPushKeyStore.accessGroup) }

    static var count: Int { defaults?.stringArray(forKey: key)?.count ?? 0 }

    /// Records an unseen alert for `session` and returns the new badge count.
    @discardableResult
    static func mark(_ session: String) -> Int {
        guard let defaults else { return 0 }
        var sessions = defaults.stringArray(forKey: key) ?? []
        if !sessions.contains(session) {
            sessions.append(session)
            if sessions.count > limit { sessions.removeFirst(sessions.count - limit) }
            defaults.set(sessions, forKey: key)
        }
        return sessions.count
    }

    static func clear() {
        defaults?.removeObject(forKey: key)
    }
}
