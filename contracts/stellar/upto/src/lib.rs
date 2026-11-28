//! Settlement contract for the x402 `upto` payment scheme on Stellar.
//!
//! A payer signs a Soroban authorization entry over [`UptoTerms`] — recipient, token, cap, validity
//! window and the settlement authority — but not over the amount that is finally charged. The
//! settlement authority (the facilitator) later calls [`UptoSettlement::settle`] with the actual
//! amount, which must lie in `0..=max_amount`, and authorizes that amount itself.
//!
//! The payer's signed tree is exactly:
//!
//! ```text
//! settle(terms)                                      on this contract
//! └── approve(payer, this, max_amount, expiration_ledger)   on terms.token
//! ```
//!
//! After both authorizations succeed the contract pulls `amount` from the payer to the recipient
//! with `transfer_from`, which the token authorizes because this contract is the direct invoker.
//! A zero amount makes no token calls at all.
//!
//! Single use comes from the Soroban host: the payer's nonce is consumed when the root invocation
//! is authorized. The contract keeps no storage, has no admin and cannot be upgraded.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
    IntoVal,
};

/// The terms a payer signs. Field names are sorted, so the XDR form is an `ScMap` whose keys appear
/// in exactly this order.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UptoTerms {
    /// Last ledger (inclusive) at which the terms may be settled. Clients set it equal to the
    /// authorization entry's `signatureExpirationLedger`.
    pub expiration_ledger: u32,
    /// The only address allowed to choose the amount and submit the settlement.
    pub facilitator: Address,
    /// Upper bound on the amount, in atomic units of `token`. Must be positive.
    pub max_amount: i128,
    /// Receiver of the funds (`G…` account or `C…` contract).
    pub recipient: Address,
    /// SEP-41 token contract (a Stellar Asset Contract or a custom token).
    pub token: Address,
    /// First ledger at which the terms may be settled. Clients normally send 0.
    pub valid_after_ledger: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum UptoError {
    /// `terms.max_amount` is zero or negative.
    InvalidMaxAmount = 1,
    /// The requested amount is negative.
    NegativeAmount = 2,
    /// The requested amount is larger than `terms.max_amount`.
    AmountExceedsMax = 3,
    /// The current ledger is before `terms.valid_after_ledger`.
    NotYetValid = 4,
    /// The current ledger is after `terms.expiration_ledger`.
    Expired = 5,
    /// The recipient is this contract, which would lock the funds.
    InvalidRecipient = 6,
}

/// Emitted once per successful settlement, including zero-amount settlements.
/// Topics: `["upto_settled", payer, recipient]`; data: a map of the remaining fields.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UptoSettled {
    #[topic]
    pub payer: Address,
    #[topic]
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub max_amount: i128,
    pub facilitator: Address,
}

#[contract]
pub struct UptoSettlement;

#[contractimpl]
impl UptoSettlement {
    /// Settles `amount` (`0..=terms.max_amount`) from `payer` to `terms.recipient` and returns it.
    ///
    /// Requires the payer's authorization of `settle(terms)` with the single `approve` child
    /// described in the crate documentation, and `terms.facilitator`'s authorization of
    /// `settle(payer, terms, amount)`. Any error rolls back the whole invocation, including the
    /// payer's nonce.
    pub fn settle(
        env: Env,
        payer: Address,
        terms: UptoTerms,
        amount: i128,
    ) -> Result<i128, UptoError> {
        if terms.max_amount <= 0 {
            return Err(UptoError::InvalidMaxAmount);
        }
        if amount < 0 {
            return Err(UptoError::NegativeAmount);
        }
        if amount > terms.max_amount {
            return Err(UptoError::AmountExceedsMax);
        }
        let now = env.ledger().sequence();
        if now < terms.valid_after_ledger {
            return Err(UptoError::NotYetValid);
        }
        // Inclusive, like the host's signature expiration check.
        if now > terms.expiration_ledger {
            return Err(UptoError::Expired);
        }
        let this = env.current_contract_address();
        if terms.recipient == this {
            return Err(UptoError::InvalidRecipient);
        }

        // The payer authorizes the terms only; the host consumes the payer's nonce here.
        payer.require_auth_for_args((terms.clone(),).into_val(&env));
        // The settlement authority authorizes the actual amount: (payer, terms, amount).
        terms.facilitator.require_auth();

        if amount > 0 {
            let token = token::TokenClient::new(&env, &terms.token);
            // Signed child of the payer's tree. It overwrites any earlier allowance for this
            // contract, so a residual from a previous settlement is never spent.
            token.approve(&payer, &this, &terms.max_amount, &terms.expiration_ledger);
            // Authorized as the direct invoker; no further signature is needed.
            token.transfer_from(&this, &payer, &terms.recipient, &amount);
        }

        UptoSettled {
            payer,
            recipient: terms.recipient,
            token: terms.token,
            amount,
            max_amount: terms.max_amount,
            facilitator: terms.facilitator,
        }
        .publish(&env);
        Ok(amount)
    }

    /// Interface version of this contract.
    pub fn version(_env: Env) -> u32 {
        1
    }
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod test;
