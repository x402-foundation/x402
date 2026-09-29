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

## Selection Behavior

External facilitators:
- Are **not selected by default**
- Display under an "External" grouping in interactive mode
- Require explicit selection by developers
- Must have all required environment variables set before running

