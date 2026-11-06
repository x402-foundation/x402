//! Real signatures: an ed25519 contract account pays, and the settlement authority is either the
//! transaction's source account (`SOURCE_ACCOUNT` credentials) or a second contract account. No
//! authorization is mocked, so the host checks signatures, nonces and expiration itself.
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl,
    crypto::Hash,
    symbol_short,
    testutils::{Events as _, Ledger as _},
    xdr::{
        self, AccountId, HashIdPreimage, HashIdPreimageSorobanAuthorization,
        HashIdPreimageSorobanAuthorizationWithAddress, InvokeContractArgs, Limits, PublicKey,
        ScAddress, ScErrorCode, ScSymbol, ScVal, SorobanAddressCredentials,
        SorobanAuthorizationEntry, SorobanAuthorizedFunction, SorobanAuthorizedInvocation,
        SorobanCredentials, Uint256, VecM, WriteXdr,
    },
    Address, Bytes, BytesN, Env, IntoVal, TryFromVal, Val, Vec,
};

use super::{auth_error, invoke_settle, test_env, Setup, EXPIRATION, FUNDED, MAX};
use crate::UptoTerms;

const PAYER_SEED: [u8; 32] = [1; 32];
const AUTHORITY_SEED: [u8; 32] = [2; 32];

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AccountError {
    NotInitialized = 1,
}

/// Minimal ed25519 contract account: one key, any context.
#[contract]
pub struct Ed25519Account;

#[contractimpl]
impl Ed25519Account {
    pub fn __constructor(env: Env, public_key: BytesN<32>) {
        env.storage()
            .instance()
            .set(&symbol_short!("pk"), &public_key);
    }
}

#[contractimpl]
impl CustomAccountInterface for Ed25519Account {
    type Signature = BytesN<64>;
    type Error = AccountError;

    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: BytesN<64>,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        let public_key: BytesN<32> = env
            .storage()
            .instance()
            .get(&symbol_short!("pk"))
            .ok_or(AccountError::NotInitialized)?;
        env.crypto()
            .ed25519_verify(&public_key, &signature_payload.into(), &signature);
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Credentials {
    V1,
    V2,
}

struct Signed {
    s: Setup,
    payer_key: SigningKey,
    authority_key: SigningKey,
}

fn sc<T: IntoVal<Env, Val>>(env: &Env, value: T) -> ScVal {
    ScVal::try_from_val(env, &value.into_val(env)).unwrap()
}

fn g_address(env: &Env, key: &SigningKey) -> Address {
    let account = ScAddress::Account(account_id(key));
    Address::try_from_val(env, &ScVal::Address(account)).unwrap()
}

fn account_id(key: &SigningKey) -> AccountId {
    AccountId(PublicKey::PublicKeyTypeEd25519(Uint256(
        key.verifying_key().to_bytes(),
    )))
}

fn invocation(
    contract: &Address,
    function: &str,
    args: std::vec::Vec<ScVal>,
    children: std::vec::Vec<SorobanAuthorizedInvocation>,
) -> SorobanAuthorizedInvocation {
    SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
            contract_address: ScAddress::from(contract),
            function_name: ScSymbol(function.try_into().unwrap()),
            args: args.try_into().unwrap(),
        }),
        sub_invocations: children.try_into().unwrap_or_else(|_| VecM::default()),
    }
}

/// Signs `invocation` for the contract account `address` with `key`, as a wallet would.
fn sign_entry(
    env: &Env,
    address: &Address,
    key: &SigningKey,
    root: SorobanAuthorizedInvocation,
    nonce: i64,
    expiration: u32,
    credentials: Credentials,
) -> SorobanAuthorizationEntry {
    let network_id = xdr::Hash(env.ledger().network_id().to_array());
    let preimage = match credentials {
        Credentials::V1 => {
            HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
                network_id,
                nonce,
                signature_expiration_ledger: expiration,
                invocation: root.clone(),
            })
        }
        Credentials::V2 => HashIdPreimage::SorobanAuthorizationWithAddress(
            HashIdPreimageSorobanAuthorizationWithAddress {
                network_id,
                nonce,
                signature_expiration_ledger: expiration,
                address: ScAddress::from(address),
                invocation: root.clone(),
            },
        ),
    };
    let payload = preimage.to_xdr(Limits::none()).unwrap();
    let digest = env
        .crypto()
        .sha256(&Bytes::from_slice(env, &payload))
        .to_array();
    let signature = BytesN::from_array(env, &key.sign(&digest).to_bytes());
    let address_credentials = SorobanAddressCredentials {
        address: ScAddress::from(address),
        nonce,
        signature_expiration_ledger: expiration,
        signature: sc(env, signature),
    };
    SorobanAuthorizationEntry {
        credentials: match credentials {
            Credentials::V1 => SorobanCredentials::Address(address_credentials),
            Credentials::V2 => SorobanCredentials::AddressV2(address_credentials),
        },
        root_invocation: root,
    }
}

impl Signed {
    /// A contract-account payer, and a `G…` authority that is the transaction source account.
    fn new() -> Self {
        let env = test_env();
        let payer_key = SigningKey::from_bytes(&PAYER_SEED);
        let authority_key = SigningKey::from_bytes(&AUTHORITY_SEED);
        let payer = env.register(
            Ed25519Account,
            (BytesN::from_array(
                &env,
                &payer_key.verifying_key().to_bytes(),
            ),),
        );
        let mut s = Setup::with_payer(env, payer);
        s.facilitator = g_address(&s.env, &authority_key);
        s.env
            .host()
            .set_source_account(account_id(&authority_key))
            .unwrap();
        Self {
            s,
            payer_key,
            authority_key,
        }
    }

    fn payer_root(&self, terms: &UptoTerms) -> SorobanAuthorizedInvocation {
        let env = &self.s.env;
        let approve = invocation(
            &terms.token,
            "approve",
            std::vec![
                sc(env, &self.s.payer),
                sc(env, &self.s.upto),
                sc(env, terms.max_amount),
                sc(env, terms.expiration_ledger),
            ],
            std::vec![],
        );
        invocation(
            &self.s.upto,
            "settle",
            std::vec![sc(env, terms.clone())],
            std::vec![approve],
        )
    }

    fn payer_entry(
        &self,
        terms: &UptoTerms,
        nonce: i64,
        credentials: Credentials,
    ) -> SorobanAuthorizationEntry {
        sign_entry(
            &self.s.env,
            &self.s.payer,
            &self.payer_key,
            self.payer_root(terms),
            nonce,
            terms.expiration_ledger,
            credentials,
        )
    }

    fn authority_root(&self, terms: &UptoTerms, amount: i128) -> SorobanAuthorizedInvocation {
        let env = &self.s.env;
        invocation(
            &self.s.upto,
            "settle",
            std::vec![
                sc(env, &self.s.payer),
                sc(env, terms.clone()),
                sc(env, amount)
            ],
            std::vec![],
        )
    }

    /// The facilitator's entry: `SOURCE_ACCOUNT` credentials, no signature and no nonce.
    fn authority_entry(&self, terms: &UptoTerms, amount: i128) -> SorobanAuthorizationEntry {
        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::SourceAccount,
            root_invocation: self.authority_root(terms, amount),
        }
    }

    fn settle(
        &self,
        entries: &[SorobanAuthorizationEntry],
        terms: &UptoTerms,
        amount: i128,
    ) -> Result<i128, soroban_sdk::Error> {
        self.s.env.set_auths(entries);
        invoke_settle(&self.s.env, &self.s.upto, &self.s.payer, terms, amount)
    }
}

#[test]
fn signed_settlement_with_source_account_authority() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let entries = [
        t.payer_entry(&terms, 42, Credentials::V1),
        t.authority_entry(&terms, 300_000),
    ];
    assert_eq!(t.settle(&entries, &terms, 300_000), Ok(300_000));
    // The authority appears in no token event: it neither pays nor receives.
    let authority = sc(&t.s.env, &t.s.facilitator);
    let token_events = t.s.env.events().all().filter_by_contract(&t.s.token);
    assert_eq!(token_events.events().len(), 2);
    for event in token_events.events() {
        let xdr::ContractEventBody::V0(body) = &event.body;
        assert!(!body.topics.contains(&authority));
        assert_ne!(body.data, authority);
    }
    assert_eq!(t.s.balance(&t.s.payer), FUNDED - 300_000);
    assert_eq!(t.s.balance(&t.s.recipient), 300_000);
}

#[test]
fn address_v2_credentials_are_accepted() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let entries = [
        t.payer_entry(&terms, 7, Credentials::V2),
        t.authority_entry(&terms, MAX),
    ];
    assert_eq!(t.settle(&entries, &terms, MAX), Ok(MAX));
}

#[test]
fn signed_zero_settlement() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let entries = [
        t.payer_entry(&terms, 1, Credentials::V1),
        t.authority_entry(&terms, 0),
    ];
    assert_eq!(t.settle(&entries, &terms, 0), Ok(0));
    assert_eq!(t.s.balance(&t.s.payer), FUNDED);
}

#[test]
fn a_second_use_of_the_same_entry_fails() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let first = [
        t.payer_entry(&terms, 42, Credentials::V1),
        t.authority_entry(&terms, 100),
    ];
    assert_eq!(t.settle(&first, &terms, 100), Ok(100));
    // Same payer entry, a fresh authority entry for a different amount.
    let replay = [first[0].clone(), t.authority_entry(&terms, 200)];
    assert_eq!(
        t.settle(&replay, &terms, 200),
        Err(auth_error(ScErrorCode::ExistingValue))
    );
    assert_eq!(t.s.balance(&t.s.payer), FUNDED - 100);
}

#[test]
fn a_zero_settlement_also_consumes_the_nonce() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let payer = t.payer_entry(&terms, 9, Credentials::V1);
    let zero = [payer.clone(), t.authority_entry(&terms, 0)];
    assert_eq!(t.settle(&zero, &terms, 0), Ok(0));
    let again = [payer, t.authority_entry(&terms, MAX)];
    assert_eq!(
        t.settle(&again, &terms, MAX),
        Err(auth_error(ScErrorCode::ExistingValue))
    );
}

#[test]
fn a_failed_settlement_does_not_consume_the_nonce() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let payer = t.payer_entry(&terms, 5, Credentials::V1);
    // Authority approved a different amount: the whole call rolls back.
    let wrong = [payer.clone(), t.authority_entry(&terms, 10)];
    assert_eq!(
        t.settle(&wrong, &terms, 20),
        Err(auth_error(ScErrorCode::InvalidAction))
    );
    let right = [payer, t.authority_entry(&terms, 20)];
    assert_eq!(t.settle(&right, &terms, 20), Ok(20));
}

#[test]
fn a_signature_over_other_terms_fails() {
    let t = Signed::new();
    let signed = t.s.terms(MAX);
    let mut called = signed.clone();
    called.max_amount = MAX * 2;
    // Present the entry as if it covered `called`: same signature, rewritten invocation.
    let mut payer = t.payer_entry(&signed, 3, Credentials::V1);
    payer.root_invocation = t.payer_root(&called);
    let entries = [payer, t.authority_entry(&called, MAX + 1)];
    assert_eq!(
        t.settle(&entries, &called, MAX + 1),
        Err(auth_error(ScErrorCode::InvalidAction))
    );
    assert_eq!(t.s.balance(&t.s.payer), FUNDED);
}

#[test]
fn a_signature_by_another_key_fails() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let entry = sign_entry(
        &t.s.env,
        &t.s.payer,
        &t.authority_key,
        t.payer_root(&terms),
        4,
        EXPIRATION,
        Credentials::V1,
    );
    let entries = [entry, t.authority_entry(&terms, 10)];
    // The account's __check_auth rejects the signature; the host reports the failed authorization.
    assert_eq!(
        t.settle(&entries, &terms, 10),
        Err(auth_error(ScErrorCode::InvalidAction))
    );
    assert_eq!(t.s.balance(&t.s.payer), FUNDED);
}

#[test]
fn an_expired_signature_fails() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let entries = [
        t.payer_entry(&terms, 8, Credentials::V1),
        t.authority_entry(&terms, 10),
    ];
    t.s.env.ledger().set_sequence_number(EXPIRATION + 1);
    assert_eq!(
        t.settle(&entries, &terms, 10),
        Err(crate::UptoError::Expired.into())
    );
}

#[test]
fn the_host_enforces_the_signature_expiration_on_its_own() {
    // A signature that expires before the terms do: the contract accepts the terms, the host
    // refuses the signature.
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let payer = sign_entry(
        &t.s.env,
        &t.s.payer,
        &t.payer_key,
        t.payer_root(&terms),
        13,
        EXPIRATION - 10,
        Credentials::V1,
    );
    let entries = [payer, t.authority_entry(&terms, 10)];
    t.s.env.ledger().set_sequence_number(EXPIRATION - 9);
    assert_eq!(
        t.settle(&entries, &terms, 10),
        Err(auth_error(ScErrorCode::InvalidInput))
    );
    assert_eq!(t.s.balance(&t.s.payer), FUNDED);
}

#[test]
fn another_source_account_cannot_act_as_the_authority() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let outsider = SigningKey::from_bytes(&[9; 32]);
    t.s.env
        .host()
        .set_source_account(account_id(&outsider))
        .unwrap();
    let entries = [
        t.payer_entry(&terms, 11, Credentials::V1),
        t.authority_entry(&terms, 10),
    ];
    assert_eq!(
        t.settle(&entries, &terms, 10),
        Err(auth_error(ScErrorCode::InvalidAction))
    );
    assert_eq!(t.s.balance(&t.s.payer), FUNDED);
}

#[test]
fn a_contract_account_authority_signs_an_address_entry() {
    let mut t = Signed::new();
    let authority = t.s.env.register(
        Ed25519Account,
        (BytesN::from_array(
            &t.s.env,
            &t.authority_key.verifying_key().to_bytes(),
        ),),
    );
    t.s.facilitator = authority.clone();
    let terms = t.s.terms(MAX);
    let authority_entry = sign_entry(
        &t.s.env,
        &authority,
        &t.authority_key,
        t.authority_root(&terms, 250),
        77,
        EXPIRATION,
        Credentials::V1,
    );
    let entries = [t.payer_entry(&terms, 12, Credentials::V1), authority_entry];
    assert_eq!(t.settle(&entries, &terms, 250), Ok(250));
}

/// Regression guard for the cost of one signed settlement. The contract is registered natively,
/// so VM instantiation is not included; the numbers move only when the contract or the SDK does.
#[test]
fn cost_of_a_signed_settlement() {
    let t = Signed::new();
    let terms = t.s.terms(MAX);
    let entries = [
        t.payer_entry(&terms, 42, Credentials::V1),
        t.authority_entry(&terms, 300_000),
    ];
    assert_eq!(t.settle(&entries, &terms, 300_000), Ok(300_000));
    let resources = t.s.env.cost_estimate().resources();
    // Ledger footprint: payer nonce, allowance and the two balances are written; the entry sizes
    // and the event size are exact for this SDK version.
    assert_eq!(resources.write_entries, 4);
    assert_eq!(resources.write_bytes, 812);
    assert_eq!(resources.disk_read_entries, 1);
    assert_eq!(resources.memory_read_entries, 7);
    assert_eq!(resources.contract_events_size_bytes, 852);
    assert_eq!(resources.temporary_entry_rent_bumps, 2);
    // CPU and memory: about 10% headroom over the measured 869,269 instructions and 81,342 bytes.
    assert!(
        resources.instructions <= 960_000,
        "instructions {}",
        resources.instructions
    );
    assert!(
        resources.mem_bytes <= 90_000,
        "memory {}",
        resources.mem_bytes
    );
}
