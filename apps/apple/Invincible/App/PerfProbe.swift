#if os(iOS)
import Foundation
import os
import QuartzCore
import SwiftUI
import UIKit

/*
 * What the performance suite (InvincibleUITests/PerfTests.swift) reads of the app that the simulator can't tell it:
 * Apple's launch metric reports nothing there, and its scroll metric only a duration. Only when the app is launched with
 * `-InvincibleMeasure YES` (the suite's launch argument, never a user's):
 *  - launch: from the process starting (the system's own record of it) to Home's first frame with what it shows, kept or
 *    fresh;
 *  - cpu and mem: the process's own CPU time so far (its kernel's count) and its memory footprint, so the suite can tell
 *    what the app costs at rest;
 *  - with `-InvincibleMeasureFrames YES` too, every frame that came late (a vsync missed) since launch, from a display
 *    link that runs only then (it would cost something at rest itself).
 * The suite reads them from one element ("perf.probe"), whose value is worked out the moment it is read: no timer runs to
 * keep it fresh. Without the argument none of this exists.
 */
@MainActor
final class PerfProbe {
    static let shared = PerfProbe()

    /// The app was launched to be measured.
    let on = UserDefaults.standard.bool(forKey: "InvincibleMeasure")
    private let log = Logger(subsystem: "sh.invincible.bot", category: "perf")

    /// From the process starting to Home's first frame with its content (ms; nil: not yet).
    private(set) var launchMs: Double?
    /// When the app last took its link to the node for lost, and when it was back (ms since 1970; nil: not yet).
    private var lostAt: Double?
    private var backAt: Double?

    /// The link went (silent, cut, or not back in time): the moment the app says so.
    func linkLost() {
        guard on else { return }
        lostAt = Date().timeIntervalSince1970 * 1000
    }

    /// The link is back.
    func linkBack() {
        guard on, lostAt != nil else { return }
        backAt = Date().timeIntervalSince1970 * 1000
    }

    /// Frames seen, and those that came late: how many, and how much later than their time, in all (ms).
    private var frames = 0
    private var late = 0
    private var lateMs: Double = 0
    private var link: CADisplayLink?
    private var last: CFTimeInterval?

    /// When the system started this process (its own record), as a date.
    static let processStart: Date = {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&name, 4, &info, &size, nil, 0) == 0 else { return Date() }
        let start = info.kp_proc.p_starttime
        return Date(timeIntervalSince1970: TimeInterval(start.tv_sec) + TimeInterval(start.tv_usec) / 1_000_000)
    }()

    private init() {
        guard on else { return }
        _ = Self.processStart
        if UserDefaults.standard.bool(forKey: "InvincibleMeasureFrames") {
            let link = CADisplayLink(target: Ticker(self), selector: #selector(Ticker.tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }
    }

    /// Home's first frame with its content: how long the launch took to be usable, once a launch.
    func usable() {
        guard on, launchMs == nil else { return }
        // (The frame it is in is drawn at the end of this turn of the run loop.)
        DispatchQueue.main.async { [self] in
            guard launchMs == nil else { return }
            let ms = Date().timeIntervalSince(Self.processStart) * 1000
            launchMs = ms
            log.info("launch to usable: \(Int(ms)) ms")
        }
    }

    fileprivate func tick(_ link: CADisplayLink) {
        defer { last = link.timestamp }
        guard let last else { return }
        frames += 1
        let expected = max(1.0 / 120, link.targetTimestamp - link.timestamp)
        let took = link.timestamp - last
        if took > expected * 1.5 {
            late += 1
            lateMs += (took - expected) * 1000
        }
    }

    /// What the suite reads, as things stand this moment.
    var reading: String {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        let cpu = Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000 + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000
        var vm = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let read = withUnsafeMutablePointer(to: &vm) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
        let mem = read == KERN_SUCCESS ? Double(vm.phys_footprint) / 1_048_576 : -1
        return "launch=\(launchMs.map { String(Int($0)) } ?? "-");cpu=\(Int(cpu));mem=\(Int(mem));frames=\(frames);late=\(late);lateMs=\(Int(lateMs));lostAt=\(lostAt.map { String(Int64($0)) } ?? "-");backAt=\(backAt.map { String(Int64($0)) } ?? "-")"
    }

    /// The display link's target: it holds its target strongly, so it holds this instead. (On the main run loop.)
    @MainActor private final class Ticker: NSObject {
        weak var probe: PerfProbe?
        init(_ probe: PerfProbe) { self.probe = probe }
        @objc func tick(_ link: CADisplayLink) { probe?.tick(link) }
    }
}

/// The probe's element, when the app is measured (nothing at all otherwise): one point, out of sight and out of the way,
/// its value worked out as it is read.
struct PerfProbeMark: View {
    var body: some View {
        if PerfProbe.shared.on { Mark().frame(width: 1, height: 1).allowsHitTesting(false) }
    }

    private struct Mark: UIViewRepresentable {
        func makeUIView(context: Context) -> UIView { Read() }
        func updateUIView(_ view: UIView, context: Context) {}
    }

    private final class Read: UIView {
        override init(frame: CGRect) {
            super.init(frame: frame)
            isAccessibilityElement = true
            accessibilityIdentifier = "perf.probe"
            accessibilityLabel = "perf"
        }

        required init?(coder: NSCoder) { nil }

        override var accessibilityValue: String? {
            get { PerfProbe.shared.reading }
            set {}
        }
    }
}
#endif
