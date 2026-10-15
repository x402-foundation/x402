# External Facilitator Proxies

This directory contains proxy facilitators that connect to **external production facilitators** for E2E testing.

## Purpose

External proxies allow testing against real-world facilitator implementations without including their implementation details in this repository. They act as bridges between the test suite and external services.

## Structure

- **`/external-proxies/`** - (gitignored) For local development facilitators or private testing

## Local Development

The `external-proxies/` directory is gitignored and meant for:
- Testing development facilitators locally
- Proxies you don't want to commit to the repository
- Personal facilitator configurations

## Configuration

Each proxy requires:
1. A `test.config.json` with facilitator metadata
2. Required environment variables (e.g., API keys)
3. Implementation that forwards requests to the external facilitator

See individual proxy directories for specific setup requirements.

A proxy's `test.config.json` declares the remote service's capabilities rather
than the SDK language used for the forwarding process. For example:

```json
{
  "name": "my-external-proxy",
  "type": "facilitator",
  "language": "external",
  "protocolFamilies": ["svm"],
  "x402Versions": [2],
  "schemes": ["batch-settlement"],
  "environment": {
    "required": ["EXTERNAL_FACILITATOR_URL"],
    "optional": []
  }
}
```

Use a local `run.sh` to launch the forwarding process on `PORT`. Log
`Facilitator listening` when ready, expose local `/health` and `/close`
endpoints, and forward `/supported`, `/verify`, and `/settle` to the configured
service. Preserve its status codes and response bodies. `/close` shuts down
the local proxy only. Declare any authentication variables in `environment`;
the remote service's wallet private keys are not needed by the proxy.

## Selection Behavior

External facilitators:
- Are **not selected by default**
- Display under an "External" grouping in interactive mode
- Require explicit selection by developers
- Must have all required environment variables set before running
