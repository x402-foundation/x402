import pytest

from x402.schemas import (
    detect_version,
    get_scheme_and_network,
    match_payload_to_requirements,
    parse_payment_payload,
    parse_payment_required,
)

NON_OBJECT_JSON = ["[]", '"s"', "1", "null", "true", "false"]


@pytest.mark.parametrize(
    "helper",
    [
        pytest.param(detect_version, id="detect_version"),
        pytest.param(parse_payment_required, id="parse_payment_required"),
        pytest.param(parse_payment_payload, id="parse_payment_payload"),
        pytest.param(lambda data: get_scheme_and_network(1, data), id="scheme_network_v1"),
        pytest.param(lambda data: get_scheme_and_network(2, data), id="scheme_network_v2"),
        pytest.param(lambda data: match_payload_to_requirements(1, data, b"{}"), id="match_v1"),
        pytest.param(lambda data: match_payload_to_requirements(2, data, b"{}"), id="match_v2"),
        pytest.param(
            lambda data: match_payload_to_requirements(1, b"{}", data), id="match_requirements_v1"
        ),
        pytest.param(
            lambda data: match_payload_to_requirements(2, b"{}", data), id="match_requirements_v2"
        ),
    ],
)
@pytest.mark.parametrize("json_value", NON_OBJECT_JSON)
def test_helpers_reject_non_object_json(helper, json_value):
    with pytest.raises(ValueError, match="must be a JSON object"):
        helper(json_value.encode())


@pytest.mark.parametrize(
    "helper",
    [
        pytest.param(lambda payload: get_scheme_and_network(2, payload), id="scheme_network"),
        pytest.param(lambda payload: match_payload_to_requirements(2, payload, b"{}"), id="match"),
    ],
)
@pytest.mark.parametrize("json_value", NON_OBJECT_JSON)
def test_v2_helpers_reject_non_object_accepted(helper, json_value):
    payload = f'{{"x402Version": 2, "accepted": {json_value}}}'.encode()

    with pytest.raises(ValueError, match="accepted must be a JSON object"):
        helper(payload)
