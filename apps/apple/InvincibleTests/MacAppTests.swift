#if os(macOS)
import AppKit
import Foundation
import Testing
@testable import Invincible

/// The Mac app's own behaviour, apart from its node (MacNodeTests): what it does as it starts.
@MainActor struct MacAppTests {
    @Test func aTestRunNeverStartsTheAppOnTheMacItRunsOn() {
        // Hosted by a test, the app reads no device key, no pairing and no node of the Mac it runs on: the test makes its own.
        #expect(MacApp.startsItself([:]))
        #expect(!MacApp.startsItself(["XCTestConfigurationFilePath": "/tmp/a-test-run.xctestconfiguration"]))
        #expect(!MacApp.startsItself(ProcessInfo.processInfo.environment), "this run is a test's, and the app started itself")
    }
}
#endif
