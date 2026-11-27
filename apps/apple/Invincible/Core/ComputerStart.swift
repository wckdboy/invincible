import Foundation

/// What the node makes an agent's own computer with, the primary's too (core's COMPUTER_START and computerSize, held to
/// them by the vectors): one processor, 2 GB and 20 GB of disk unless it is asked for more, with a desktop too. A desktop's
/// browser needs room: the VM grows, live, to 4 GB the first time its desktop is used (C1 step 10). The Mac's Build window
/// says it before the primary's computer is made.
enum ComputerStart {
    struct Size: Equatable {
        let cpus: Double
        let memoryGb: Double
        let diskGb: Double
    }

    static let cpus = 1.0
    static let memoryGb = 2.0
    static let diskGb = 20.0
    static let desktopMemoryGb = 4.0

    static func size(desktop: Bool) -> Size {
        Size(cpus: cpus, memoryGb: memoryGb, diskGb: diskGb)
    }

    /// "One processor and 2 GB to start (4 GB once its desktop is first used)", as the Build window says it.
    static func words(desktop: Bool) -> String {
        let size = size(desktop: desktop)
        let processors = size.cpus == 1 ? "One processor" : "\(number(size.cpus)) processors"
        let start = "\(processors) and \(number(size.memoryGb)) GB to start"
        return desktop && desktopMemoryGb > size.memoryGb ? "\(start) (\(number(desktopMemoryGb)) GB once its desktop is first used)" : start
    }

    private static func number(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(value)
    }
}
