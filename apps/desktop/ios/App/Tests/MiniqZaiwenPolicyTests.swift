import Foundation

@main
struct MiniqZaiwenPolicyTests {
    static func main() {
        for value in ["https://chat.zaiwenai.com/", "https://accounts.example.com/oauth?next=chat",
                      "https://chat.zaiwenai.com:443/chat"] {
            precondition(MiniqZaiwenPolicy.allows(URL(string: value)), "HTTPS navigation must work")
        }
        for value in ["", "http://chat.zaiwenai.com/", "file:///private/key", "content://files/private",
                      "capacitor://localhost", "javascript:alert(1)", "intent://open",
                      "https://user:password@chat.zaiwenai.com/", "https://chat.zaiwenai.com:8443/", "https:///chat"] {
            precondition(!MiniqZaiwenPolicy.allows(URL(string: value)), "Unsafe navigation must be blocked")
        }
        precondition(!MiniqZaiwenPolicy.allows(nil))
        let menu = URL(string: "miniq-platform://menu")!
        precondition(MiniqZaiwenPolicy.requestsMenu(menu, source: MiniqZaiwenPolicy.home, mainFrame: true))
        for source in ["https://example.com/", "http://chat.zaiwenai.com/", "https://chat.zaiwenai.com.evil.test/",
                       "https://user@chat.zaiwenai.com/", "https://chat.zaiwenai.com:8443/"] {
            precondition(!MiniqZaiwenPolicy.requestsMenu(menu, source: URL(string: source), mainFrame: true))
        }
        precondition(!MiniqZaiwenPolicy.requestsMenu(menu, source: MiniqZaiwenPolicy.home, mainFrame: false))
        precondition(!MiniqZaiwenPolicy.requestsMenu(URL(string: "miniq-platform://menu?command=key"), source: MiniqZaiwenPolicy.home, mainFrame: true))
        precondition(!MiniqZaiwenPolicy.requestsMenu(menu, source: nil, mainFrame: true))
        print("14 iOS navigation policy cases passed")
        print("9 iOS platform menu policy cases passed")
    }
}
