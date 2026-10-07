import UserNotifications

/// Replaces the relay's generic fallback text with the end-to-end encrypted
/// content (session title, result, approval request). If anything fails the
/// original push is delivered unchanged, so the user is still alerted.
class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var fallback: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        fallback = content
        var badgeKey = request.identifier
        if let miniq = content.userInfo["miniq"] as? [String: Any],
           let nonce = miniq["nonce"] as? String,
           let ciphertext = miniq["ciphertext"] as? String,
           let key = MiniqPushKeyStore.load(),
           let payload = MiniqPushCrypto.decrypt(nonce: nonce, ciphertext: ciphertext, key: key),
           let text = MiniqPushText(payload: payload),
           miniq["desktopDeviceId"] == nil || (miniq["desktopDeviceId"] as? String) == text.desktopDeviceId {
            content.title = text.title
            content.body = text.body
            var info = content.userInfo
            // Read by pushTarget() in apps/desktop/src/remotePush.ts.
            info["miniqSessionId"] = text.sessionId
            info.removeValue(forKey: "miniqApprovalId")
            info.removeValue(forKey: "miniqDesktopDeviceId")
            info.removeValue(forKey: "miniqRoomId")
            if let deviceId = text.desktopDeviceId { info["miniqDesktopDeviceId"] = deviceId }
            if let roomId = text.roomId { info["miniqRoomId"] = roomId }
            if let approvalId = text.approvalId { info["miniqApprovalId"] = approvalId }
            content.userInfo = info
            content.threadIdentifier = "session:\(text.sessionKey)"
            badgeKey = text.sessionKey
            // Questions have no approval to resolve: plain tap opens the session.
            if text.approvalId == nil, content.categoryIdentifier == MiniqNotificationCategories.attention {
                content.categoryIdentifier = ""
            }
        }
        if content.userInfo["miniq"] != nil {
            // Undecryptable pushes still alert, so they count as their own entry.
            content.badge = NSNumber(value: MiniqBadgeStore.mark(badgeKey))
            fallback = content
        }
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let fallback { contentHandler(fallback) }
    }
}
