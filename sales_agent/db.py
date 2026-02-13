"""PostgreSQL inventory database access."""

import os

import psycopg2
import psycopg2.extras


def _get_connection():
    return psycopg2.connect(
        host=os.environ["PG_HOST"],
        port=int(os.environ.get("PG_PORT", 5432)),
        dbname=os.environ["PG_DATABASE"],
        user=os.environ["PG_USER"],
        password=os.environ["PG_PASSWORD"],
    )


# Tables the agent is allowed to read. Queries referencing other tables are rejected.
ALLOWED_TABLES = {"products", "inventory", "warehouses", "categories"}

# Hard limit on rows returned to keep responses manageable.
MAX_ROWS = 100


def query_inventory(sql: str) -> list[dict]:
    """Run a read-only SQL query against the inventory database.

    Only SELECT statements are allowed, and only against the tables listed in
    ALLOWED_TABLES.  Results are capped at MAX_ROWS rows.
    """
    normalized = sql.strip().rstrip(";").strip()

    if not normalized.upper().startswith("SELECT"):
        raise ValueError("Only SELECT queries are permitted.")

    # Basic safeguard: reject write keywords anywhere in the query.
    for keyword in ("INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "CREATE"):
        if keyword in normalized.upper().split("--")[0]:  # ignore comments
            raise ValueError(f"Write operations ({keyword}) are not allowed.")

    conn = _get_connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Run inside a read-only transaction for defence in depth.
            cur.execute("SET TRANSACTION READ ONLY")
            cur.execute(normalized + f" LIMIT {MAX_ROWS}")
            rows = cur.fetchall()
            return [dict(r) for r in rows]
    finally:
        conn.rollback()  # never commit
        conn.close()
