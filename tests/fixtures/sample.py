"""A small lexical Python fixture."""

from __future__ import annotations

FACTOR = 2


def decorate(value: int) -> int:
    """Keep indentation and a triple-quoted string visible."""
    return value * FACTOR


@decorate
def compute(café: int, values: list[int]) -> str:
    # Keep a line comment, a string, and a raw string.
    text = "value with spaces"
    raw = r"C:\\temp"
    block = """triple
line"""
    mapping = {
        "value": café,
        "values": [
            *values,
            f"{café=}",
        ],
    }
    if values and \
            café > 0:
        match café:
            case 0:
                return "zero"
            case _:
                return f"{text}:{raw}:{block}:{mapping['value']}"
    return "empty"


async def run(item: int) -> int:
    await compute(item, [item])
    return item
