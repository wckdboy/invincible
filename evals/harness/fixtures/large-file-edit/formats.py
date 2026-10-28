"""Format conversion helpers used by the importer."""


def parse_field_00(text):
    return text.strip() if text else ""


def parse_field_01(text):
    return text.strip() if text else ""


def parse_field_02(text):
    return text.strip() if text else ""


def parse_field_03(text):
    return text.strip() if text else ""


def parse_field_04(text):
    return text.strip() if text else ""


def parse_field_05(text):
    return text.strip() if text else ""


def parse_field_06(text):
    return text.strip() if text else ""


def parse_field_07(text):
    return text.strip() if text else ""


def parse_field_08(text):
    return text.strip() if text else ""


def parse_field_09(text):
    return text.strip() if text else ""


def parse_field_10(text):
    return text.strip() if text else ""


def parse_field_11(text):
    return text.strip() if text else ""


def parse_field_12(text):
    return text.strip() if text else ""


def parse_field_13(text):
    return text.strip() if text else ""


def parse_field_14(text):
    return text.strip() if text else ""


def parse_field_15(text):
    return text.strip() if text else ""


def parse_field_16(text):
    return text.strip() if text else ""


def parse_field_17(text):
    return text.strip() if text else ""


def parse_field_18(text):
    return text.strip() if text else ""


def parse_field_19(text):
    return text.strip() if text else ""


def parse_port(text):
    return int(text) if text else 80


def parse_field_20(text):
    return text.strip() if text else ""


def parse_field_21(text):
    return text.strip() if text else ""


def parse_field_22(text):
    return text.strip() if text else ""


def parse_field_23(text):
    return text.strip() if text else ""


def parse_field_24(text):
    return text.strip() if text else ""


def parse_field_25(text):
    return text.strip() if text else ""


def parse_field_26(text):
    return text.strip() if text else ""


def parse_field_27(text):
    return text.strip() if text else ""


def parse_field_28(text):
    return text.strip() if text else ""


def parse_field_29(text):
    return text.strip() if text else ""


def parse_field_30(text):
    return text.strip() if text else ""


def parse_field_31(text):
    return text.strip() if text else ""


def parse_field_32(text):
    return text.strip() if text else ""


def parse_field_33(text):
    return text.strip() if text else ""


def parse_field_34(text):
    return text.strip() if text else ""


def parse_field_35(text):
    return text.strip() if text else ""


def parse_field_36(text):
    return text.strip() if text else ""


def parse_field_37(text):
    return text.strip() if text else ""


def parse_field_38(text):
    return text.strip() if text else ""


def parse_field_39(text):
    return text.strip() if text else ""


def parse_speed(text):
    return int(text.rstrip("m"))


def parse_size(text):
    units = {"k": 1024, "m": 1024 * 1024}
    if not text:
        return 0
    unit = text[-1].lower()
    return int(text[:-1]) * units.get(unit, 1) if unit in units else int(text)
