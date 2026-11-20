import Capacitor
import UIKit
import WebKit

/// Remote pages run in a separate WKWebView with no Capacitor message handlers.
@objc(MiniqZaiwenPlugin)
public class MiniqZaiwenPlugin: CAPPlugin, CAPBridgedPlugin, WKNavigationDelegate, WKUIDelegate {
    public let identifier = "MiniqZaiwenPlugin"
    public let jsName = "MiniqZaiwen"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "goBack", returnType: CAPPluginReturnPromise)
    ]
    private var site: WKWebView?
    private var visible = false
    private var loading = false
    private var failure: String?
    private var loadTimeout: DispatchWorkItem?

    private func started() {
        failure = nil; loading = true; applyVisibility()
        loadTimeout?.cancel()
        let timeout = DispatchWorkItem { [weak self] in
            self?.failed()
            self?.site?.stopLoading()
        }
        loadTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
    }

    deinit {
        loadTimeout?.cancel()
        let view = site
        DispatchQueue.main.async { view?.stopLoading(); view?.removeFromSuperview() }
    }

    private func snapshot() -> PluginCallResultData {
        return ["loading": loading, "canGoBack": site?.canGoBack ?? false,
                "error": failure.map { $0 as Any } ?? NSNull()]
    }

    private func applyVisibility() {
        site?.isHidden = !visible || loading || failure != nil
    }

    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard call.getBool("visible") == true else {
                self.visible = false
                self.site?.endEditing(true)
                self.applyVisibility()
                call.resolve(self.snapshot())
                return
            }
            guard let primary = self.bridge?.webView, let parent = primary.superview,
                  let x = call.getDouble("x"), let y = call.getDouble("y"),
                  let width = call.getDouble("width"), let height = call.getDouble("height"),
                  let viewport = call.getDouble("viewportWidth"),
                  [x, y, width, height, viewport].allSatisfy({ $0.isFinite }),
                  x >= 0, y >= 0, width > 0, height > 0, viewport > 0 else {
                call.reject("在问页面区域无效。")
                return
            }
            let scale = primary.bounds.width / CGFloat(viewport)
            let frame = CGRect(x: CGFloat(x) * scale, y: CGFloat(y) * scale,
                               width: CGFloat(width) * scale, height: CGFloat(height) * scale)
                .intersection(primary.bounds)
            guard !frame.isNull, !frame.isEmpty else {
                call.reject("在问页面区域无效。")
                return
            }
            if self.site == nil {
                guard let scriptURL = Bundle.main.url(forResource: "zaiwen_site", withExtension: "js", subdirectory: "public"),
                      let script = try? String(contentsOf: scriptURL, encoding: .utf8),
                      let mobileURL = Bundle.main.url(forResource: "zaiwen_mobile", withExtension: "js", subdirectory: "public"),
                      let mobileScript = try? String(contentsOf: mobileURL, encoding: .utf8) else {
                    call.reject("主站资源未就绪，请重新构建手机版。")
                    return
                }
                let config = WKWebViewConfiguration()
                config.websiteDataStore = .default()
                config.userContentController = WKUserContentController()
                config.userContentController.addUserScript(WKUserScript(source: "window.__MINIQ_MOBILE_SITE__ = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
                config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
                config.userContentController.addUserScript(WKUserScript(source: mobileScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
                let view = WKWebView(frame: .zero, configuration: config)
                view.navigationDelegate = self
                view.uiDelegate = self
                view.allowsBackForwardNavigationGestures = true
                view.scrollView.contentInsetAdjustmentBehavior = .never
                self.site = view
                parent.addSubview(view)
                self.started()
                view.load(URLRequest(url: MiniqZaiwenPolicy.home))
            }
            self.site?.frame = primary.convert(frame, to: parent)
            self.visible = true
            self.applyVisibility()
            call.resolve(self.snapshot())
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(self.snapshot()) }
    }

    @objc func reload(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let site = self.site else { call.reject("在问页面尚未打开。"); return }
            self.started()
            // Recover from failed initial navigation, which may leave the URL unset.
            if let url = site.url, MiniqZaiwenPolicy.allows(url) { site.reload() }
            else { site.load(URLRequest(url: MiniqZaiwenPolicy.home)) }
            call.resolve(self.snapshot())
        }
    }

    @objc func goBack(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let navigated = self.site?.canGoBack == true
            if navigated { self.failure = nil; self.site?.goBack() }
            call.resolve(["navigated": navigated])
        }
    }

    public func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if MiniqZaiwenPolicy.requestsMenu(action.request.url, source: action.sourceFrame.request.url,
                                        mainFrame: action.sourceFrame.isMainFrame && action.targetFrame?.isMainFrame == true) {
            visible = false; applyVisibility()
            notifyListeners("platformMenuRequested", data: [:])
            decisionHandler(.cancel)
            return
        }
        decisionHandler(MiniqZaiwenPolicy.allows(action.request.url) ? .allow : .cancel)
    }

    public func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
            failed()
            decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }

    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                        for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if MiniqZaiwenPolicy.allows(action.request.url) { webView.load(action.request) }
        return nil
    }

    public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        started()
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadTimeout?.cancel()
        loading = false; applyVisibility()
    }

    private func failed() {
        loadTimeout?.cancel()
        loading = false; failure = "无法连接在问主站，请检查网络后重试。"; applyVisibility()
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { failed() }
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { failed() }
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failed() }
}
