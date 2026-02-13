# Sales Agent

An interactive CLI agent that lets salespeople query inventory from a PostgreSQL database and submit sales orders to their CSR via email. Built with the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python).

## Setup

1. **Install dependencies**

```bash
pip install -e .
```

2. **Configure environment**

```bash
cp .env.example .env
# Edit .env with your credentials
```

Required variables:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `PG_HOST` / `PG_PORT` / `PG_DATABASE` / `PG_USER` / `PG_PASSWORD` | PostgreSQL connection details |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | SMTP server for outbound email |
| `CSR_EMAIL` | Default recipient email for sales orders |
| `SENDER_EMAIL` | From address on order emails |

3. **Database schema**

The agent expects these tables in your PostgreSQL database:

- `products` – product catalog (sku, name, description, price, etc.)
- `inventory` – stock levels (product_id, warehouse_id, quantity, etc.)
- `warehouses` – warehouse locations
- `categories` – product categories

## Usage

```bash
sales-agent
# or
python -m sales_agent.main
```

### Example conversation

```
You: What products do we have in the Electronics category?
  [using query_inventory...]
Agent: Here are the electronics products...

You: How much of SKU-1234 is in stock across all warehouses?
  [using query_inventory...]
Agent: SKU-1234 has 450 units total...

You: Create an order for Acme Corp, 100 units of SKU-1234 at $29.99 each. I'm John Smith.
  [using create_sales_order...]
Agent: Here's the order summary:
  Order SO-A1B2C3D4 | Acme Corp | $2,999.00
  Shall I send this to the CSR?

You: Yes, send it.
  [using send_order_to_csr...]
Agent: Order SO-A1B2C3D4 emailed to csr@example.com.
```

## Architecture

```
sales_agent/
├── main.py          # Agent loop & CLI entry point
├── tools.py         # MCP tool definitions (query, order, email)
├── db.py            # PostgreSQL read-only query runner
└── email_client.py  # SMTP email sender
```

The agent uses three custom MCP tools:

1. **query_inventory** – Read-only SQL against the inventory DB (enforces SELECT-only, read-only transaction)
2. **create_sales_order** – Builds an order object with auto-generated ID and line totals
3. **send_order_to_csr** – Formats and emails the order as HTML to the CSR
