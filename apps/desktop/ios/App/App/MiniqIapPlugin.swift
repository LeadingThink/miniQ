import Capacitor
import Foundation
import StoreKit

/// StoreKit 2 bridge for the iOS prepaid AI credit packs.
///
/// The bridge never grants access by itself. It returns Apple's signed
/// transaction to the web layer, which sends it to the miniQ server. The
/// transaction is finished only after the server acknowledges it.
@objc(MiniqIapPlugin)
public class MiniqIapPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MiniqIapPlugin"
    public let jsName = "MiniqIap"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getUnfinishedTransactions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishTransaction", returnType: CAPPluginReturnPromise),
    ]

    private var transactionListener: Task<Void, Never>?

    public override func load() {
        transactionListener = Task { [weak self] in
            for await result in Transaction.updates {
                guard !Task.isCancelled else { return }
                guard case .verified = result else { continue }
                self?.notifyListeners("transactionUpdated", data: [:])
            }
        }
    }

    deinit { transactionListener?.cancel() }

    @objc func getUnfinishedTransactions(_ call: CAPPluginCall) {
        Task {
            var transactions: [[String: Any]] = []
            for await result in Transaction.unfinished {
                guard case .verified(let transaction) = result else {
                    call.reject("Apple 无法验证待处理交易", "iap_unverified")
                    return
                }
                transactions.append(transactionPayload(transaction, signedTransaction: result.jwsRepresentation))
            }
            call.resolve(["transactions": transactions])
        }
    }

    @objc func getProducts(_ call: CAPPluginCall) {
        let ids = call.getArray("productIds", String.self) ?? []
        Task {
            do {
                let products = try await Product.products(for: ids)
                call.resolve(["products": products.map(productPayload)])
            } catch {
                call.reject("无法加载 App 内购买项目", "iap_products_failed", error)
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId"), !productId.isEmpty else {
            call.reject("缺少商品 ID")
            return
        }
        guard let token = call.getString("appAccountToken"), let accountToken = UUID(uuidString: token) else {
            call.reject("缺少有效的购买账户")
            return
        }
        Task {
            do {
                guard let product = try await Product.products(for: [productId]).first else {
                    call.reject("商品不存在或尚未在 App Store 生效")
                    return
                }
                switch try await product.purchase(options: [.appAccountToken(accountToken)]) {
                case .success(let result):
                    switch result {
                    case .verified(let transaction):
                        call.resolve(transactionPayload(transaction, signedTransaction: result.jwsRepresentation))
                    case .unverified(_, let error):
                        call.reject("Apple 无法验证这笔交易", "iap_unverified", error)
                    }
                case .userCancelled:
                    call.reject("用户取消了购买", "iap_cancelled")
                case .pending:
                    call.reject("购买正在等待 Apple 处理", "iap_pending")
                @unknown default:
                    call.reject("购买结果未知，请稍后检查购买记录")
                }
            } catch {
                call.reject("购买失败", "iap_purchase_failed", error)
            }
        }
    }

    @objc func finishTransaction(_ call: CAPPluginCall) {
        guard let transactionId = call.getString("transactionId"),
              let id = UInt64(transactionId) else {
            call.reject("交易 ID 无效")
            return
        }
        Task {
            for await result in Transaction.unfinished {
                guard case .verified(let transaction) = result, transaction.id == id else { continue }
                await transaction.finish()
                call.resolve()
                return
            }
            // A transaction may already be finished after a retry. Treat that
            // state as success so the server acknowledgement remains idempotent.
            call.resolve()
        }
    }

    private func productPayload(_ product: Product) -> [String: Any] {
        [
            "productId": product.id,
            "displayName": product.displayName,
            "description": product.description,
            "displayPrice": product.displayPrice,
            "price": NSDecimalNumber(decimal: product.price).stringValue,
            "currencyCode": product.priceFormatStyle.currencyCode,
        ]
    }

    private func transactionPayload(_ transaction: Transaction, signedTransaction: String) -> [String: Any] {
        // Preserve the compact JWS from VerificationResult for server verification.
        var payload: [String: Any] = [
            "productId": transaction.productID,
            "transactionId": String(transaction.id),
            "originalTransactionId": String(transaction.originalID),
            "signedTransaction": signedTransaction,
        ]
        if let token = transaction.appAccountToken {
            payload["appAccountToken"] = token.uuidString.lowercased()
        }
        return payload
    }
}
