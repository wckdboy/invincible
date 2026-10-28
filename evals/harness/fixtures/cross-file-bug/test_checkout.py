import unittest

from checkout import amount_due


class TestCheckout(unittest.TestCase):
    def test_fifteen_percent(self):
        self.assertEqual(amount_due(100, 15), 85.0)

    def test_no_discount(self):
        self.assertEqual(amount_due(40, 0), 40.0)


if __name__ == "__main__":
    unittest.main()
