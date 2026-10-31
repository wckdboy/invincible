import unittest

from duration import parse_duration


class TestSpec(unittest.TestCase):
    def test_edges(self):
        self.assertEqual(parse_duration("0s"), 0)
        self.assertEqual(parse_duration("45m"), 2700)
        self.assertEqual(parse_duration("1d"), 86400)
        self.assertEqual(parse_duration("2d3h"), 183600)
        self.assertEqual(parse_duration("10s10s"), 20)

    def test_invalid(self):
        for text in ("", "1x", "h", "-1h", "1h 30m", "1.5h"):
            with self.assertRaises(ValueError):
                parse_duration(text)


if __name__ == "__main__":
    unittest.main()
