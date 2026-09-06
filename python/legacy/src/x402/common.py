from decimal import Decimal
from typing import List, Optional

from x402.chains import (
    get_chain_id,
    get_token_decimals,
    get_token_name,
    get_token_version,
    get_default_token_address,
)
from x402.types import Price, TokenAmount, PaymentRequirements, PaymentPayload


def parse_money(amount: str | int, address: str, network: str) -> int:
    """Parse money string or int into int

    Params:
        amount: str | int - if int, should be the full amount including token specific decimals
    """
    if isinstance(amount, str):
        if amount.startswith("$"):
            amount = amount[1:]
        decimal_amount = Decimal(amount)

        chain_id = get_chain_id(network)
        decimals = get_token_decimals(chain_id, address)
        decimal_amount = decimal_amount * Decimal(10**decimals)
        return int(decimal_amount)
    return amount


def process_price_to_atomic_amount(
    price: Price, network: str
) -> tuple[str, str, dict[str, str]]:
    """Process a Price into atomic amount, asset address, and EIP-712 domain info

    Args:
        price: Either Money (USD string/int) or TokenAmount
        network: Network identifier

    Returns:
        Tuple of (max_amount_required, asset_address, eip712_domain)

    Raises:
        ValueError: If price format is invalid
    """
    if isinstance(price, (str, int)):
        # Money type - convert USD to USDC atomic units
        try:
            if isinstance(price, str) and price.startswith("$"):
                price = price[1:]
            amount = Decimal(str(price))

            # Get USDC address for the network
            chain_id = get_chain_id(network)
            asset_address = get_usdc_address(chain_id)
            decimals = get_token_decimals(chain_id, asset_address)

            # Convert to atomic units
            atomic_amount = int(amount * Decimal(10**decimals))

            # Get EIP-712 domain info
            eip712_domain = {
                "name": get_token_name(chain_id, asset_address),
                "version": get_token_version(chain_id, asset_address),
            }

            return str(atomic_amount), asset_address, eip712_domain

        except (ValueError, KeyError) as e:
            raise ValueError(f"Invalid price format: {price}. Error: {e}")

    elif isinstance(price, TokenAmount):
        # TokenAmount type - already in atomic units with asset info
        return (
            price.amount,
            price.asset.address,
            {
                "name": price.asset.eip712.name,
                "version": price.asset.eip712.version,
            },
        )

    else:
        raise ValueError(f"Invalid price type: {type(price)}")


def get_usdc_address(chain_id: int | str) -> str:
    """Get the USDC contract address for a given chain ID"""
    chain_id_str = str(chain_id)  # Convert to string for consistency
    return get_default_token_address(chain_id_str, "usdc")


def find_matching_payment_requirements(
    payment_requirements: List[PaymentRequirements],
    payment: PaymentPayload,
) -> Optional[PaymentRequirements]:
    """
    Finds the matching payment requirements for the given payment.

    Args:
        payment_requirements: The payment requirements to search through
        payment: The payment to match against

    Returns:
        The matching payment requirements or None if no match is found
    """
    for req in payment_requirements:
        if req.scheme == payment.scheme and req.network == payment.network:
            return req
    return None


x402_VERSION = 1
