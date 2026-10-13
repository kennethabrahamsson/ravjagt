import UIKit
import WebKit

/// Viser web-appen og forbinder den med den native GPS.
/// Web → native: window.webkit.messageHandlers.rav.postMessage({ cmd: 'ready' | 'startTrip' | 'stopTrip' })
/// Native → web: window.__ravFixes([{ lat, lon, acc, t }]), window.__ravHeading(grader)
final class WebViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private static let appURL = URL(string: "https://kennethabrahamsson.github.io/ravjagt/?native=1")!
    private static let appHost = "kennethabrahamsson.github.io"

    private var webView: WKWebView!
    private let location = LocationService()
    private var webReady = false
    private let offline = UILabel()

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.limitsNavigationsToAppBoundDomains = true
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        // Fortæl web-appen før dens egen kode kører, at den er inde i den native app
        let flag = WKUserScript(source: "window.ravNative = { version: 1 };", injectionTime: .atDocumentStart, forMainFrameOnly: true)
        config.userContentController.addUserScript(flag)
        config.userContentController.add(WeakHandler(self), name: "rav")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = UIColor(named: "Ink")
        webView.scrollView.backgroundColor = UIColor(named: "Ink")
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.allowsBackForwardNavigationGestures = false
        view = webView

        offline.text = "Ingen forbindelse første gang appen åbnes.\nTryk for at prøve igen."
        offline.numberOfLines = 0
        offline.textAlignment = .center
        offline.textColor = UIColor(white: 0.75, alpha: 1)
        offline.font = .preferredFont(forTextStyle: .body)
        offline.isHidden = true
        offline.isUserInteractionEnabled = true
        offline.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(reload)))
        offline.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(offline)
        NSLayoutConstraint.activate([
            offline.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            offline.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            offline.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48),
        ])
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        location.deliver = { [weak self] fixes in self?.send(fixes) }
        location.deliverHeading = { [weak self] h in
            self?.webView.evaluateJavaScript("window.__ravHeading && window.__ravHeading(\(h))")
        }
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        location.startForeground()
        webView.load(URLRequest(url: Self.appURL))
    }

    @objc private func reload() {
        offline.isHidden = true
        webView.load(URLRequest(url: Self.appURL))
    }

    @objc private func didBecomeActive() {
        location.startForeground()
        flushPending()
    }

    @objc private func didEnterBackground() {
        location.enterBackground()
    }

    private func flushPending() {
        guard webReady else { return }
        var fixes = location.takePending()
        if let last = location.lastFix, (fixes.last?.t ?? 0) < last.t { fixes.append(last) }
        if !fixes.isEmpty { send(fixes) }
    }

    private func send(_ fixes: [LocationService.Fix]) {
        guard webReady, let data = try? JSONEncoder().encode(fixes), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__ravFixes && window.__ravFixes(\(json))")
    }

    // MARK: Beskeder fra web-appen

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "ready":
            webReady = true
            flushPending()
        case "startTrip": location.startTrip()
        case "stopTrip": location.stopTrip()
        default: break
        }
    }

    // MARK: Links ud af appen (Kort, Airtable, GitHub) åbnes i Safari eller Kort

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.host != Self.appHost, action.navigationType == .linkActivated || action.targetFrame == nil {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        offline.isHidden = false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        offline.isHidden = true
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webReady = false
        webView.reload()
    }
}

/// Undgår, at WKUserContentController holder controlleren i live for evigt
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(c, didReceive: m) }
}
