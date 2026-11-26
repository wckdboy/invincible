import Foundation
import Testing
@testable import Invincible

/// Keys and the providers they are for, as the PWA reads them (`lib/text.ts`), over the node's own presets; and the
/// copy this iPhone keeps.
struct ModelsTests {
    let cases = Vectors.shared.keys
    var view: ProvidersView { ProvidersView(providers: cases.providers, presets: cases.presets, signIns: cases.signIns) }

    @Test func aKeysProviderIsRecognisedAsThePWARecognisesIt() {
        for item in cases.detected {
            #expect(Models.provider(of: item.key, in: view) == item.provider, "\(item.key)")
            #expect(Models.signIn(item.key, in: view) == item.signIn, "\(item.key)")
        }
    }

    @Test func aSubscriptionsSignInIsNeverAProvidersKey() {
        let signIn = Models.signIn("sk-ant-oat01-FAKE-for-tests", in: view)
        #expect(signIn?.tool == "Claude Code")
        #expect(Models.provider(of: "sk-ant-oat01-FAKE-for-tests", in: view) == nil)
    }

    @Test func aCodingPlanSaysWhatItIsFor() {
        for item in cases.plans {
            #expect(Models.planLine(cases.presets.first { $0.id == item.id }) == item.line, "\(item.id)")
        }
    }

    @Test func aSealedKeysProviderIsSetUpAsThePWASetsItUp() {
        for item in cases.setups {
            let setup = Models.setup(view, provider: item.provider, secret: item.secret, mayConfigure: item.may, baseUrl: item.baseUrl)
            #expect(setup.say == item.say, "\(item.provider)")
            let request = setup.request.map { Vectors.KeyCases.Request(id: $0.id, kind: $0.kind, baseUrl: $0.baseUrl, secret: $0.secret) }
            #expect(request == item.request, "\(item.provider)")
        }
    }

    @Test(.enabled(if: PhoneKeys.offered, "this device keeps no copies of keys"))
    func aCopyIsKeptListedWithoutItsValueReadBackAndForgotten() async throws {
        let service = "sh.invincible.bot.keys.tests.\(UUID().uuidString)"
        defer { try? PhoneKeys.forget(name: "fake-key", service: service) }
        try PhoneKeys.keep(name: "fake-key", value: "fake-value-for-tests", provider: "openrouter", label: "tests", service: service)
        try PhoneKeys.keep(name: "fake-key", value: "fake-value-for-tests-2", provider: "openrouter", label: "tests", service: service)
        let listed = PhoneKeys.list(service: service)
        #expect(listed.map(\.name) == ["fake-key"])
        #expect(listed.first?.provider == "openrouter")
        #expect(try await PhoneKeys.value(of: "fake-key", reason: "tests", service: service) == "fake-value-for-tests-2")
        try PhoneKeys.forget(name: "fake-key", service: service)
        #expect(PhoneKeys.list(service: service).isEmpty)
        await #expect(throws: PhoneKeys.Failure.notFound) { try await PhoneKeys.value(of: "fake-key", reason: "tests", service: service) }
    }
}
