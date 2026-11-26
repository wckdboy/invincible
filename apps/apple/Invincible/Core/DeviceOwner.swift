import Foundation
import LocalAuthentication

/// The device's owner, asked to say it's them (Face ID, Touch ID or the passcode) before a yes that can't be taken back:
/// an approval opened from its notification (your word, 25 November 2026: never a yes from the lock screen without the
/// request in front of you, and behind Face ID).
enum DeviceOwner {
    /// Nil when the owner confirmed it; otherwise why nothing was approved, in words.
    @MainActor static func confirm(_ reason: String) async -> String? {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return "This device has no passcode, so a yes from a notification can't be checked here: approve it from the Inbox's list instead."
        }
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) ? nil : "Not confirmed, so nothing was approved."
        } catch {
            return "Not confirmed, so nothing was approved."
        }
    }
}
