"""Validation and extraction utilities for the Payment-Identifier Extension."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .types import PAYMENT_IDENTIFIER, PaymentIdentifierExtension, PaymentIdentifierInfo
from .utils import is_valid_payment_id

if TYPE_CHECKING:
    from x402.schemas.payments import PaymentPayload


@dataclass
class PaymentIdentifierValidationResult:
    """Result of payment identifier validation.

    Attributes:
        valid: Whether the payment identifier is valid.
        errors: Error messages if validation failed.
    """

    valid: bool
    errors: list[str] = field(default_factory=list)


def is_payment_identifier_extension(extension: Any) -> bool:
    """Type guard to check if an object is a valid payment-identifier extension structure.

    This checks for the basic structure (info object with required boolean),
    but does not validate the id format if present.

    Args:
        extension: The object to check.

    Returns:
        True if the object has the expected payment-identifier extension structure.

    Example:
        ```python
        if is_payment_identifier_extension(extensions["payment-identifier"]):
            # TypeScript knows this is PaymentIdentifierExtension
            print(extension.info.required)
        ```
    """
    if not extension or not isinstance(extension, dict | PaymentIdentifierExtension):
        return False

    if isinstance(extension, PaymentIdentifierExtension):
        return True

    ext = extension
    if not isinstance(ext, dict):
        return False

    info = ext.get("info")
    if not info or not isinstance(info, dict | PaymentIdentifierInfo):
        return False

    if isinstance(info, PaymentIdentifierInfo):
        return True

    info_dict = info
    # Must have required boolean
    if not isinstance(info_dict.get("required"), bool):
        return False

    return True


def validate_payment_identifier(extension: Any) -> PaymentIdentifierValidationResult:
    """Validate a payment-identifier extension object.

    Checks both the structure (using JSON Schema) and the ID format.

    Args:
        extension: The extension object to validate.

    Returns:
        Validation result with errors if invalid.

    Example:
        ```python
        result = validate_payment_identifier(
            payment_payload.extensions.get("payment-identifier")
        )
        if not result.valid:
            print("Invalid payment identifier:", result.errors)
        ```
    """
    if not extension or not isinstance(extension, dict | PaymentIdentifierExtension):
        return PaymentIdentifierValidationResult(
            valid=False,
            errors=["Extension must be an object"],
        )

    # Convert to dict if it's a Pydantic model
    if isinstance(extension, PaymentIdentifierExtension):
        ext_dict = extension.model_dump(by_alias=True)
    else:
        ext_dict = extension

    # Check info exists
    info = ext_dict.get("info")
    if not info or not isinstance(info, dict | PaymentIdentifierInfo):
        return PaymentIdentifierValidationResult(
            valid=False,
            errors=["Extension must have an 'info' property"],
        )

    # Convert info to dict if it's a Pydantic model
    if isinstance(info, PaymentIdentifierInfo):
        info_dict = info.model_dump(by_alias=True)
    else:
        info_dict = info

    # Check required field exists and is a boolean
    if not isinstance(info_dict.get("required"), bool):
        return PaymentIdentifierValidationResult(
            valid=False,
            errors=["Extension info must have a 'required' boolean property"],
        )

    # Check id exists and is a string (if provided)
    id_value = info_dict.get("id")
    if id_value is not None and not isinstance(id_value, str):
        return PaymentIdentifierValidationResult(
            valid=False,
            errors=["Extension info 'id' must be a string if provided"],
        )

    # Validate ID format if provided
    if id_value is not None and not is_valid_payment_id(id_value):
        return PaymentIdentifierValidationResult(
            valid=False,
            errors=[
                "Invalid payment ID format. ID must be 16-128 characters and contain only alphanumeric characters, hyphens, and underscores."
            ],
        )

    # If schema is provided, validate against it
    schema = ext_dict.get("schema")
    if schema:
        # Lazy import jsonschema only when schema validation is needed
        try:
            import jsonschema
        except ImportError:
            return PaymentIdentifierValidationResult(
                valid=False,
                errors=[
                    "Schema validation requires jsonschema. Install with: pip install x402[extensions]"
                ],
            )

        try:
            jsonschema.validate(instance=info_dict, schema=schema)
        except jsonschema.ValidationError as e:
            path = "/".join(str(p) for p in e.absolute_path) if e.absolute_path else "(root)"
            return PaymentIdentifierValidationResult(
                valid=False,
                errors=[f"{path}: {e.message}"],
            )
        except Exception as e:
            return PaymentIdentifierValidationResult(
                valid=False,
                errors=[f"Schema validation failed: {e!s}"],
            )

    return PaymentIdentifierValidationResult(valid=True)


def extract_payment_identifier(
    payment_payload: PaymentPayload, validate: bool = True
) -> str | None:
    """Extract the payment identifier from a PaymentPayload.

    Args:
        payment_payload: The payment payload to extract from.
        validate: Whether to validate the ID before returning (default: True).

    Returns:
        The payment ID string, or None if not present or invalid.

    Example:
        ```python
        id = extract_payment_identifier(payment_payload)
        if id:
            # Use for idempotency lookup
            cached = await idempotency_store.get(id)
        ```
    """
    if not payment_payload.extensions:
        return None

    extension = payment_payload.extensions.get(PAYMENT_IDENTIFIER)

    if not extension:
        return None

    # Convert to dict if it's a Pydantic model
    if isinstance(extension, PaymentIdentifierExtension):
        ext_dict = extension.model_dump(by_alias=True)
    elif isinstance(extension, dict):
        ext_dict = extension
    else:
        return None

    info = ext_dict.get("info")
    if not info:
        return None

    # Convert info to dict if it's a Pydantic model
    if isinstance(info, PaymentIdentifierInfo):
        info_dict = info.model_dump(by_alias=True)
    elif isinstance(info, dict):
        info_dict = info
    else:
        return None

    id_value = info_dict.get("id")
    if not isinstance(id_value, str):
        return None

    if validate and not is_valid_payment_id(id_value):
        return None

    return id_value


def extract_and_validate_payment_identifier(
    payment_payload: PaymentPayload,
) -> tuple[str | None, PaymentIdentifierValidationResult]:
    """Extract and validate the payment identifier from a PaymentPayload.

    Args:
        payment_payload: The payment payload to extract from.

    Returns:
        Tuple of (id, validation_result) where id is the payment ID or None,
        and validation_result indicates if validation passed.

    Example:
        ```python
        id, validation = extract_and_validate_payment_identifier(payment_payload)
        if not validation.valid:
            return res.status(400).json({"error": validation.errors})
        if id:
            # Use for idempotency
            pass
        ```
    """
    if not payment_payload.extensions:
        return None, PaymentIdentifierValidationResult(valid=True)

    extension = payment_payload.extensions.get(PAYMENT_IDENTIFIER)

    if not extension:
        return None, PaymentIdentifierValidationResult(valid=True)

    validation = validate_payment_identifier(extension)

    if not validation.valid:
        return None, validation

    # Extract the ID
    id_value = extract_payment_identifier(payment_payload, validate=False)
    return id_value, PaymentIdentifierValidationResult(valid=True)


def has_payment_identifier(payment_payload: PaymentPayload) -> bool:
    """Check if a PaymentPayload contains a payment-identifier extension.

    Args:
        payment_payload: The payment payload to check.

    Returns:
        True if the extension is present.
    """
    return bool(payment_payload.extensions and PAYMENT_IDENTIFIER in payment_payload.extensions)


def is_payment_identifier_required(extension: Any) -> bool:
    """Check if the server requires a payment identifier based on the extension info.

    Args:
        extension: The payment-identifier extension from PaymentRequired or PaymentPayload.

    Returns:
        True if the server requires a payment identifier.
    """
    if not extension or not isinstance(extension, dict | PaymentIdentifierExtension):
        return False

    # Convert to dict if it's a Pydantic model
    if isinstance(extension, PaymentIdentifierExtension):
        ext_dict = extension.model_dump(by_alias=True)
    else:
        ext_dict = extension

    info = ext_dict.get("info")
    if not info:
        return False

    # Convert info to dict if it's a Pydantic model
    if isinstance(info, PaymentIdentifierInfo):
        info_dict = info.model_dump(by_alias=True)
    elif isinstance(info, dict):
        info_dict = info
    else:
        return False

    return info_dict.get("required") is True


def validate_payment_identifier_requirement(
    payment_payload: PaymentPayload, server_required: bool
) -> PaymentIdentifierValidationResult:
    """Validate that a payment identifier is provided when required.

    Use this to check if a client's PaymentPayload satisfies the server's requirement.

    Args:
        payment_payload: The client's payment payload.
        server_required: Whether the server requires a payment identifier (from PaymentRequired).

    Returns:
        Validation result - invalid if required but not provided.

    Example:
        ```python
        server_extension = payment_required.extensions.get("payment-identifier")
        server_required = is_payment_identifier_required(server_extension)
        result = validate_payment_identifier_requirement(payment_payload, server_required)
        if not result.valid:
            return res.status(400).json({"error": result.errors})
        ```
    """
    if not server_required:
        return PaymentIdentifierValidationResult(valid=True)

    id_value = extract_payment_identifier(payment_payload, validate=False)

    if not id_value:
        return PaymentIdentifierValidationResult(
            valid=False,
            errors=["Server requires a payment identifier but none was provided"],
        )

    # Validate the ID format
    if not is_valid_payment_id(id_value):
        return PaymentIdentifierValidationResult(
            valid=False,
            errors=[
                "Invalid payment ID format. ID must be 16-128 characters and contain only alphanumeric characters, hyphens, and underscores."
            ],
        )

    return PaymentIdentifierValidationResult(valid=True)
