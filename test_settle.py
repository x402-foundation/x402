import json, secrets
from web3 import Web3
from eth_abi.abi import encode
import requests

w3 = Web3(Web3.HTTPProvider('https://rpc.testnet.chain.robinhood.com'))
k = json.load(open('/root/.hermes/secrets/rh_client.json'))
mock_usdg = '0xdDC7e17D6c06F8c5126b65fc9164481D87e6edE4'

with open('/root/x402-robinhood/contracts/out/x402-robinhood_contracts_MockUSDG_sol_MockUSDG.abi') as f:
    abi = json.load(f)
contract = w3.eth.contract(address=Web3.to_checksum_address(mock_usdg), abi=abi)

nonce_bytes = w3.keccak(text=secrets.token_hex(16))
msg = {
    'from': k['address'],
    'to': '0x5131c099eB615227aB2Bb8b542D4cBd622910a25',
    'value': int(0.5 * 10**6),
    'validAfter': 0,
    'validBefore': int(w3.eth.get_block('latest')['timestamp']) + 3600,
    'nonce': w3.to_hex(nonce_bytes),
}

import eth_account
signable = eth_account.messages.encode_typed_data(
    domain_data={'name': 'USDG', 'version': '2', 'chainId': 46630, 'verifyingContract': mock_usdg},
    message_types={'TransferWithAuthorization': [
        {'name': 'from', 'type': 'address'}, {'name': 'to', 'type': 'address'},
        {'name': 'value', 'type': 'uint256'}, {'name': 'validAfter', 'type': 'uint256'},
        {'name': 'validBefore', 'type': 'uint256'}, {'name': 'nonce', 'type': 'bytes32'},
    ]},
    message_data=msg,
)
signed = w3.eth.account.sign_message(signable, k['private_key'])
sig = '0x' + signed.signature.hex()

payload = {
    'from': msg['from'], 'to': msg['to'],
    'value': hex(msg['value']), 'validAfter': hex(msg['validAfter']),
    'validBefore': hex(msg['validBefore']), 'nonce': msg['nonce'], 'signature': sig,
}
requirements = {'scheme': 'exact', 'network': 'eip155:46630', 'token': 'USDG', 'amount': '0.5'}

# Check balance before
before = contract.functions.balanceOf(msg['from']).call()
print(f'Client balance before: {before / 10**6} USDG')

# Verify
resp = requests.post('http://localhost:3001/verify', json={'payload': payload, 'requirements': requirements})
print(f'Verify: {resp.json()}')

# Settle
resp2 = requests.post('http://localhost:3001/settle', json={'payload': payload, 'requirements': requirements})
print(f'Settle: {resp2.json()}')

# Check balance after
after = contract.functions.balanceOf(msg['from']).call()
print(f'Client balance after: {after / 10**6} USDG')
print(f'Transferred: {(before - after) / 10**6} USDG')