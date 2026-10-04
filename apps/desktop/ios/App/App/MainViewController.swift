import Capacitor
import UIKit

/// Registers app-local plugins that are not distributed as npm packages.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MiniqPushPlugin())
        bridge?.registerPluginInstance(MiniqPowerPlugin())
    }
}

@objc(MiniqPowerPlugin)
public class MiniqPowerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MiniqPowerPlugin"
    public let jsName = "MiniqPower"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
    ]

    @objc func getState(_ call: CAPPluginCall) {
        call.resolve(["lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled])
    }
}
