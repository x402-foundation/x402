//! Unit tests. `mock_auths` covers the authorization tree shapes; `signed` drives the same checks
//! through real ed25519 signatures and the host's nonce handling.
mod allowance;
mod auth;
mod errors;
mod settle;
mod signed;

use soroban_env_host::Env as _;
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Error, IntoVal, Symbol, TryFromVal, Val, Vec,
};

use crate::{UptoSettlement, UptoSettlementClient, UptoTerms};

pub(crate) const START: u32 = 1_000;
pub(crate) const EXPIRATION: u32 = START + 60;
pub(crate) const MAX: i128 = 1_000_000;
pub(crate) const FUNDED: i128 = 10_000_000;

/// The payer's `approve` child, as the contract will call it, or a deliberately different one.
#[derive(Clone)]
pub(crate) enum Child {
    Exact,
    Missing,
    Custom {
        spender: Address,
        amount: i128,
        live_until: u32,
    },
}

pub(crate) struct Setup {
    pub env: Env,
    pub upto: Address,
    pub token: Address,
    pub payer: Address,
    pub facilitator: Address,
    pub recipient: Address,
}

pub(crate) fn test_env() -> Env {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.ledger().set_sequence_number(START);
    env
}

impl Setup {
    pub fn new() -> Self {
        let env = test_env();
        let payer = Address::generate(&env);
        Self::with_payer(env, payer)
    }

    /// Deploys the contract and a Stellar Asset Contract, and funds `payer`.
    pub fn with_payer(env: Env, payer: Address) -> Self {
        let upto = env.register(UptoSettlement, ());
        let issuer = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(issuer).address();
        env.mock_all_auths();
        StellarAssetClient::new(&env, &token).mint(&payer, &FUNDED);
        let facilitator = Address::generate(&env);
        let recipient = Address::generate(&env);
        // Replace the blanket mock with an empty, enforcing authorization list.
        env.set_auths(&[]);
        Self {
            env,
            upto,
            token,
            payer,
            facilitator,
            recipient,
        }
    }

    pub fn client(&self) -> UptoSettlementClient<'_> {
        UptoSettlementClient::new(&self.env, &self.upto)
    }

    pub fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token)
    }

    pub fn terms(&self, max_amount: i128) -> UptoTerms {
        UptoTerms {
            expiration_ledger: EXPIRATION,
            facilitator: self.facilitator.clone(),
            max_amount,
            recipient: self.recipient.clone(),
            token: self.token.clone(),
            valid_after_ledger: 0,
        }
    }

    pub fn balance(&self, address: &Address) -> i128 {
        self.token().balance(address)
    }

    pub fn allowance(&self) -> i128 {
        self.token().allowance(&self.payer, &self.upto)
    }

    /// Installs mocked authorizations: the payer's tree over `signed` with `child`, and, when
    /// `facilitator_amount` is set, the facilitator's `settle(payer, signed, amount)` entry.
    pub fn authorize(&self, signed: &UptoTerms, child: Child, facilitator_amount: Option<i128>) {
        let facilitator =
            facilitator_amount.map(|amount| (signed.facilitator.clone(), signed.clone(), amount));
        self.authorize_with(signed, child, facilitator);
    }

    /// Like [`Setup::authorize`], with the second entry given as `(address, terms, amount)` for
    /// `settle(payer, terms, amount)`, which need not match the payer's terms.
    pub fn authorize_with(
        &self,
        signed: &UptoTerms,
        child: Child,
        facilitator: Option<(Address, UptoTerms, i128)>,
    ) {
        let env = &self.env;
        let children: std::vec::Vec<MockAuthInvoke> = match &child {
            Child::Exact => std::vec![MockAuthInvoke {
                contract: &signed.token,
                fn_name: "approve",
                args: (
                    &self.payer,
                    &self.upto,
                    signed.max_amount,
                    signed.expiration_ledger,
                )
                    .into_val(env),
                sub_invokes: &[],
            }],
            Child::Missing => std::vec![],
            Child::Custom {
                spender,
                amount,
                live_until,
            } => std::vec![MockAuthInvoke {
                contract: &signed.token,
                fn_name: "approve",
                args: (&self.payer, spender, *amount, *live_until).into_val(env),
                sub_invokes: &[],
            }],
        };
        let payer_root = MockAuthInvoke {
            contract: &self.upto,
            fn_name: "settle",
            args: (signed.clone(),).into_val(env),
            sub_invokes: &children,
        };
        let facilitator_root = facilitator
            .as_ref()
            .map(|(_, terms, amount)| MockAuthInvoke {
                contract: &self.upto,
                fn_name: "settle",
                args: (&self.payer, terms.clone(), *amount).into_val(env),
                sub_invokes: &[],
            });
        let mut auths = std::vec![MockAuth {
            address: &self.payer,
            invoke: &payer_root,
        }];
        if let (Some((address, _, _)), Some(invoke)) = (&facilitator, &facilitator_root) {
            auths.push(MockAuth { address, invoke });
        }
        env.mock_auths(&auths);
    }

    /// Calls `settle` and returns the settled amount or the raw error (contract or host).
    pub fn try_settle(&self, terms: &UptoTerms, amount: i128) -> Result<i128, Error> {
        invoke_settle(&self.env, &self.upto, &self.payer, terms, amount)
    }
}

/// Calls `settle` through the host directly, so the granular host error (for example
/// `Error(Auth, InvalidAction)`) is visible instead of the narrowed `try_call` error.
pub(crate) fn invoke_settle(
    env: &Env,
    upto: &Address,
    payer: &Address,
    terms: &UptoTerms,
    amount: i128,
) -> Result<i128, Error> {
    let args: Vec<Val> = (payer.clone(), terms.clone(), amount).into_val(env);
    let symbol = Symbol::new(env, "settle");
    let result = env
        .host()
        .call(upto.to_object(), symbol.to_symbol_val(), args.to_object());
    match result {
        Ok(value) => Ok(i128::try_from_val(env, &value).expect("settle returns an i128")),
        Err(error) => Err(error.error),
    }
}

pub(crate) fn auth_error(code: soroban_sdk::xdr::ScErrorCode) -> Error {
    Error::from_type_and_code(soroban_sdk::xdr::ScErrorType::Auth, code)
}
