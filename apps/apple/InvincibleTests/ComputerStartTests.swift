import Foundation
import Testing
@testable import Invincible

/// What the app says of an agent's own computer before it is made, as the node makes it (core's computerSize).
struct ComputerStartTests {
    @Test func theComputerIsSaidAsTheNodeMakesIt() {
        // The Build window's "no computer yet" said "one processor and 2 GB to start" (27 November 2026), and the node makes
        // the primary's with a desktop, 4 GB at least: the app's numbers are the node's, with a desktop and without.
        for made in Vectors.shared.computer.sizes {
            let size = ComputerStart.size(desktop: made.desktop)
            #expect(Vectors.Computer.Size(cpus: size.cpus, memoryGb: size.memoryGb, diskGb: size.diskGb) == made.size, "with\(made.desktop ? "" : "out") a desktop")
        }
        #expect(ComputerStart.words(desktop: true) == "One processor and 4 GB to start")
    }
}
