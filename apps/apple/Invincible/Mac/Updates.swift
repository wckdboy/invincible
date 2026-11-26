#if os(macOS)
import Foundation
import Observation
import Sparkle

/// Updates through Sparkle 2 (the owner's choice), from the signed feed on invincible.sh (`SUFeedURL`). Sparkle checks each
/// update against the public key this build carries (`SUPublicEDKey`, from the build setting INVINCIBLE_SPARKLE_PUBLIC_KEY):
/// until the owner has made that key it is empty, and the updater stays off rather than run with nothing to check by.
/// It checks once a day by itself (`SUEnableAutomaticChecks`), and never under test: a run of the tests doesn't reach
/// invincible.sh or open Sparkle's windows. A new release restarts the node onto it once the app is back
/// (ThisMac.restartIfNewRelease).
@MainActor @Observable final class Updates {
    static let shared = Updates()

    @ObservationIgnored private let controller: SPUStandardUpdaterController?
    @ObservationIgnored private var watching: NSKeyValueObservation?
    /// Sparkle may check now (it isn't checking already).
    private(set) var canCheck = false

    /// Whether this build updates itself at all.
    var available: Bool { controller != nil }

    init(key: String? = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String, testing: Bool = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil) {
        guard let key, !key.trimmingCharacters(in: .whitespaces).isEmpty, !testing else {
            controller = nil
            return
        }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        watching = controller?.updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] _, change in
            let can = change.newValue ?? false
            Task { @MainActor in self?.canCheck = can }
        }
    }

    func check() {
        controller?.checkForUpdates(nil)
    }
}
#endif
