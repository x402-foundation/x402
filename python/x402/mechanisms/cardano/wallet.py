"""CIP-1852 key derivation shared by payment and seller signers."""

from dataclasses import dataclass

from pycardano import Address, HDWallet, Network, PaymentExtendedSigningKey, StakeExtendedSigningKey

from .constants import get_cardano_network_id


@dataclass(frozen=True)
class CardanoWallet:
    address: str
    payment_key: PaymentExtendedSigningKey


def derive_wallet(mnemonic: str, network: str, account_index: int = 0) -> CardanoWallet:
    if type(account_index) is not int or not 0 <= account_index < 2**31:
        raise ValueError("Cardano account index must be a non-negative unhardened index")
    wallet = HDWallet.from_mnemonic(" ".join(mnemonic.lower().split()))
    root = f"m/1852'/1815'/{account_index}'"
    payment = PaymentExtendedSigningKey.from_hdwallet(wallet.derive_from_path(root + "/0/0"))
    stake = StakeExtendedSigningKey.from_hdwallet(wallet.derive_from_path(root + "/2/0"))
    address = Address(
        payment.to_verification_key().hash(),
        stake.to_verification_key().hash(),
        Network(get_cardano_network_id(network)),
    )
    return CardanoWallet(str(address), payment)
