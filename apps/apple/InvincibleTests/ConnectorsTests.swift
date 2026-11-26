import Foundation
import Testing
@testable import Invincible

/// Where a connector's key or sign-in stands, in the PWA's words (`lib/connector-state.ts`).
struct ConnectorsTests {
    @Test func eachConnectorsBadgeIsThePWAs() {
        for item in Vectors.shared.connectorStates {
            let state = Connectors.state(key: item.key, signIn: item.signIn)
            #expect(state?.label == item.state?.label && state?.tone == item.state?.tone, "\(item.key) \(item.signIn ?? "key")")
        }
    }

    @Test func googleSendsYouBackToTheAppsOwnAddressOnTheNode() {
        #expect(Connectors.callback(origin: URL(string: "https://keep.example.ts.net")!) == "https://keep.example.ts.net/oauth/callback")
        #expect(Connectors.callback(origin: URL(string: "https://keep.example.ts.net:8443/")!) == "https://keep.example.ts.net:8443/oauth/callback")
    }

    @Test func aConnectorIsReadAsTheNodeListsIt() throws {
        let json = #"{"id":"gmail","label":"Gmail","description":"Your mail.","kind":"http","url":null,"origin":"https://gmail.googleapis.com","installed":true,"key":"signed-out","secret":"gmail","keyHelp":null,"needsOrigin":false,"problem":null,"tools":[{"name":"gmail.send","description":"Send a message.","method":"POST","path":"/x","class":"outward","asks":true,"params":{}}],"access":{"only":"primary","allowed":[]},"oauth":{"provider":"google","account":null},"private":true}"#
        let connector = try JSONDecoder().decode(ConnectorView.self, from: Data(json.utf8))
        #expect(connector.tools.first?.asks == true && connector.private && connector.oauth?.provider == "google")
        #expect(Connectors.state(key: connector.key, signIn: connector.oauth?.provider)?.label == "not signed in")
    }

    @Test func aHostedMCPServerFromTheLibraryIsReadWithItsAddressAndItsOwnSignIn() throws {
        let json = #"{"id":"linear","label":"Linear","description":"Issues, projects and cycles.","kind":"mcp","url":"https://mcp.linear.app/mcp","origin":"https://mcp.linear.app","installed":false,"key":"missing","secret":"linear","keyHelp":null,"needsOrigin":false,"problem":null,"tools":[],"access":null,"oauth":{"provider":"mcp","account":null},"private":false}"#
        let connector = try JSONDecoder().decode(ConnectorView.self, from: Data(json.utf8))
        #expect(connector.url == "https://mcp.linear.app/mcp" && connector.oauth?.provider == "mcp")
        // No app of yours: before you sign in it is just not signed in.
        #expect(Connectors.state(key: "missing", signIn: "mcp")?.label == "not signed in")
        #expect(Connectors.state(key: "missing", signIn: "google")?.label == "needs your app")
    }
}
