from x402.common import (
    parse_money,
    process_price_to_atomic_amount,
    get_usdc_address,
    find_matching_payment_requirements,
)
from x402.types import (
    TokenAmount,
    TokenAsset,
    EIP712Domain,
    PaymentRequirements,
    PaymentPayload,
    ExactPaymentPayload,
    EIP3009Authorization,
)


def test_parse_money():
    assert (
        parse_money("1", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "base-sepolia")
        == 1000000
    )
    assert (
        parse_money("$1", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "base-sepolia")
        == 1000000
    )
    assert (
        parse_money(
            "$1.12", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "base-sepolia"
        )
        == 1120000
    )

    assert (
        parse_money(
            "$1.00", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "base-sepolia"
        )
        == 1000000
    )

    assert (
        parse_money(
            1120000, "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "base-sepolia"
        )
        == 1120000
    )


def test_process_price_to_atomic_amount_money():
    """Test processing USD money strings to atomic amounts"""
    # Test USD string
    amount, address, domain = process_price_to_atomic_amount("$1.00", "base-sepolia")
    assert amount == "1000000"  # 1 USDC = 1,000,000 atomic units (6 decimals)
    assert (
        address == "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    )  # USDC on base-sepolia
    assert domain["name"] == "USDC"
    assert domain["version"] == "2"

    # Test USD without $ prefix
    amount, address, domain = process_price_to_atomic_amount("0.50", "base-sepolia")
    assert amount == "500000"  # 0.5 USDC = 500,000 atomic units

    # Test integer money
    amount, address, domain = process_price_to_atomic_amount(2, "base-sepolia")
    assert amount == "2000000"  # 2 USDC = 2,000,000 atomic units


def test_process_price_to_atomic_amount_token():
    """Test processing TokenAmount to atomic amounts"""
    # Create a test TokenAmount
    token_asset = TokenAsset(
        address="0x1234567890123456789012345678901234567890",
        decimals=18,
        eip712=EIP712Domain(name="TestToken", version="1"),
    )
    token_amount = TokenAmount(
        amount="1000000000000000000", asset=token_asset
    )  # 1 token with 18 decimals

    amount, address, domain = process_price_to_atomic_amount(
        token_amount, "base-sepolia"
    )
    assert amount == "1000000000000000000"
    assert address == "0x1234567890123456789012345678901234567890"
    assert domain["name"] == "TestToken"
    assert domain["version"] == "1"


def test_process_price_to_atomic_amount_invalid():
    """Test error handling for invalid price types"""
    try:
        process_price_to_atomic_amount({"invalid": "type"}, "base-sepolia")  # type: ignore
        assert False, "Should have raised ValueError"
    except ValueError as e:
        assert "Invalid price type" in str(e)


def test_get_usdc_address():
    """Test getting USDC address for different chain IDs"""
    # Test with string chain ID
    address = get_usdc_address("84532")  # base-sepolia
    assert address == "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

    # Test with int chain ID
    address = get_usdc_address(84532)  # base-sepolia as int
    assert address == "0x036CbD53842c5426634e7929541eC2318f3dCF7e"


def test_find_matching_payment_requirements():
    """Test finding matching payment requirements"""
    # Create test payment requirements
    req1 = PaymentRequirements(
        scheme="exact",
        network="base-sepolia",
        max_amount_required="1000000",
        resource="https://example.com/api/v1",
        description="Test API",
        mime_type="application/json",
        pay_to="0x1234567890123456789012345678901234567890",
        max_timeout_seconds=300,
        asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    )

    req2 = PaymentRequirements(
        scheme="exact",
        network="base",
        max_amount_required="2000000",
        resource="https://example.com/api/v1",
        description="Test API Mainnet",
        mime_type="application/json",
        pay_to="0x1234567890123456789012345678901234567890",
        max_timeout_seconds=300,
        asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    )

    requirements = [req1, req2]

    # Create test payment payload
    authorization = EIP3009Authorization(
        **{
            "from": "0xabcd1234567890123456789012345678901234abcd",
            "to": "0x1234567890123456789012345678901234567890",
            "value": "1000000",
            "validAfter": "1234567890",
            "validBefore": "1234567999",
            "nonce": "0xabc123",
        }
    )

    exact_payload = ExactPaymentPayload(
        signature="0x123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678",
        authorization=authorization,
    )

    payment = PaymentPayload(
        x402_version=1, scheme="exact", network="base-sepolia", payload=exact_payload
    )

    # Test finding matching requirement
    match = find_matching_payment_requirements(requirements, payment)
    assert match is not None
    assert match.network == "base-sepolia"
    assert match.max_amount_required == "1000000"

    # Test no match found
    payment.network = "ethereum"  # No matching network
    match = find_matching_payment_requirements(requirements, payment)
    assert match is None

    # Test different scheme no match
    payment.network = "base-sepolia"  # Back to valid network
    payment.scheme = "different"  # No matching scheme
    match = find_matching_payment_requirements(requirements, payment)
    assert match is None
