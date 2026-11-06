//! Successful settlements: partial, max and zero, with balances, events and authorization trees.
use soroban_sdk::{
    testutils::{
        storage::Instance as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _,
    },
    xdr, Event as _, IntoVal, Symbol,
};

use super::{Child, Setup, FUNDED, MAX, START};
use crate::{UptoSettled, UptoTerms};

fn expected_auths(
    s: &Setup,
    terms: &UptoTerms,
    amount: i128,
) -> std::vec::Vec<(soroban_sdk::Address, AuthorizedInvocation)> {
    let env = &s.env;
    let approve = AuthorizedInvocation {
        function: AuthorizedFunction::Contract((
            s.token.clone(),
            Symbol::new(env, "approve"),
            (&s.payer, &s.upto, terms.max_amount, terms.expiration_ledger).into_val(env),
        )),
        sub_invocations: std::vec![],
    };
    std::vec![
        (
            s.payer.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.upto.clone(),
                    Symbol::new(env, "settle"),
                    (terms.clone(),).into_val(env),
                )),
                sub_invocations: if amount > 0 {
                    std::vec![approve]
                } else {
                    std::vec![]
                },
            },
        ),
        (
            terms.facilitator.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.upto.clone(),
                    Symbol::new(env, "settle"),
                    (&s.payer, terms.clone(), amount).into_val(env),
                )),
                sub_invocations: std::vec![],
            },
        ),
    ]
}

fn settle_ok(amount: i128) -> Setup {
    let s = Setup::new();
    let terms = s.terms(MAX);
    s.authorize(&terms, Child::Exact, Some(amount));
    assert_eq!(s.client().settle(&s.payer, &terms, &amount), amount);
    // Read before any other call: both reflect the last top-level invocation only.
    let events = s.env.events().all();
    assert_eq!(s.env.auths(), expected_auths(&s, &terms, amount));
    assert_eq!(s.balance(&s.payer), FUNDED - amount);
    assert_eq!(s.balance(&s.recipient), amount);
    assert_eq!(s.balance(&s.upto), 0);
    assert_eq!(s.balance(&s.facilitator), 0);

    let settled = UptoSettled {
        payer: s.payer.clone(),
        recipient: s.recipient.clone(),
        token: s.token.clone(),
        amount,
        max_amount: MAX,
        facilitator: s.facilitator.clone(),
    };
    assert_eq!(
        events.filter_by_contract(&s.upto),
        [settled.to_xdr(&s.env, &s.upto)]
    );
    let token_events = events.filter_by_contract(&s.token).events().len();
    // approve + transfer for a positive amount, nothing for zero.
    assert_eq!(token_events, if amount > 0 { 2 } else { 0 });
    assert_eq!(events.events().len(), token_events + 1);
    s
}

#[test]
fn partial_amount_moves_exactly_that_amount() {
    let s = settle_ok(300_000);
    assert_eq!(s.allowance(), MAX - 300_000);
}

#[test]
fn max_amount_moves_the_cap() {
    let s = settle_ok(MAX);
    assert_eq!(s.allowance(), 0);
}

#[test]
fn smallest_positive_amount_settles() {
    settle_ok(1);
}

#[test]
fn zero_makes_no_token_calls() {
    let s = settle_ok(0);
    assert_eq!(s.allowance(), 0);
}

#[test]
fn zero_leaves_an_existing_allowance_untouched() {
    let s = Setup::new();
    let first = s.terms(MAX);
    s.authorize(&first, Child::Exact, Some(100));
    s.client().settle(&s.payer, &first, &100);
    assert_eq!(s.allowance(), MAX - 100);

    let mut second = s.terms(MAX * 2);
    second.expiration_ledger += 1;
    s.authorize(&second, Child::Exact, Some(0));
    assert_eq!(s.client().settle(&s.payer, &second, &0), 0);
    assert_eq!(s.allowance(), MAX - 100);
    assert_eq!(s.balance(&s.recipient), 100);
}

#[test]
fn contract_address_payee_receives_funds() {
    let s = Setup::new();
    let mut terms = s.terms(MAX);
    // A contract that is neither the token nor the settlement contract.
    let payee = s.env.register(crate::UptoSettlement, ());
    terms.recipient = payee.clone();
    s.authorize(&terms, Child::Exact, Some(42));
    assert_eq!(s.client().settle(&s.payer, &terms, &42), 42);
    assert_eq!(s.balance(&payee), 42);
}

#[test]
fn settle_keeps_no_state_and_does_not_touch_its_ttl() {
    let s = Setup::new();
    let ttl_before = s
        .env
        .as_contract(&s.upto, || s.env.storage().instance().get_ttl());
    for (i, amount) in [0_i128, 5, MAX].into_iter().enumerate() {
        let mut terms = s.terms(MAX);
        terms.expiration_ledger += i as u32;
        s.authorize(&terms, Child::Exact, Some(amount));
        s.client().settle(&s.payer, &terms, &amount);
    }
    s.env.as_contract(&s.upto, || {
        assert!(s.env.storage().instance().all().is_empty());
        assert_eq!(s.env.storage().instance().get_ttl(), ttl_before);
    });
    // The only ledger entry owned by the contract is its instance.
    let upto = xdr::ScAddress::from(&s.upto);
    let owned: std::vec::Vec<_> = s
        .env
        .host()
        .get_stored_entries()
        .unwrap()
        .into_iter()
        .filter_map(|(key, _)| match &*key {
            xdr::LedgerKey::ContractData(data) if data.contract == upto => Some(data.key.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(owned, [xdr::ScVal::LedgerKeyContractInstance]);
}

/// Since protocol 23 an invocation whose footprint marks an archived entry restores it
/// automatically and pays the restoration inside the same transaction. The contract cannot tell
/// the difference, so keeping the instance live (and refusing to settle while it is archived) is
/// the facilitator's job; this test pins the host behaviour that makes that necessary.
#[test]
fn an_archived_instance_is_restored_by_the_invocation_that_uses_it() {
    let s = Setup::new();
    let ttl = s
        .env
        .as_contract(&s.upto, || s.env.storage().instance().get_ttl());
    let mut terms = s.terms(MAX);
    terms.expiration_ledger = START + ttl + 10;
    s.env.ledger().set_sequence_number(START + ttl + 1);
    s.authorize(&terms, Child::Exact, Some(10));
    assert_eq!(s.try_settle(&terms, 10), Ok(10));
    let resources = s.env.cost_estimate().resources();
    // A live instance costs one disk read and four writes (see the signed cost test).
    assert!(resources.disk_read_entries > 1);
    assert!(resources.write_entries > 4);
    let restored = s
        .env
        .as_contract(&s.upto, || s.env.storage().instance().get_ttl());
    assert!(restored > 0);
}

#[test]
fn version_is_one() {
    assert_eq!(Setup::new().client().version(), 1);
}
