from ledger import apply_discount


def amount_due(subtotal, percent):
    return apply_discount(subtotal, percent)
