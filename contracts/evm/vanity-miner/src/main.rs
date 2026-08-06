//! Vanity CREATE2 mining for x402 EVM contracts.
//!
//! ## Batch + deposit collectors (sequential)
//! `batch-stack` mines `x402BatchSettlement` (...0003), then `ERC3009DepositCollector` (...0004),
//! then `Permit2DepositCollector` (...0005). Collector init codes depend on the mined batch address.
//!
//! Refresh `bytecode/*.hex` after contract changes: `forge inspect <Contract> bytecode` (strip `0x`).

use rayon::prelude::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tiny_keccak::{Hasher, Keccak};

// Constants
const CREATE2_DEPLOYER: [u8; 20] = hex_literal::hex!("4e59b44847b379578588920cA78FbF26c0B4956C");
const PERMIT2: [u8; 20] = hex_literal::hex!("000000000022D473030F116dDEE9F6B43aC78BA3");

// Target patterns
const PREFIX: [u8; 2] = [0x40, 0x20]; // 0x4020
const EXACT_SUFFIX: [u8; 2] = [0x00, 0x01]; // ...0001
const UPTO_SUFFIX: [u8; 2] = [0x00, 0x02]; // ...0002
const BATCH_SUFFIX: [u8; 2] = [0x00, 0x03]; // ...0003
const ERC3009_SUFFIX: [u8; 2] = [0x00, 0x04]; // ...0004
const PERMIT2_COLLECTOR_SUFFIX: [u8; 2] = [0x00, 0x05]; // ...0005

// Creation bytecode (no constructor args) — refresh from forge when sources change
const ERC3009_CREATION_HEX: &str = include_str!("../bytecode/erc3009_creation.hex");
const PERMIT2_COLLECTOR_CREATION_HEX: &str = include_str!("../bytecode/permit2_creation.hex");

// Init code hashes: keccak256(creationCode) or keccak256(creationCode ++ abi.encode(...))
//
// IMPORTANT: The Exact hash is from the ORIGINAL build (with CBOR metadata enabled).
// Since that bytecode is already deployed, we preserve it via script/data/exact-proxy-initcode.hex.
// The Upto hash is from the current build (cbor_metadata = false, bytecode_hash = "none").
//
// x402ExactPermit2Proxy (pre-built initCode, includes CBOR metadata)
const EXACT_INIT_CODE_HASH: [u8; 32] =
    hex_literal::hex!("e774d1d5a07218946ab54efe010b300481478b86861bb17d69c98a57f68a604c");
// x402UptoPermit2Proxy (deterministic build, no CBOR metadata)
const UPTO_INIT_CODE_HASH: [u8; 32] =
    hex_literal::hex!("01575bfc9cacbf6463db62ee8867594b1657139c8493a712ef6bcefa848a20b7");
// x402BatchSettlement — keccak256(type(x402BatchSettlement).creationCode) after `forge build`
const BATCH_INIT_CODE_HASH: [u8; 32] =
    hex_literal::hex!("ed07c0a1aeb6bd4b8e28932959d66e9f2c1a2f6ebb1fd3dc5f3fbcf8135850f6");

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak::v256();
    hasher.update(data);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    out
}

/// Solidity `abi.encode(address)` — 32-byte word, address right-aligned.
fn abi_encode_address(addr: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..32].copy_from_slice(addr);
    w
}

fn parse_hex_creation(s: &str) -> Vec<u8> {
    let t = s.trim().trim_start_matches("0x");
    hex::decode(t).expect("invalid hex in bytecode file")
}

fn init_code_erc3009(settlement: &[u8; 20]) -> Vec<u8> {
    let mut v = parse_hex_creation(ERC3009_CREATION_HEX);
    v.extend_from_slice(&abi_encode_address(settlement));
    v
}

fn init_code_permit2_collector(settlement: &[u8; 20], permit2: &[u8; 20]) -> Vec<u8> {
    let mut v = parse_hex_creation(PERMIT2_COLLECTOR_CREATION_HEX);
    v.extend_from_slice(&abi_encode_address(settlement));
    v.extend_from_slice(&abi_encode_address(permit2));
    v
}

fn compute_create2_address(salt: &[u8; 32], init_code_hash: &[u8; 32]) -> [u8; 20] {
    let mut hasher = Keccak::v256();
    hasher.update(&[0xff]);
    hasher.update(&CREATE2_DEPLOYER);
    hasher.update(salt);
    hasher.update(init_code_hash);
    let mut hash = [0u8; 32];
    hasher.finalize(&mut hash);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..32]);
    addr
}

fn matches_pattern(addr: &[u8; 20], prefix: &[u8], suffix: &[u8]) -> bool {
    for (i, &b) in prefix.iter().enumerate() {
        if addr[i] != b {
            return false;
        }
    }
    let addr_len = addr.len();
    let suffix_len = suffix.len();
    for (i, &b) in suffix.iter().enumerate() {
        if addr[addr_len - suffix_len + i] != b {
            return false;
        }
    }
    true
}

fn mine_vanity(
    name: &str,
    init_code_hash: &[u8; 32],
    prefix: &[u8],
    suffix: &[u8],
) -> Option<([u8; 32], [u8; 20])> {
    println!("\n{}", "=".repeat(60));
    println!(
        "Mining for {} (0x{}...{})",
        name,
        hex::encode(prefix),
        hex::encode(suffix)
    );
    println!("Init code hash: 0x{}", hex::encode(init_code_hash));
    println!("{}", "=".repeat(60));

    let found = Arc::new(AtomicBool::new(false));
    let counter = Arc::new(AtomicU64::new(0));
    let start = Instant::now();

    let result = (0u64..u64::MAX).into_par_iter().find_map_any(|i| {
        if found.load(Ordering::Relaxed) {
            return None;
        }

        let mut salt = [0u8; 32];
        salt[24..32].copy_from_slice(&i.to_be_bytes());

        let addr = compute_create2_address(&salt, init_code_hash);

        let count = counter.fetch_add(1, Ordering::Relaxed);
        if count > 0 && count % 10_000_000 == 0 {
            let elapsed = start.elapsed().as_secs_f64();
            let rate = count as f64 / elapsed;
            println!(
                "  Progress: {} attempts ({:.0} addr/sec, {:.1}s elapsed)",
                count, rate, elapsed
            );
        }

        if matches_pattern(&addr, prefix, suffix) {
            found.store(true, Ordering::Relaxed);
            Some((salt, addr))
        } else {
            None
        }
    });

    if let Some((salt, addr)) = result {
        let elapsed = start.elapsed().as_secs_f64();
        let count = counter.load(Ordering::Relaxed);
        println!("\nFOUND MATCH!");
        println!("   Salt:    0x{}", hex::encode(salt));
        println!("   Address: 0x{}", hex::encode(addr));
        println!(
            "   Attempts: {} ({:.1}s, {:.0} addr/sec)",
            count,
            elapsed,
            count as f64 / elapsed
        );
        return Some((salt, addr));
    }

    None
}

fn parse_batch_address_from_env() -> [u8; 20] {
    let s = std::env::var("BATCH_ADDRESS").expect("Set BATCH_ADDRESS=0x... (mined batch settlement)");
    let s = s.trim().trim_start_matches("0x");
    let bytes = hex::decode(s).expect("invalid BATCH_ADDRESS hex");
    assert_eq!(bytes.len(), 20, "BATCH_ADDRESS must be 20 bytes");
    let mut a = [0u8; 20];
    a.copy_from_slice(&bytes);
    a
}

fn print_usage() {
    eprintln!(
        "\
Usage: vanity-miner <COMMAND>

  batch-stack          Mine x402BatchSettlement (...0003), ERC3009DepositCollector (...0004),
                       Permit2DepositCollector (...0005) in order. Updates bytecode/*.hex from forge when contracts change.

  batch                Mine x402BatchSettlement only (...0003)

  erc3009              Mine ERC3009DepositCollector (...0004). Requires env BATCH_ADDRESS.

  permit2-collector    Mine Permit2DepositCollector (...0005). Requires env BATCH_ADDRESS.

  exact                Mine x402ExactPermit2Proxy (...0001)
  upto                 Mine x402UptoPermit2Proxy (...0002)
  proxies              Mine exact + upto (Permit2 proxy contracts)

Legacy: some deployments used `batch` for the settlement contract alone — same as `batch` here.
"
    );
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("");

    if cmd.is_empty() || cmd == "help" || cmd == "-h" || cmd == "--help" {
        print_usage();
        std::process::exit(if cmd.is_empty() { 2 } else { 0 });
    }

    match cmd {
        "batch-stack" => run_batch_stack(),
        "batch" => {
            let r = mine_vanity(
                "x402BatchSettlement",
                &BATCH_INIT_CODE_HASH,
                &PREFIX,
                &BATCH_SUFFIX,
            );
            print_salt_output("BATCH_SALT", r);
        }
        "erc3009" => {
            let batch_addr = parse_batch_address_from_env();
            let init = init_code_erc3009(&batch_addr);
            let h = keccak256(&init);
            println!("Batch address: 0x{}", hex::encode(batch_addr));
            println!("ERC3009 full init code hash: 0x{}", hex::encode(h));
            let r = mine_vanity(
                "ERC3009DepositCollector",
                &h,
                &PREFIX,
                &ERC3009_SUFFIX,
            );
            print_salt_output("ERC3009_SALT", r);
        }
        "permit2-collector" => {
            let batch_addr = parse_batch_address_from_env();
            let init = init_code_permit2_collector(&batch_addr, &PERMIT2);
            let h = keccak256(&init);
            println!("Batch address: 0x{}", hex::encode(batch_addr));
            println!("Permit2DepositCollector full init code hash: 0x{}", hex::encode(h));
            let r = mine_vanity(
                "Permit2DepositCollector",
                &h,
                &PREFIX,
                &PERMIT2_COLLECTOR_SUFFIX,
            );
            print_salt_output("PERMIT2_COLLECTOR_SALT", r);
        }
        "exact" => {
            let r = mine_vanity(
                "x402ExactPermit2Proxy",
                &EXACT_INIT_CODE_HASH,
                &PREFIX,
                &EXACT_SUFFIX,
            );
            print_salt_output("EXACT_SALT", r);
        }
        "upto" => {
            let r = mine_vanity(
                "x402UptoPermit2Proxy",
                &UPTO_INIT_CODE_HASH,
                &PREFIX,
                &UPTO_SUFFIX,
            );
            print_salt_output("UPTO_SALT", r);
        }
        "proxies" => {
            let er = mine_vanity(
                "x402ExactPermit2Proxy",
                &EXACT_INIT_CODE_HASH,
                &PREFIX,
                &EXACT_SUFFIX,
            );
            let ur = mine_vanity(
                "x402UptoPermit2Proxy",
                &UPTO_INIT_CODE_HASH,
                &PREFIX,
                &UPTO_SUFFIX,
            );
            println!("\n{}", "=".repeat(60));
            println!("SUMMARY (proxies)");
            println!("{}", "=".repeat(60));
            if let Some((salt, addr)) = er {
                println!("\nx402ExactPermit2Proxy:");
                println!("  Salt:    0x{}", hex::encode(salt));
                println!("  Address: 0x{}", hex::encode(addr));
            }
            if let Some((salt, addr)) = ur {
                println!("\nx402UptoPermit2Proxy:");
                println!("  Salt:    0x{}", hex::encode(salt));
                println!("  Address: 0x{}", hex::encode(addr));
            }
            if let (Some((es, _)), Some((us, _))) = (er, ur) {
                println!("\n// Update deploy scripts with these values:");
                println!("bytes32 constant EXACT_SALT = 0x{};", hex::encode(es));
                println!("bytes32 constant UPTO_SALT = 0x{};", hex::encode(us));
            }
        }
        _ => {
            eprintln!("Unknown command: {cmd}\n");
            print_usage();
            std::process::exit(2);
        }
    }
}

fn run_batch_stack() {
    println!("\nx402 Vanity Miner — batch settlement + deposit collectors");
    println!("   Prefix: 0x{}", hex::encode(PREFIX));
    println!(
        "   Suffixes: batch ...{:02x}{:02x}, ERC3009 ...{:02x}{:02x}, Permit2 ...{:02x}{:02x}",
        BATCH_SUFFIX[0],
        BATCH_SUFFIX[1],
        ERC3009_SUFFIX[0],
        ERC3009_SUFFIX[1],
        PERMIT2_COLLECTOR_SUFFIX[0],
        PERMIT2_COLLECTOR_SUFFIX[1]
    );
    println!("   CREATE2 Deployer: 0x{}", hex::encode(CREATE2_DEPLOYER));
    println!("   Permit2 (ctor):   0x{}", hex::encode(PERMIT2));
    println!("   Using {} threads", rayon::current_num_threads());

    let batch_result = mine_vanity(
        "x402BatchSettlement",
        &BATCH_INIT_CODE_HASH,
        &PREFIX,
        &BATCH_SUFFIX,
    );
    let Some((batch_salt, batch_addr)) = batch_result else {
        eprintln!("batch-stack: failed to mine batch");
        std::process::exit(1);
    };

    let erc_init = init_code_erc3009(&batch_addr);
    let erc_hash = keccak256(&erc_init);
    println!(
        "\nERC3009 full init code ({} bytes), hash: 0x{}",
        erc_init.len(),
        hex::encode(erc_hash)
    );

    let erc_result = mine_vanity(
        "ERC3009DepositCollector",
        &erc_hash,
        &PREFIX,
        &ERC3009_SUFFIX,
    );
    let Some((erc_salt, erc_addr)) = erc_result else {
        eprintln!("batch-stack: failed to mine ERC3009DepositCollector");
        std::process::exit(1);
    };

    let permit_init = init_code_permit2_collector(&batch_addr, &PERMIT2);
    let permit_hash = keccak256(&permit_init);
    println!(
        "\nPermit2DepositCollector full init code ({} bytes), hash: 0x{}",
        permit_init.len(),
        hex::encode(permit_hash)
    );

    let permit_result = mine_vanity(
        "Permit2DepositCollector",
        &permit_hash,
        &PREFIX,
        &PERMIT2_COLLECTOR_SUFFIX,
    );
    let Some((permit_salt, permit_addr)) = permit_result else {
        eprintln!("batch-stack: failed to mine Permit2DepositCollector");
        std::process::exit(1);
    };

    println!("\n{}", "=".repeat(60));
    println!("SUMMARY (batch-stack)");
    println!("{}", "=".repeat(60));
    println!("\nx402BatchSettlement:");
    println!("  Salt:    0x{}", hex::encode(batch_salt));
    println!("  Address: 0x{}", hex::encode(batch_addr));
    println!("\nERC3009DepositCollector:");
    println!("  Salt:    0x{}", hex::encode(erc_salt));
    println!("  Address: 0x{}", hex::encode(erc_addr));
    println!("\nPermit2DepositCollector:");
    println!("  Salt:    0x{}", hex::encode(permit_salt));
    println!("  Address: 0x{}", hex::encode(permit_addr));

    println!("\n// Update script/DeployBatchSettlement.s.sol:");
    println!("bytes32 constant BATCH_SALT = 0x{};", hex::encode(batch_salt));
    println!("bytes32 constant ERC3009_SALT = 0x{};", hex::encode(erc_salt));
    println!(
        "bytes32 constant PERMIT2_COLLECTOR_SALT = 0x{};",
        hex::encode(permit_salt)
    );
}

fn print_salt_output(name: &str, result: Option<([u8; 32], [u8; 20])>) {
    if let Some((salt, addr)) = result {
        println!("\n// {name}:");
        println!("bytes32 constant {name} = 0x{};", hex::encode(salt));
        println!("// Address: 0x{}", hex::encode(addr));
    }
}

// Inline hex literal macro
mod hex_literal {
    macro_rules! hex {
        ($s:literal) => {{
            const LEN: usize = $s.len() / 2;
            const fn parse_hex_byte(h: u8, l: u8) -> u8 {
                let h = match h {
                    b'0'..=b'9' => h - b'0',
                    b'a'..=b'f' => h - b'a' + 10,
                    b'A'..=b'F' => h - b'A' + 10,
                    _ => panic!("invalid hex char"),
                };
                let l = match l {
                    b'0'..=b'9' => l - b'0',
                    b'a'..=b'f' => l - b'a' + 10,
                    b'A'..=b'F' => l - b'A' + 10,
                    _ => panic!("invalid hex char"),
                };
                (h << 4) | l
            }
            const fn parse_hex<const N: usize>(s: &[u8]) -> [u8; N] {
                let mut result = [0u8; N];
                let mut i = 0;
                while i < N {
                    result[i] = parse_hex_byte(s[i * 2], s[i * 2 + 1]);
                    i += 1;
                }
                result
            }
            parse_hex::<LEN>($s.as_bytes())
        }};
    }
    pub(crate) use hex;
}
