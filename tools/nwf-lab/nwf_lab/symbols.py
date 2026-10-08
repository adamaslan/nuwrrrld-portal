"""Symbology at the provider boundary. Alpaca and Finnhub use a dot (BRK.B); Yahoo uses a hyphen."""


def to_alpaca(symbol: str) -> str:
    return symbol.strip().upper().replace("-", ".")


def to_yahoo(symbol: str) -> str:
    return symbol.strip().upper().replace(".", "-")


def canonical(symbol: str) -> str:
    """Lab-internal form: dot form, matching Alpaca/Finnhub."""
    return to_alpaca(symbol)
