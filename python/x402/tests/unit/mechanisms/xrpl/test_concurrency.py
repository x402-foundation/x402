"""Concurrency tests for the XRPL mechanism.

A facilitator serves parallel requests. The duplicate-settlement guard is the
only thing standing between a client and paying once for N resources, so its
behaviour under contention is a correctness property, not a performance one.
"""

from __future__ import annotations

import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from x402.mechanisms.xrpl.exact import ExactXrplFacilitatorScheme
from x402.mechanisms.xrpl.settlement_cache import SettlementCache

from .builders import make_options, make_payload, make_requirements, make_wallet, sign_payment

THREADS = 64
ROUNDS = 20
# Enough entries that expiry does real work, widening the window between
# checking membership and inserting. With a small map the whole operation fits
# inside one scheduling quantum and the race cannot be observed.
FILLER = 4000


@pytest.fixture
def contended(monkeypatch):
    """Force frequent thread switches for the duration of a test."""
    original = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    yield
    sys.setswitchinterval(original)


def _prefilled() -> SettlementCache:
    cache = SettlementCache()
    for i in range(FILLER):
        cache.is_duplicate(f"filler-{i}", 600.0)
    return cache


def _all_at_once(fn, workers: int = THREADS):
    """Run fn on every worker, released simultaneously by a barrier."""
    barrier = threading.Barrier(workers)

    def run(i):
        barrier.wait()
        return fn(i)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(run, range(workers)))


class TestSettlementCacheUnderContention:
    def test_one_key_is_admitted_exactly_once_across_threads(self, contended):
        # The GIL does not make "check membership, then insert" atomic: it can
        # release between bytecodes, so two threads can both see a key absent.
        for _ in range(ROUNDS):
            cache = _prefilled()
            results = _all_at_once(lambda _i, c=cache: c.is_duplicate("contested", 600.0))
            admitted = results.count(False)
            assert admitted == 1, f"{admitted} threads admitted the same settlement"

    def test_the_check_and_insert_run_under_the_lock(self):
        # The race test above is probabilistic: the window between testing
        # membership and inserting is a few bytecodes wide, so a run can miss
        # it. Removing the lock is a defect either way, so the invariant is
        # asserted directly and fails every run rather than most runs.
        cache = SettlementCache()
        held = []
        unguarded = cache._prune

        def spy(now: float) -> None:
            held.append(cache._lock.locked())
            unguarded(now)

        cache._prune = spy
        cache.is_duplicate("k", 60.0)
        assert held == [True], "the critical section ran without holding the lock"

    def test_distinct_keys_are_each_admitted_once(self):
        cache = SettlementCache()
        keys = [f"key-{i}" for i in range(THREADS)]
        with ThreadPoolExecutor(max_workers=THREADS) as pool:
            first = list(pool.map(lambda k: cache.is_duplicate(k, 60.0), keys))
            second = list(pool.map(lambda k: cache.is_duplicate(k, 60.0), keys))
        assert not any(first)
        assert all(second)

    def test_pruning_while_other_threads_insert_does_not_explode(self, contended):
        # Expiry iterates the mapping other threads are writing to. Unguarded
        # this raises "dictionary changed size during iteration".
        cache = _prefilled()

        def churn(i: int) -> bool:
            # Half the entries expire immediately, so every call prunes.
            return cache.is_duplicate(f"key-{i % 16}", 0.0 if i % 2 else 600.0)

        with ThreadPoolExecutor(max_workers=THREADS) as pool:
            list(pool.map(churn, range(20_000)))


class TestSettlementUnderContention:
    def test_concurrent_settles_of_one_payment_submit_once(self):
        # Submission is idempotent on the transaction hash, so a facilitator
        # that admits the same blob twice reports two successes for one payment.
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)

        submissions = []
        options = make_options()
        original = options.submit_signed_transaction

        def counting_submit(blob: str, network: str):
            submissions.append(blob)
            return original(blob, network)

        options.submit_signed_transaction = counting_submit
        scheme = ExactXrplFacilitatorScheme(options)

        with ThreadPoolExecutor(max_workers=THREADS) as pool:
            results = list(
                pool.map(lambda _i: scheme.settle(payload, requirements), range(THREADS))
            )

        successes = [r for r in results if r.success]
        assert len(successes) == 1, f"{len(successes)} concurrent settles reported success"
        assert len(submissions) == 1, f"payment submitted {len(submissions)} times"

    def test_a_shared_cache_serialises_across_scheme_instances(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        cache = SettlementCache()
        schemes = [ExactXrplFacilitatorScheme(make_options(), cache) for _ in range(THREADS)]

        with ThreadPoolExecutor(max_workers=THREADS) as pool:
            results = list(pool.map(lambda s: s.settle(payload, requirements), schemes))

        assert len([r for r in results if r.success]) == 1


class TestVerifyIsThreadSafe:
    def test_parallel_verification_agrees_with_serial_verification(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        scheme = ExactXrplFacilitatorScheme(make_options())

        expected = scheme.verify(payload, requirements).is_valid
        with ThreadPoolExecutor(max_workers=THREADS) as pool:
            results = list(
                pool.map(
                    lambda _i: scheme.verify(payload, requirements).is_valid, range(THREADS * 4)
                )
            )
        assert all(r == expected for r in results)


class TestSettlementCacheUnderLoad:
    """A client can mint distinct settlement keys cheaply (varying a
    transaction's fee by one drop changes its hash), so the guard's cost must
    not grow with the number of entries it holds."""

    def test_a_key_is_admitted_again_once_its_window_lapses(self):
        # The window, not the lazy sweep, decides: an entry past its retention
        # must read as absent even while it still sits in the mapping.
        cache = SettlementCache()
        assert cache.is_duplicate("k", 60.0, now=0.0) is False
        assert cache.is_duplicate("k", 60.0, now=0.0) is True
        assert cache.is_duplicate("k", 60.0, now=61.0) is False

    def test_expired_entries_are_actually_released(self):
        # Sweeping is deferred until the mapping doubles, so memory is released
        # in batches rather than on the first call after expiry. What must hold
        # is that it is released at all, and that the survivors are the live
        # ones.
        cache = SettlementCache()
        for i in range(4000):
            cache.is_duplicate(f"e-{i}", 10.0, now=0.0)
        for i in range(4000):
            cache.is_duplicate(f"later-{i}", 10.0, now=20.0)
        assert cache.size() <= 4200, f"{cache.size()} entries retained"
        assert cache.is_duplicate("later-0", 10.0, now=20.0) is True

    def test_one_long_lived_entry_cannot_pin_the_whole_cache(self):
        # Entries carry per-payment retention windows, so insertion order is
        # not expiry order. Any expiry that trusted it would let a single
        # long-window entry at the front hide every expired entry behind
        # it, and the cache would never release memory again. The sweep that
        # rescues it is amortised, so the guarantee is that memory tracks the
        # live set, not that it is minimal after any one call.
        cache = SettlementCache()
        cache.is_duplicate("long-lived", 10**9, now=0.0)
        for i in range(4000):
            cache.is_duplicate(f"short-{i}", 60.0, now=0.0)
        for i in range(2000):
            cache.is_duplicate(f"later-{i}", 60.0, now=10_000.0)

        # The 4000 expired entries are gone; only the long-lived one and the
        # 2000 still-live ones remain.
        assert cache.size() <= 2100, f"{cache.size()} entries survived their window"
        assert cache.is_duplicate("long-lived", 10**9, now=10_000.0) is True

    def test_a_live_entry_is_never_released_early(self):
        # Dropping an entry whose transaction can still land would re-admit the
        # duplicate the guard exists to refuse.
        cache = SettlementCache()
        cache.is_duplicate("long-lived", 600.0, now=0.0)
        for i in range(500):
            cache.is_duplicate(f"short-{i}", 1.0, now=0.0)
        cache.is_duplicate("trigger", 1.0, now=100.0)
        assert cache.is_duplicate("long-lived", 600.0, now=100.0) is True

    def test_expiry_is_amortised_rather_than_run_on_every_call(self):
        # Counted rather than timed: each sweep rebuilds the mapping, so the
        # identity of `_entries` changes exactly once per sweep, which makes
        # the count exact where a wall-clock ratio would be flaky.
        cache = SettlementCache()
        sweeps, previous = 0, id(cache._entries)
        for i in range(20_000):
            cache.is_duplicate(f"k-{i}", 3600.0, now=float(i))
            if id(cache._entries) != previous:
                sweeps += 1
                previous = id(cache._entries)

        # Doubling from the 1024 floor, 20k inserts is a handful of sweeps.
        assert sweeps <= 8, f"{sweeps} sweeps over 20,000 inserts is not amortised"
