import Foundation

enum MiniqZaiwenPolicy {
    static let home = URL(string: "https://chat.zaiwenai.com/")!

    static func requestsMenu(_ target: URL?, source: URL?, mainFrame: Bool) -> Bool {
        return mainFrame && target?.absoluteString == "miniq-platform://menu"
            && allows(source) && source?.host?.lowercased() == "chat.zaiwenai.com"
    }

    static func allows(_ url: URL?) -> Bool {
        guard let url, url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil,
              url.port == nil || url.port == 443 else { return false }
        return true
    }
}
