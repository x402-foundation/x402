"""Focused tests for Highload V3 codecs."""

from __future__ import annotations

import pytest

pytest.importorskip("pytoniq_core")

from pytoniq_core import begin_cell

from x402.mechanisms.tvm.codecs.highload_v3 import _bitmap_contains


def test_bitmap_contains_should_return_false_for_out_of_range_bit_number():
    bitmap = begin_cell().store_uint(0b101, 3).end_cell()

    assert _bitmap_contains(bitmap, 3) is False
