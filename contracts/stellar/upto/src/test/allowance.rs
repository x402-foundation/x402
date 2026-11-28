//! The allowance left after a partial settlement cannot be spent by anyone else, and the next
//! settlement overwrites it instead of adding to it.
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, testutils::Ledger as _, token::TokenClient,
    Address, Env,
};

use super::{Child, Setup, FUNDED, MAX};

/// Tries to spend the payer's allowance from another contract.
#[contract]
pub struct Spender;

#[contractimpl]
impl Spender {
    /// Spends as `spender`, which only works when `spender` is this contract.
    pub fn spend(env: Env, token: Address, spender: Address, from: Address, to: Address) {
        TokenClient::new(&env, &token).transfer_from(&spender, &from, &to, &1);
    }
}

fn after_partial() -> Setup {
    let s = Setup::new();
    let terms = s.terms(MAX);
    s.authorize(&terms, Child::Exact, Some(400_000));
    s.client().settle(&s.payer, &terms, &400_000);
    assert_eq!(s.allowance(), MAX - 400_000);
    s
}

#[test]
fn nobody_can_spend_the_residual_directly() {
    let s = after_partial();
    let thief = Address::generate(&s.env);
    s.env.set_auths(&[]);
    assert!(s
        .token()
        .try_transfer_from(&s.upto, &s.payer, &thief, &1)
        .is_err());
    assert_eq!(s.balance(&s.payer), FUNDED - 400_000);
}

#[test]
fn another_contract_cannot_spend_the_residual() {
    let s = after_partial();
    let spender = s.env.register(Spender, ());
    let client = SpenderClient::new(&s.env, &spender);
    s.env.set_auths(&[]);
    // As itself it has no allowance; as the settlement contract it is not the direct invoker.
    assert!(client
        .try_spend(&s.token, &spender, &s.payer, &spender)
        .is_err());
    assert!(client
        .try_spend(&s.token, &s.upto, &s.payer, &spender)
        .is_err());
    assert_eq!(s.balance(&spender), 0);
    assert_eq!(s.balance(&s.payer), FUNDED - 400_000);
}

#[test]
fn the_next_settlement_overwrites_the_residual() {
    let s = after_partial();
    let mut next = s.terms(250_000);
    next.expiration_ledger += 10;
    s.authorize(&next, Child::Exact, Some(50_000));
    s.client().settle(&s.payer, &next, &50_000);
    assert_eq!(s.allowance(), 200_000);
    assert_eq!(s.balance(&s.payer), FUNDED - 450_000);
}

#[test]
fn the_residual_expires_with_the_terms() {
    let s = after_partial();
    s.env.ledger().set_sequence_number(super::EXPIRATION + 1);
    assert_eq!(s.allowance(), 0);
}
