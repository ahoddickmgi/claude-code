"""Custom MCP tools exposed to the sales agent."""

import json
import uuid
from datetime import date
from typing import Any

from claude_agent_sdk import tool

from sales_agent.db import query_inventory as _run_query
from sales_agent.email_client import send_order_email


# ── Inventory lookup ────────────────────────────────────────────────

@tool(
    "query_inventory",
    (
        "Run a read-only SQL SELECT against the inventory database and return the results. "
        "Only the following tables are available: products, inventory, warehouses, categories. "
        "Returns up to 100 rows as a JSON array of objects."
    ),
    {
        "type": "object",
        "properties": {
            "sql": {
                "type": "string",
                "description": "A SELECT query to run against the inventory database.",
            },
        },
        "required": ["sql"],
    },
)
async def query_inventory_tool(args: dict[str, Any]) -> dict[str, Any]:
    try:
        rows = _run_query(args["sql"])
        text = json.dumps(rows, default=str, indent=2)
        return {"content": [{"type": "text", "text": text}]}
    except Exception as exc:
        return {
            "content": [{"type": "text", "text": f"Query error: {exc}"}],
            "is_error": True,
        }


# ── Sales order creation ────────────────────────────────────────────

@tool(
    "create_sales_order",
    (
        "Build a sales order object from the provided fields. "
        "Returns the complete order as JSON so it can be reviewed before sending."
    ),
    {
        "type": "object",
        "properties": {
            "customer_name": {
                "type": "string",
                "description": "Full name of the customer.",
            },
            "sales_rep": {
                "type": "string",
                "description": "Name of the salesperson creating the order.",
            },
            "line_items": {
                "type": "array",
                "description": "List of items in the order.",
                "items": {
                    "type": "object",
                    "properties": {
                        "sku": {"type": "string"},
                        "product_name": {"type": "string"},
                        "quantity": {"type": "integer"},
                        "unit_price": {"type": "number"},
                    },
                    "required": ["sku", "product_name", "quantity", "unit_price"],
                },
            },
            "notes": {
                "type": "string",
                "description": "Optional notes for the CSR.",
            },
        },
        "required": ["customer_name", "sales_rep", "line_items"],
    },
)
async def create_sales_order_tool(args: dict[str, Any]) -> dict[str, Any]:
    line_items = args["line_items"]
    for item in line_items:
        item["line_total"] = round(item["quantity"] * item["unit_price"], 2)

    order = {
        "order_id": f"SO-{uuid.uuid4().hex[:8].upper()}",
        "date": date.today().isoformat(),
        "customer_name": args["customer_name"],
        "sales_rep": args["sales_rep"],
        "line_items": line_items,
        "notes": args.get("notes", ""),
        "order_total": round(sum(i["line_total"] for i in line_items), 2),
    }

    text = json.dumps(order, indent=2)
    return {"content": [{"type": "text", "text": text}]}


# ── Send order to CSR via email ─────────────────────────────────────

@tool(
    "send_order_to_csr",
    (
        "Email a completed sales order to the CSR. "
        "Pass the full order JSON object (as returned by create_sales_order)."
    ),
    {
        "type": "object",
        "properties": {
            "order": {
                "type": "object",
                "description": "The complete sales order object to send.",
            },
            "csr_email": {
                "type": "string",
                "description": "Optional override for the CSR email address. Uses CSR_EMAIL env var by default.",
            },
        },
        "required": ["order"],
    },
)
async def send_order_to_csr_tool(args: dict[str, Any]) -> dict[str, Any]:
    try:
        result = send_order_email(args["order"], csr_email=args.get("csr_email"))
        return {"content": [{"type": "text", "text": result}]}
    except Exception as exc:
        return {
            "content": [{"type": "text", "text": f"Email error: {exc}"}],
            "is_error": True,
        }


ALL_TOOLS = [query_inventory_tool, create_sales_order_tool, send_order_to_csr_tool]
