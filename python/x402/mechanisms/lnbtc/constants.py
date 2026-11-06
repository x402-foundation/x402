"""Networks and units from the exact Lightning specification."""

MAINNET = "lnbtc:000000000019d6689c085ae165831e93"
TESTNET = "lnbtc:000000000933ea01ad0ee984209779ba"
NETWORKS = {MAINNET: "bc", TESTNET: "tb"}
DEFAULT_CLOCK_SKEW = 60
REPLAY_RETENTION_SECONDS = 3600


class LightningValidationError(ValueError):
    """A stable protocol failure reason, without payment material."""


def invalid(reason: str) -> LightningValidationError:
    return LightningValidationError(f"invalid_exact_lnbtc_{reason}")
