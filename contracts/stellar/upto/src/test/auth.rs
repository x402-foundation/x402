//! Authorization-tree shapes: the facilitator binding, mutated terms and the approve child.
use soroban_sdk::{testutils::Address as _, xdr::ScErrorCode, Address};

use super::{auth_error, Child, Setup, EXPIRATION, FUNDED, MAX};

fn assert_rejected(s: &Setup, result: Result<i128, soroban_sdk::Error>) {
    assert_eq!(result, Err(auth_error(ScErrorCode::InvalidAction)));
    assert_eq!(s.balance(&s.payer), FUNDED);
    assert_eq!(s.balance(&s.recipient), 0);
}

#[test]
fn missing_facilitator_authorization_is_rejected() {
    let s = Setup::new();
    let terms = s.terms(MAX);
    s.authorize(&terms, Child::Exact, None);
    assert_rejected(&s, s.try_settle(&terms, 10));
}

#[test]
fn missing_facilitator_authorization_is_rejected_for_zero() {
    let s = Setup::new();
    let terms = s.terms(MAX);
    s.authorize(&terms, Child::Exact, None);
    assert_rejected(&s, s.try_settle(&terms, 0));
}

#[test]
fn facilitator_authorization_for_another_amount_is_rejected() {
    let s = Setup::new();
    let terms = s.terms(MAX);
    s.authorize(&terms, Child::Exact, Some(300_000));
    assert_rejected(&s, s.try_settle(&terms, 400_000));
}

#[test]
fn a_different_submitter_cannot_settle() {
    // An outsider holding the payer's entry authorizes the call as itself instead of F.
    let s = Setup::new();
    let signed = s.terms(MAX);
    let outsider = Address::generate(&s.env);
    s.authorize_with(
        &signed,
        Child::Exact,
        Some((outsider.clone(), signed.clone(), 10)),
    );
    assert_rejected(&s, s.try_settle(&signed, 10));

    // Swapping itself into the terms breaks the payer's signature instead.
    let mut swapped = signed.clone();
    swapped.facilitator = outsider.clone();
    s.authorize_with(&signed, Child::Exact, Some((outsider, swapped.clone(), 10)));
    assert_rejected(&s, s.try_settle(&swapped, 10));
}

#[test]
fn mutated_terms_are_rejected() {
    let s = Setup::new();
    let signed = s.terms(MAX);
    let other = Address::generate(&s.env);
    let mut mutations = std::vec::Vec::new();
    let mut t = signed.clone();
    t.recipient = other.clone();
    mutations.push(t);
    let mut t = signed.clone();
    t.max_amount = MAX + 1;
    mutations.push(t);
    let mut t = signed.clone();
    t.expiration_ledger = EXPIRATION - 1;
    mutations.push(t);
    let mut t = signed.clone();
    t.valid_after_ledger = 1;
    mutations.push(t);
    let mut t = signed.clone();
    t.token = s
        .env
        .register_stellar_asset_contract_v2(other.clone())
        .address();
    mutations.push(t);
    let mut t = signed.clone();
    t.facilitator = other.clone();
    mutations.push(t);
    for called in mutations {
        // The authority approves exactly what is called; only the payer's terms differ.
        s.authorize_with(
            &signed,
            Child::Exact,
            Some((called.facilitator.clone(), called.clone(), 10)),
        );
        assert_rejected(&s, s.try_settle(&called, 10));
    }
}

#[test]
fn missing_child_is_rejected_for_a_positive_amount() {
    let s = Setup::new();
    let terms = s.terms(MAX);
    s.authorize(&terms, Child::Missing, Some(10));
    assert_rejected(&s, s.try_settle(&terms, 10));
}

#[test]
fn missing_child_is_accepted_for_zero() {
    // A zero settlement makes no token calls, so the payer's tree needs no approve child. The
    // facilitator still requires the full tree; this documents the contract-level behavior.
    let s = Setup::new();
    let terms = s.terms(MAX);
    s.authorize(&terms, Child::Missing, Some(0));
    assert_eq!(s.try_settle(&terms, 0), Ok(0));
}

#[test]
fn a_child_with_other_arguments_is_rejected() {
    let s = Setup::new();
    let terms = s.terms(MAX);
    let other = Address::generate(&s.env);
    let variants = [
        Child::Custom {
            spender: s.upto.clone(),
            amount: MAX - 1,
            live_until: EXPIRATION,
        },
        Child::Custom {
            spender: s.upto.clone(),
            amount: MAX + 1,
            live_until: EXPIRATION,
        },
        Child::Custom {
            spender: other,
            amount: MAX,
            live_until: EXPIRATION,
        },
        Child::Custom {
            spender: s.upto.clone(),
            amount: MAX,
            live_until: EXPIRATION + 1,
        },
    ];
    for child in variants {
        s.authorize(&terms, child, Some(10));
        assert_rejected(&s, s.try_settle(&terms, 10));
    }
}
