//! Every contract error, and the inclusive bounds of the validity window.
use soroban_sdk::{testutils::Ledger as _, Error};

use super::{Child, Setup, EXPIRATION, MAX};
use crate::UptoError;

fn contract_error(error: UptoError) -> Result<i128, Error> {
    Err(error.into())
}

#[test]
fn rejects_a_non_positive_cap() {
    let s = Setup::new();
    for max in [0_i128, -1, i128::MIN] {
        let terms = s.terms(max);
        s.authorize(&terms, Child::Exact, Some(0));
        assert_eq!(
            s.try_settle(&terms, 0),
            contract_error(UptoError::InvalidMaxAmount)
        );
    }
}

#[test]
fn rejects_a_negative_amount() {
    let s = Setup::new();
    let terms = s.terms(MAX);
    for amount in [-1_i128, i128::MIN] {
        s.authorize(&terms, Child::Exact, Some(amount));
        assert_eq!(
            s.try_settle(&terms, amount),
            contract_error(UptoError::NegativeAmount)
        );
    }
}

#[test]
fn rejects_an_amount_over_the_cap() {
    let s = Setup::new();
    let terms = s.terms(MAX);
    for amount in [MAX + 1, i128::MAX] {
        s.authorize(&terms, Child::Exact, Some(amount));
        assert_eq!(
            s.try_settle(&terms, amount),
            contract_error(UptoError::AmountExceedsMax)
        );
    }
}

#[test]
fn valid_after_ledger_is_inclusive() {
    let s = Setup::new();
    let mut terms = s.terms(MAX);
    terms.valid_after_ledger = super::START + 1;
    s.authorize(&terms, Child::Exact, Some(10));
    assert_eq!(
        s.try_settle(&terms, 10),
        contract_error(UptoError::NotYetValid)
    );

    s.env.ledger().set_sequence_number(super::START + 1);
    s.authorize(&terms, Child::Exact, Some(10));
    assert_eq!(s.try_settle(&terms, 10), Ok(10));
}

#[test]
fn expiration_ledger_is_inclusive() {
    let s = Setup::new();
    let terms = s.terms(MAX);
    s.env.ledger().set_sequence_number(EXPIRATION);
    s.authorize(&terms, Child::Exact, Some(10));
    assert_eq!(s.try_settle(&terms, 10), Ok(10));
}

#[test]
fn rejects_one_ledger_after_expiration() {
    let s = Setup::new();
    let terms = s.terms(MAX);
    s.env.ledger().set_sequence_number(EXPIRATION + 1);
    s.authorize(&terms, Child::Exact, Some(10));
    assert_eq!(s.try_settle(&terms, 10), contract_error(UptoError::Expired));
}

#[test]
fn rejects_the_contract_itself_as_recipient() {
    let s = Setup::new();
    let mut terms = s.terms(MAX);
    terms.recipient = s.upto.clone();
    s.authorize(&terms, Child::Exact, Some(10));
    assert_eq!(
        s.try_settle(&terms, 10),
        contract_error(UptoError::InvalidRecipient)
    );
}

#[test]
fn a_rejected_settlement_moves_nothing() {
    let s = Setup::new();
    let terms = s.terms(MAX);
    s.authorize(&terms, Child::Exact, Some(MAX + 1));
    assert!(s.try_settle(&terms, MAX + 1).is_err());
    assert_eq!(s.balance(&s.payer), super::FUNDED);
    assert_eq!(s.allowance(), 0);
}

#[test]
fn error_codes_are_stable() {
    assert_eq!(UptoError::InvalidMaxAmount as u32, 1);
    assert_eq!(UptoError::NegativeAmount as u32, 2);
    assert_eq!(UptoError::AmountExceedsMax as u32, 3);
    assert_eq!(UptoError::NotYetValid as u32, 4);
    assert_eq!(UptoError::Expired as u32, 5);
    assert_eq!(UptoError::InvalidRecipient as u32, 6);
}
