import json, secrets
from web3 import Web3
from eth_abi.abi import encode

w3 = Web3(Web3.HTTPProvider('https://rpc.testnet.chain.robinhood.com'))
k = json.load(open('/root/.hermes/secrets/rh_client.json'))
mock_usdg = '0xdDC7e17D6c06F8c5126b65fc9164481D87e6edE4'

with open('/root/x402-robinhood/contracts/out/x402-robinhood_contracts_MockUSDG_sol_MockUSDG.abi') as f:
    abi = json.load(f)
contract = w3.eth.contract(address=Web3.to_checksum_address(mock_usdg), abi=abi)

onchain = contract.functions.DOMAIN_SEPARATOR().call()
print(f'On-chain:  {w3.to_hex(onchain)}')

# Sign
nonce_bytes = w3.keccak(text=secrets.token_hex(16))
msg = {
    'from': k['address'],
    'to': '0x5131c099eB615227aB2Bb8b542D4cBd622910a25',
    'value': int(0.5 * 10**6),
    'validAfter': 0,
    'validBefore': int(w3.eth.get_block('latest')['timestamp']) + 3600,
    'nonce': w3.to_hex(nonce_bytes),
}

TWA_TYPEHASH = w3.keccak(text='TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)')
struct_hash = w3.keccak(encode(
    ['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256', 'bytes32'],
    [TWA_TYPEHASH, msg['from'], msg['to'], msg['value'], msg['validAfter'], msg['validBefore'], nonce_bytes]))

digest = w3.keccak(b'\x19\x01' + onchain + struct_hash)

# Sign with eth_account
import eth_account
signable = eth_account.messages.encode_typed_data(
    domain_data={
        'name': 'USDG',
        'version': '2',
        'chainId': 46630,
        'verifyingContract': mock_usdg,
    },
    message_types={
        'TransferWithAuthorization': [
            {'name': 'from', 'type': 'address'},
            {'name': 'to', 'type': 'address'},
            {'name': 'value', 'type': 'uint256'},
            {'name': 'validAfter', 'type': 'uint256'},
            {'name': 'validBefore', 'type': 'uint256'},
            {'name': 'nonce', 'type': 'bytes32'},
        ],
    },
    message_data=msg,
)
signed = w3.eth.account.sign_message(signable, k['private_key'])
sig = '0x' + signed.signature.hex()

# Recover
recovered = w3.eth.account._recover_hash(digest, vrs=(signed.v, signed.r, signed.s))
print(f'Signer:    {msg["from"]}')
print(f'Recovered: {recovered}')
print(f'Match: {recovered.lower() == msg["from"].lower()}')

# Test facilitator
import requests
payload = {
    'from': msg['from'],
    'to': msg['to'],
    'value': hex(msg['value']),
    'validAfter': hex(msg['validAfter']),
    'validBefore': hex(msg['validBefore']),
    'nonce': msg['nonce'],
    'signature': sig,
}
requirements = {'scheme': 'exact', 'network': 'eip155:46630', 'token': 'USDG', 'amount': '0.5'}
resp = requests.post('http://localhost:3001/verify', json={'payload': payload, 'requirements': requirements})
print(f'Verify: {resp.status_code} {resp.json()}')