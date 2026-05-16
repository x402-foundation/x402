use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("x402EscrowProgramIdReplaceAfterDeploy1111111");

/// x402 Solana Escrow Program
/// Mirrors the EVM escrow pattern — USDC locked in PDA vault,
/// released to receiver on delivery or refunded to principal on timeout.
#[program]
pub mod x402_escrow {
    use super::*;

    /// Lock USDC into a PDA vault. Called by the paying agent when sending
    /// an x402 payment with chainType = "solana".
    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        escrow_id: [u8; 32],
        amount: u64,
        deadline: i64,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        escrow.principal      = ctx.accounts.principal.key();
        escrow.receiver       = ctx.accounts.receiver.key();
        escrow.amount         = amount;
        escrow.deadline       = deadline;
        escrow.is_released    = false;
        escrow.is_refunded    = false;
        escrow.escrow_id      = escrow_id;
        escrow.bump           = ctx.bumps.escrow;

        // Transfer USDC from principal's ATA to PDA vault
        let cpi_accounts = Transfer {
            from:      ctx.accounts.principal_token.to_account_info(),
            to:        ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.principal.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(EscrowInitialized {
            escrow_id,
            principal: escrow.principal,
            receiver:  escrow.receiver,
            amount,
            deadline,
        });
        Ok(())
    }

    /// Release USDC to receiver — called by the receiving agent after
    /// confirming service delivery. Must be before deadline.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(!escrow.is_released, EscrowError::AlreadyReleased);
        require!(!escrow.is_refunded, EscrowError::AlreadyRefunded);
        require!(
            Clock::get()?.unix_timestamp < escrow.deadline,
            EscrowError::DeadlinePassed
        );

        let escrow_id = escrow.escrow_id;
        let bump      = escrow.bump;
        let amount    = escrow.amount;

        let seeds  = &[b"escrow".as_ref(), escrow_id.as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from:      ctx.accounts.vault.to_account_info(),
            to:        ctx.accounts.receiver_token.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, amount)?;

        ctx.accounts.escrow.is_released = true;

        emit!(EscrowReleased {
            escrow_id,
            receiver: ctx.accounts.escrow.receiver,
            amount,
        });
        Ok(())
    }

    /// Refund USDC to principal — callable by anyone after deadline passes.
    /// Protects paying agent from funds being stuck forever.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(!escrow.is_released, EscrowError::AlreadyReleased);
        require!(!escrow.is_refunded, EscrowError::AlreadyRefunded);
        require!(
            Clock::get()?.unix_timestamp >= escrow.deadline,
            EscrowError::DeadlineNotReached
        );

        let escrow_id = escrow.escrow_id;
        let bump      = escrow.bump;
        let amount    = escrow.amount;

        let seeds  = &[b"escrow".as_ref(), escrow_id.as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from:      ctx.accounts.vault.to_account_info(),
            to:        ctx.accounts.principal_token.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, amount)?;

        ctx.accounts.escrow.is_refunded = true;

        emit!(EscrowRefunded {
            escrow_id,
            principal: ctx.accounts.escrow.principal,
            amount,
        });
        Ok(())
    }

    /// Emergency close — returns remaining rent lamports to principal.
    /// Only callable after release or refund.
    pub fn close_escrow(_ctx: Context<CloseEscrow>) -> Result<()> {
        Ok(()) // account close handled by anchor constraint
    }
}

// ── Account Structs ──────────────────────────────────────────────────────────

#[account]
pub struct Escrow {
    pub principal:   Pubkey,   // 32
    pub receiver:    Pubkey,   // 32
    pub amount:      u64,      //  8
    pub deadline:    i64,      //  8
    pub is_released: bool,     //  1
    pub is_refunded: bool,     //  1
    pub escrow_id:   [u8; 32], // 32
    pub bump:        u8,       //  1
    // total: 115 + 8 (discriminator) = 123 bytes
}

// ── Contexts ─────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(escrow_id: [u8; 32])]
pub struct InitializeEscrow<'info> {
    #[account(mut)]
    pub principal: Signer<'info>,

    /// CHECK: receiver pubkey — validated off-chain via x402 grant
    pub receiver: UncheckedAccount<'info>,

    #[account(
        init,
        payer = principal,
        space = 8 + 32 + 32 + 8 + 8 + 1 + 1 + 32 + 1,
        seeds = [b"escrow", escrow_id.as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(mut, token::mint = usdc_mint, token::authority = principal)]
    pub principal_token: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = principal,
        token::mint = usdc_mint,
        token::authority = escrow,
        seeds = [b"vault", escrow_id.as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: USDC mint — EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
    pub usdc_mint: UncheckedAccount<'info>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent:           Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut, has_one = receiver)]
    pub escrow: Account<'info, Escrow>,

    pub receiver: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", escrow.escrow_id.as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, token::authority = receiver)]
    pub receiver_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut, has_one = principal)]
    pub escrow: Account<'info, Escrow>,

    /// CHECK: anyone can call refund after deadline
    pub principal: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"vault", escrow.escrow_id.as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, token::authority = escrow.principal)]
    pub principal_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseEscrow<'info> {
    #[account(
        mut,
        has_one = principal,
        close = principal,
        constraint = escrow.is_released || escrow.is_refunded
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(mut)]
    pub principal: Signer<'info>,
}

// ── Events ───────────────────────────────────────────────────────────────────

#[event]
pub struct EscrowInitialized {
    pub escrow_id: [u8; 32],
    pub principal: Pubkey,
    pub receiver:  Pubkey,
    pub amount:    u64,
    pub deadline:  i64,
}

#[event]
pub struct EscrowReleased {
    pub escrow_id: [u8; 32],
    pub receiver:  Pubkey,
    pub amount:    u64,
}

#[event]
pub struct EscrowRefunded {
    pub escrow_id: [u8; 32],
    pub principal: Pubkey,
    pub amount:    u64,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum EscrowError {
    #[msg("Escrow already released to receiver")]
    AlreadyReleased,
    #[msg("Escrow already refunded to principal")]
    AlreadyRefunded,
    #[msg("Deadline has passed — cannot release, call refund instead")]
    DeadlinePassed,
    #[msg("Deadline not yet reached — cannot refund, call release or wait")]
    DeadlineNotReached,
}
