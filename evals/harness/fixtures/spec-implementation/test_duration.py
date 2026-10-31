import unittest

from duration import parse_duration


class TestDuration(unittest.TestCase):
    def test_seconds(self):
        self.assertEqual(parse_duration("45s"), 45)

    def test_compound(self):
        self.assertEqual(parse_duration("2h30m"), 9000)
        self.assertEqual(parse_duration("1d2h"), 93600)


if __name__ == "__main__":
    unittest.main()
