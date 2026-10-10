"""Make repeated Solana batch payments with the requests transport."""

import os

from x402 import x402ClientSync
from x402.http.clients import x402_requests
from x402.mechanisms.svm import KeypairSigner
from x402.mechanisms.svm.batch_settlement import (
    BatchServerSignedChannelsPolicy,
    BatchSvmClientConfig,
    register_batch_svm_client,
)


def main() -> None:
    operator = os.environ.get("TRUSTED_OPERATOR")
    config = BatchSvmClientConfig(
        rpc_url=os.environ.get("SVM_RPC_URL"),
        server_signed_channels_policy=(
            BatchServerSignedChannelsPolicy(
                allowed_operators=[operator], max_deposit="$1"
            )
            if operator
            else None
        ),
    )
    client = x402ClientSync().set_spend_controls({"max_amount_per_payment": "$0.10"})
    register_batch_svm_client(
        client, KeypairSigner.from_base58(os.environ["SVM_PRIVATE_KEY"]), config=config
    )
    with x402_requests(client) as session:
        for _ in range(int(os.environ.get("NUMBER_OF_REQUESTS", "3"))):
            response = session.get(os.environ["RESOURCE_URL"])
            response.raise_for_status()
            print(response.text)


if __name__ == "__main__":
    main()
