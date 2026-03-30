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

// Init code hashes (computed from contracts - no constructor args for chain portability)
// Run `forge script script/ComputeAddress.s.sol` to verify these match
// x402ExactPermit2Proxy
const EXACT_INIT_CODE_HASH: [u8; 32] =
    hex_literal::hex!("e774d1d5a07218946ab54efe010b300481478b86861bb17d69c98a57f68a604c");
// x402UptoPermit2Proxy
const UPTO_INIT_CODE_HASH: [u8; 32] =
    hex_literal::hex!("b956a3d1d040d7b587f0dc6e8145368a5501bac459a111e73a4954ada577673b");

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
    // Check prefix
    for (i, &b) in prefix.iter().enumerate() {
        if addr[i] != b {
            return false;
        }
    }
    // Check suffix
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
    println!("Mining for {} (0x{}...{})", name, hex::encode(prefix), hex::encode(suffix));
    println!("Init code hash: 0x{}", hex::encode(init_code_hash));
    println!("{}", "=".repeat(60));

    let found = Arc::new(AtomicBool::new(false));
    let counter = Arc::new(AtomicU64::new(0));
    let start = Instant::now();

    // Use parallel iteration with rayon
    let result = (0u64..u64::MAX)
        .into_par_iter()
        .find_map_any(|i| {
            if found.load(Ordering::Relaxed) {
                return None;
            }

            // Generate salt from counter
            let mut salt = [0u8; 32];
            salt[24..32].copy_from_slice(&i.to_be_bytes());

            let addr = compute_create2_address(&salt, init_code_hash);

            // Update counter for progress
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
        println!("\n✅ FOUND MATCH!");
        println!("   Salt:    0x{}", hex::encode(salt));
        println!("   Address: 0x{}", hex::encode(addr));
        println!("   Attempts: {} ({:.1}s, {:.0} addr/sec)", count, elapsed, count as f64 / elapsed);
        return Some((salt, addr));
    }

    None
}

fn main() {
    println!("\n🔍 x402 Vanity Address Miner (Rust)");
    println!("   Prefix: 0x{}", hex::encode(PREFIX));
    println!("   Exact suffix: 0x{}", hex::encode(EXACT_SUFFIX));
    println!("   Upto suffix: 0x{}", hex::encode(UPTO_SUFFIX));
    println!("   CREATE2 Deployer: 0x{}", hex::encode(CREATE2_DEPLOYER));

    // Get number of threads
    let num_threads = rayon::current_num_threads();
    println!("   Using {} threads", num_threads);

    // Mine for Exact contract
    let exact_result = mine_vanity("x402ExactPermit2Proxy", &EXACT_INIT_CODE_HASH, &PREFIX, &EXACT_SUFFIX);

    // Mine for Upto contract  
    let upto_result = mine_vanity("x402UptoPermit2Proxy", &UPTO_INIT_CODE_HASH, &PREFIX, &UPTO_SUFFIX);

    // Summary
    println!("\n{}", "=".repeat(60));
    println!("SUMMARY");
    println!("{}", "=".repeat(60));

    if let Some((salt, addr)) = exact_result {
        println!("\nx402ExactPermit2Proxy:");
        println!("  Salt:    0x{}", hex::encode(salt));
        println!("  Address: 0x{}", hex::encode(addr));
    }

    if let Some((salt, addr)) = upto_result {
        println!("\nx402UptoPermit2Proxy:");
        println!("  Salt:    0x{}", hex::encode(salt));
        println!("  Address: 0x{}", hex::encode(addr));
    }

    if exact_result.is_some() && upto_result.is_some() {
        let (exact_salt, _) = exact_result.unwrap();
        let (upto_salt, _) = upto_result.unwrap();
        println!("\n// Update Deploy.s.sol with these values:");
        println!("bytes32 constant EXACT_SALT = 0x{};", hex::encode(exact_salt));
        println!("bytes32 constant UPTO_SALT = 0x{};", hex::encode(upto_salt));
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
