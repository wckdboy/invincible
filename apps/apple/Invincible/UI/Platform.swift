import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/*
 * What an iPhone or an iPad has that a Mac doesn't, or has otherwise, in one place. On iOS each helper is exactly the
 * modifier or call it stands for; on the Mac it is what the Mac has, or nothing where a Mac has no such thing: no keyboard
 * on screen to choose, no capitals added as you type, no navigation bar to size, no tab bar.
 */

#if os(iOS)
typealias PlatformImage = UIImage
#else
typealias PlatformImage = NSImage
#endif

/// When a touch closes the keyboard on screen (your word, 23 November 2026: it can always be closed, so you never get
/// stuck under it): a touch anywhere but on a field, or in the row the field is typed in (its paperclip, its send, its
/// Seal), while no screen that types into something else (an agent's screen, its terminal) holds it open. What was
/// touched still does what it does.
enum KeyboardClosing {
    /// How far above and below the field its row reaches: its buttons stand beside it, a little taller than its words.
    static let row: CGFloat = 16

    /// `field` is where the field with the keyboard is (nil: none has it); `onField`, that the touch is on a field.
    static func closes(touchY: CGFloat, onField: Bool, field: CGRect?, held: Bool) -> Bool {
        guard let field, !onField, !held else { return false }
        return touchY < field.minY - row || touchY > field.maxY + row
    }
}

extension Image {
    init(platformImage image: PlatformImage) {
        #if os(iOS)
        self.init(uiImage: image)
        #else
        self.init(nsImage: image)
        #endif
    }
}

extension EnvironmentValues {
    /// A new chat was asked for from the menus (⌘N, a Mac's or an iPad's): the primary's message box takes the keys, and says
    /// so by clearing it.
    @Entry var composerWanted: Binding<Bool> = .constant(false)
}

extension Metrics {
    /// The widest a conversation's lines are in a wide window, a Mac's or an iPad's (the PWA's reading pages, 760 px).
    static let readingWidth: CGFloat = 760
}

/// What this device is, in its own words: "iPhone", "iPad" or "Mac".
@MainActor enum ThisDevice {
    static var kind: String {
        #if os(iOS)
        UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        #else
        "Mac"
        #endif
    }
}

/// The clipboard, as text.
@MainActor enum Pasteboard {
    static var text: String? {
        #if os(iOS)
        UIPasteboard.general.string
        #else
        NSPasteboard.general.string(forType: .string)
        #endif
    }

    static func copy(_ text: String) {
        #if os(iOS)
        UIPasteboard.general.string = text
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}

/// A page of grouped rows: an iPhone's or an iPad's list; on a Mac, a grouped form, as its own settings are (a Mac's list
/// has no grouped style, and cuts a section's footer to one line).
struct GroupedList<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        #if os(iOS)
        List { content }
        #else
        Form { content }.formStyle(.grouped)
        #endif
    }
}

/// A form's field, its words its placeholder: on iOS the field `TextField(title, text:)` is (a form there shows a field's
/// title as its placeholder); on a Mac, whose grouped form makes a field's title a label beside it, the same words as its
/// prompt, with no label (measured on macOS 27.2: hiding the label alone leaves the field blank).
struct FormField: View {
    private let label: Text
    @Binding private var text: String
    private let axis: Axis
    /// What is typed isn't shown (a key).
    private let secure: Bool

    init(_ title: LocalizedStringKey, text: Binding<String>, axis: Axis = .horizontal, secure: Bool = false) {
        (label, _text, self.axis, self.secure) = (Text(title), text, axis, secure)
    }

    @_disfavoredOverload
    init<S: StringProtocol>(_ title: S, text: Binding<String>, axis: Axis = .horizontal, secure: Bool = false) {
        (label, _text, self.axis, self.secure) = (Text(title), text, axis, secure)
    }

    var body: some View {
        #if os(iOS)
        if secure { SecureField(text: $text) { label } } else { TextField(text: $text, axis: axis) { label } }
        #else
        if secure {
            SecureField(text: $text, prompt: label) { label }.labelsHidden()
        } else {
            TextField(text: $text, prompt: label, axis: axis) { label }.labelsHidden()
        }
        #endif
    }
}

/// The capitals iOS adds as you type (`textInputAutocapitalization`).
enum Capitals { case never, words }

/// The keyboard iOS shows (`keyboardType`).
enum Keyboard { case url, decimal }

extension Color {
    /// One colour on light, another on dark, as the appearance has it (six hex digits each).
    init(light: UInt32, dark: UInt32) {
        #if os(iOS)
        self.init(UIColor { $0.userInterfaceStyle == .dark ? Self.rgb(dark) : Self.rgb(light) })
        #else
        self.init(NSColor(name: nil) { $0.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? Self.rgb(dark) : Self.rgb(light) })
        #endif
    }

    #if os(iOS)
    private static func rgb(_ hex: UInt32) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
    #else
    private static func rgb(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
    #endif
}

/// What is written on a prominent button, whose ground is the ink.
enum Prominent {
    #if os(iOS)
    /// The ink's own (`Color.onAccent`), or grey while the button can't be pressed (`dimmed`).
    static func label(dimmed: Bool = false) -> Color { dimmed ? .secondary : .onAccent }
    #else
    /// The same; and grey too while its window isn't in front, where a Mac draws the button grey under it.
    static func label(dimmed: Bool = false) -> Label { Label(dimmed: dimmed) }

    struct Label: ShapeStyle {
        let dimmed: Bool
        func resolve(in environment: EnvironmentValues) -> Color {
            dimmed || environment.controlActiveState == .inactive ? .secondary : .onAccent
        }
    }
    #endif
}

#if os(iOS)
extension Color {
    /// What sits raised on a grouped list: a card of the agents.
    static var raised: Color { Color(uiColor: .secondarySystemGroupedBackground) }
    /// A row's own ground, under what is drawn over it (the Leads mark on its ring).
    static var rowGround: Color { Color(uiColor: .secondarySystemGroupedBackground) }
    /// The system's hairline.
    static var hairline: Color { Color(uiColor: .separator) }
    /// A row's selection on dark, where the ink is cream and white words on it couldn't be read.
    static var selectionOnDark: Color { Color(uiColor: .systemGray3) }
}

extension ToolbarItemPlacement {
    static var barLeading: ToolbarItemPlacement { .topBarLeading }
    static var barTrailing: ToolbarItemPlacement { .topBarTrailing }
}

extension SearchFieldPlacement {
    /// The search field always shown under the title (a sheet's list).
    static var alwaysShown: SearchFieldPlacement { .navigationBarDrawer(displayMode: .always) }
}

extension View {
    func capitals(_ capitals: Capitals) -> some View { textInputAutocapitalization(capitals == .never ? .never : .words) }
    func keyboard(_ keyboard: Keyboard) -> some View { keyboardType(keyboard == .url ? .URL : .decimalPad) }
    func inlineTitle() -> some View { navigationBarTitleDisplayMode(.inline) }
    /// A conversation has the screen to itself, as in Messages.
    /// A conversation has an iPhone's screen to itself, as in Messages. An iPad has no tab bar to hide (its places are a
    /// sidebar), and hiding one there took the page's own bar away, title and buttons (seen on iPadOS 27).
    func hidingTabBar() -> some View { modifier(HidingTabBar()) }
    func cover<Content: View>(isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> Content) -> some View {
        fullScreenCover(isPresented: isPresented, content: content)
    }
    /// A sheet's own size: on an iPhone or an iPad, the system's.
    func sheetSize(width: CGFloat = 520, height: CGFloat = 600) -> some View { self }
    /// A conversation's width: an iPhone's whole column; in an iPad's wide window, a reading width in its middle, as a Mac's.
    func readingWidth() -> some View { modifier(ReadingWidth()) }
    /// A field drawn by what holds it (a message box's glass, a quiet fill): an iPhone's field draws nothing of its own.
    func plainField() -> some View { self }
}

/// The tab bar hidden on an iPhone (compact width) only.
private struct HidingTabBar: ViewModifier {
    @Environment(\.horizontalSizeClass) private var width

    func body(content: Content) -> some View {
        if width == .compact { content.toolbar(.hidden, for: .tabBar) } else { content }
    }
}

/// A conversation kept to a reading width in the middle of a wide window (a regular width); a narrow one's whole column
/// as it was, an iPhone's always.
private struct ReadingWidth: ViewModifier {
    @Environment(\.horizontalSizeClass) private var width

    func body(content: Content) -> some View {
        if width == .regular {
            content.frame(maxWidth: Metrics.readingWidth).frame(maxWidth: .infinity)
        } else {
            content
        }
    }
}

/// The words being typed, wherever the keyboard is: whether an input method is still composing them, and a new line.
enum Typing {
    static var composing: Bool { (UIResponder.typing as? UITextInput)?.markedTextRange != nil }
    /// An iPad's field puts in a new line of its own for Shift- or Option-Return.
    static func newLine() -> Bool { false }
}

/// Closes the keyboard at a touch `KeyboardClosing` says closes it, in every window of the app (sheets included): a tap
/// that closes it is still the tap it was, so a button beside it still presses.
@MainActor final class KeyboardCloser: NSObject, UIGestureRecognizerDelegate {
    static let shared = KeyboardCloser()
    /// The screens on show that type into something else, and keep the keyboard while you press beside their field.
    static var holds = 0
    private static let name = "invincible.closes-keyboard"

    func install(on window: UIWindow) {
        guard !(window.gestureRecognizers ?? []).contains(where: { $0.name == Self.name }) else { return }
        let tap = UITapGestureRecognizer(target: self, action: #selector(close(_:)))
        tap.name = Self.name
        tap.cancelsTouchesInView = false
        tap.delaysTouchesEnded = false
        tap.delegate = self
        window.addGestureRecognizer(tap)
    }

    @objc private func close(_ tap: UITapGestureRecognizer) { tap.view?.endEditing(true) }

    func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let window = recognizer.view as? UIWindow else { return false }
        let field = (UIResponder.typing as? UIView).map { $0.convert($0.bounds, to: window) }
        // On a field (this one or another, a page's or a terminal's): the touch puts the caret there.
        var view = touch.view
        var onField = false
        while let each = view, !onField {
            onField = each is UITextInput
            view = each.superview
        }
        return KeyboardClosing.closes(touchY: touch.location(in: window).y, onField: onField, field: field, held: Self.holds > 0)
    }

    func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

/// Puts the keyboard's closer on the window it is drawn in (the app's root has one; an iPad's other windows too).
struct ClosesKeyboard: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView { Probe() }
    func updateUIView(_ view: UIView, context: Context) {}

    final class Probe: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let window { KeyboardCloser.shared.install(on: window) }
        }
    }
}

extension View {
    /// A screen that types into something else (an agent's screen, its terminal), with keys to press beside its field:
    /// while it shows, a press there keeps the keyboard. Return, or dragging the page, still closes it.
    func holdsKeyboard() -> some View {
        onAppear { KeyboardCloser.holds += 1 }
            .onDisappear { KeyboardCloser.holds = max(0, KeyboardCloser.holds - 1) }
    }
}

extension UIResponder {
    private static weak var found: UIResponder?
    /// What has the keyboard now, found by asking it to say so.
    static var typing: UIResponder? {
        found = nil
        UIApplication.shared.sendAction(#selector(foundTyping), to: nil, from: nil, for: nil)
        return found
    }

    @objc private func foundTyping() { UIResponder.found = self }
}
#else

extension View {
    /// (A Mac has no keyboard on screen to keep.)
    func holdsKeyboard() -> some View { self }
}

extension Color {
    /// A card on a Mac's list, whose rows lie on the window's own ground: a fill, lighter on dark and darker on light.
    static var raised: Color { Color(nsColor: .quaternarySystemFill) }
    static var rowGround: Color { Color(nsColor: .controlBackgroundColor) }
    static var hairline: Color { Color(nsColor: .separatorColor) }
    static var selectionOnDark: Color { Color(nsColor: .systemGray) }
}

extension ToolbarItemPlacement {
    /// The window's toolbar: its leading end, and where a window's own actions go.
    static var barLeading: ToolbarItemPlacement { .navigation }
    static var barTrailing: ToolbarItemPlacement { .primaryAction }
}

extension SearchFieldPlacement {
    static var alwaysShown: SearchFieldPlacement { .automatic }
}

extension View {
    func capitals(_ capitals: Capitals) -> some View { self }
    func keyboard(_ keyboard: Keyboard) -> some View { self }
    func inlineTitle() -> some View { self }
    func hidingTabBar() -> some View { self }
    /// What covers an iPhone's screen is a sheet on a Mac.
    func cover<Content: View>(isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> Content) -> some View {
        sheet(isPresented: isPresented, content: content)
    }
    /// A sheet on a Mac is as big as what it holds asks; a form asks little, so it is given room.
    /// A sheet is a window of its own on a Mac, which the main window's grouped forms don't reach.
    func sheetSize(width: CGFloat = 520, height: CGFloat = 600) -> some View {
        frame(minWidth: width, idealWidth: width, minHeight: height * 0.6, idealHeight: height).formStyle(.grouped)
    }
    /// A conversation keeps to a reading width in the middle of a wide window.
    func readingWidth() -> some View {
        frame(maxWidth: Metrics.readingWidth).frame(maxWidth: .infinity)
    }
    /// A Mac's field draws its own bezel; inside a message box's glass or a quiet fill, it draws none.
    func plainField() -> some View { textFieldStyle(.plain) }
}

/// The words being typed, in the key window's field: whether an input method is still composing them, and a new line.
enum Typing {
    private static var editor: NSTextView? { NSApp.keyWindow?.firstResponder as? NSTextView }
    static var composing: Bool { editor?.hasMarkedText() == true }
    /// A Mac's field takes Shift-Return as Return, so the new line is put in where Option-Return puts it, at the cursor.
    static func newLine() -> Bool {
        guard let editor else { return false }
        editor.insertNewlineIgnoringFieldEditor(nil)
        return true
    }
}
#endif

extension View {
    /// Return sends a message box's words from a keyboard you type on (a Mac's, an iPad's), and Shift- or Option-Return
    /// starts a new line. A keyboard on the screen is left as it is: its Return is a new line, and the arrow sends.
    func sendsOnReturn(_ send: @escaping () -> Void) -> some View {
        onKeyPress(.return, phases: .down) { press in
            // A word an input method is still composing is its to finish.
            if Typing.composing { return .ignored }
            if !press.modifiers.isDisjoint(with: [.shift, .option]) { return Typing.newLine() ? .handled : .ignored }
            send()
            return .handled
        }
    }
}
