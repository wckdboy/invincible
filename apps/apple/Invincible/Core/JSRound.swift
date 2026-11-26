import Foundation

extension Double {
    /// JavaScript's Math.round: the nearest whole number, a half towards +∞, so a number the PWA rounds reads the same here.
    var jsRounded: Double {
        let down = rounded(.down)
        return self - down >= 0.5 ? down + 1 : down
    }
}
