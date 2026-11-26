import CoreGraphics
import Testing
@testable import Invincible

/// The keyboard on screen can always be closed (your word, 23 November 2026: so you never get stuck under it): a touch
/// anywhere but a field, or the row the field is typed in, closes it.
struct KeyboardClosingTests {
    /// A message box's field, as a window has it: 22 points high, 600 points down.
    let field = CGRect(x: 60, y: 600, width: 250, height: 22)

    @Test func aTouchAboveOrBelowTheFieldsRowClosesIt() {
        #expect(KeyboardClosing.closes(touchY: 300, onField: false, field: field, held: false))
        #expect(KeyboardClosing.closes(touchY: 600 - KeyboardClosing.row - 1, onField: false, field: field, held: false))
        #expect(KeyboardClosing.closes(touchY: 622 + KeyboardClosing.row + 1, onField: false, field: field, held: false))
    }

    @Test func itsRowKeepsItSoItsSendAndPaperclipStillPress() {
        for y in [600 - KeyboardClosing.row, 600, 611, 622, 622 + KeyboardClosing.row] as [CGFloat] {
            #expect(!KeyboardClosing.closes(touchY: y, onField: false, field: field, held: false), "\(y)")
        }
    }

    @Test func aFieldTouchedPutsTheCaretThereAndNothingIsClosedWithNothingOpen() {
        #expect(!KeyboardClosing.closes(touchY: 300, onField: true, field: field, held: false))
        #expect(!KeyboardClosing.closes(touchY: 300, onField: false, field: nil, held: false))
    }

    @Test func aScreenThatTypesElsewhereHoldsIt() {
        #expect(!KeyboardClosing.closes(touchY: 300, onField: false, field: field, held: true))
    }
}
