"""Helpers for batching `eth_call` requests through Multicall3."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

try:
    from eth_abi import decode, encode
    from eth_utils import keccak
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .constants import MULTICALL3_ADDRESS, MULTICALL3_TRY_AGGREGATE_ABI
from .signer import FacilitatorEvmSigner


@dataclass
class MulticallCall:
    """One call executed through Multicall3."""

    address: str
    abi: list[dict[str, Any]] | None = None
    function_name: str = ""
    args: tuple[Any, ...] = field(default_factory=tuple)
    call_data: bytes = b""


@dataclass
class MulticallResult:
    """Decoded result for a single multicall entry."""

    success: bool
    result: Any = None
    error: Exception | None = None


def encode_contract_call(
    abi: list[dict[str, Any]],
    function_name: str,
    *args: Any,
) -> bytes:
    """Encode calldata for a contract function."""
    function = _get_function_abi(abi, function_name)
    input_types = [_canonical_type(item) for item in function.get("inputs", [])]
    signature = f"{function_name}({','.join(input_types)})"
    selector = keccak(text=signature)[:4]
    return selector + encode(input_types, list(args))


def multicall(
    signer: FacilitatorEvmSigner,
    calls: list[MulticallCall],
) -> list[MulticallResult]:
    """Batch calls through Multicall3 and decode the results."""
    if not calls:
        return []

    aggregate_calls = []
    for call in calls:
        call_data = call.call_data
        if not call_data:
            if not call.abi or not call.function_name:
                raise ValueError("typed multicall entries require ABI and function name")
            call_data = encode_contract_call(call.abi, call.function_name, *call.args)
        aggregate_calls.append((call.address, call_data))

    raw_results = signer.read_contract(
        MULTICALL3_ADDRESS,
        MULTICALL3_TRY_AGGREGATE_ABI,
        "tryAggregate",
        False,
        aggregate_calls,
    )
    normalized = _normalize_results(raw_results)

    if len(normalized) != len(calls):
        raise ValueError(
            f"multicall result length mismatch: got {len(normalized)}, want {len(calls)}"
        )

    results: list[MulticallResult] = []
    for raw_result, call in zip(normalized, calls, strict=True):
        success, return_data = raw_result
        if not success:
            results.append(
                MulticallResult(
                    success=False,
                    error=RuntimeError("multicall: call reverted"),
                )
            )
            continue

        if call.call_data:
            results.append(MulticallResult(success=True))
            continue

        try:
            decoded = _decode_contract_result(call.abi or [], call.function_name, return_data)
        except Exception as exc:
            results.append(MulticallResult(success=False, error=exc))
            continue

        results.append(MulticallResult(success=True, result=decoded))

    return results


def _decode_contract_result(
    abi: list[dict[str, Any]],
    function_name: str,
    return_data: bytes,
) -> Any:
    function = _get_function_abi(abi, function_name)
    output_types = [_canonical_type(item) for item in function.get("outputs", [])]
    if not output_types:
        return None

    decoded = decode(output_types, return_data)
    if len(decoded) == 1:
        return decoded[0]
    return list(decoded)


def _get_function_abi(abi: list[dict[str, Any]], function_name: str) -> dict[str, Any]:
    for entry in abi:
        if entry.get("type") == "function" and entry.get("name") == function_name:
            return entry
    raise ValueError(f"Function {function_name} not found in ABI")


def _canonical_type(abi_item: dict[str, Any]) -> str:
    item_type = abi_item["type"]
    if not item_type.startswith("tuple"):
        return item_type

    suffix = item_type[len("tuple") :]
    components = ",".join(_canonical_type(component) for component in abi_item["components"])
    return f"({components}){suffix}"


def _normalize_results(raw_results: Any) -> list[tuple[bool, bytes]]:
    if not isinstance(raw_results, list | tuple):
        raise ValueError(f"multicall returned {type(raw_results)!r}, want sequence")

    normalized: list[tuple[bool, bytes]] = []
    for index, entry in enumerate(raw_results):
        if isinstance(entry, dict):
            success = bool(entry["success"])
            return_data = entry["returnData"]
        else:
            if hasattr(entry, "success") and hasattr(entry, "returnData"):
                success = bool(entry.success)
                return_data = entry.returnData
            elif isinstance(entry, list | tuple) and len(entry) == 2:
                success = bool(entry[0])
                return_data = entry[1]
            else:
                raise ValueError(f"multicall entry {index} has unexpected type {type(entry)!r}")

        if isinstance(return_data, str):
            return_data = bytes.fromhex(return_data.removeprefix("0x"))
        if not isinstance(return_data, bytes):
            raise ValueError(
                f"multicall entry {index} returnData has unexpected type {type(return_data)!r}"
            )

        normalized.append((success, return_data))

    return normalized
