import unittest

from formats import parse_field_00, parse_field_39, parse_port, parse_size, parse_speed


class TestFormats(unittest.TestCase):
    def test_port(self):
        self.assertEqual(parse_port("8080"), 8080)
        self.assertEqual(parse_port(""), 8080)
        self.assertEqual(parse_port("1"), 1)
        self.assertEqual(parse_port("65535"), 65535)
        for bad in ("0", "-1", "65536", "http"):
            with self.assertRaises(ValueError):
                parse_port(bad)

    def test_unrelated(self):
        self.assertEqual(parse_field_00("  x  "), "x")
        self.assertEqual(parse_field_39("y"), "y")
        self.assertEqual(parse_speed("12m"), 12)
        self.assertEqual(parse_size("2k"), 2048)


if __name__ == "__main__":
    unittest.main()
