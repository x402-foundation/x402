"""Atomic, restart-durable consumption of Lightning payment proofs."""

import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Protocol


class ReplayStore(Protocol):
    def consume(self, key: str, retain_until: int) -> bool:
        """Atomically insert an unused key and retain it through retain_until."""
        ...


class SQLiteReplayStore:
    """Use one shared database file for all instances settling a receiver's invoices."""

    def __init__(self, path: str | Path) -> None:
        if str(path) in ("", ":memory:") or str(path).startswith("file:"):
            raise ValueError("Lightning requires a persistent SQLite file")
        self.path = Path(path).resolve()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS x402_lightning_consumed "
                "(key TEXT PRIMARY KEY, retain_until INTEGER NOT NULL)"
            )

    def consume(self, key: str, retain_until: int) -> bool:
        with closing(sqlite3.connect(self.path)) as connection, connection:
            cursor = connection.execute(
                "INSERT OR IGNORE INTO x402_lightning_consumed (key, retain_until) VALUES (?, ?)",
                (key, retain_until),
            )
            return cursor.rowcount == 1
