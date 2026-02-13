"""Sales agent – interactive CLI that lets salespeople query inventory and submit orders."""

import asyncio
import os
import sys

from dotenv import load_dotenv

from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
    create_sdk_mcp_server,
)

from sales_agent.tools import ALL_TOOLS

SYSTEM_PROMPT = """\
You are a sales assistant agent. You help salespeople look up product inventory \
and place sales orders that get emailed to their CSR (customer service representative).

Your capabilities:
1. **query_inventory** – Run SQL SELECT queries against the inventory database \
   (tables: products, inventory, warehouses, categories).
2. **create_sales_order** – Build a sales order with customer name, sales rep, \
   and line items (SKU, product name, quantity, unit price).
3. **send_order_to_csr** – Email a completed sales order to the CSR for processing.

Workflow:
- First help the salesperson find the products/inventory they need.
- When they're ready to order, collect all required fields and build the order.
- Show the order summary and ask for confirmation before sending it to the CSR.
- Once confirmed, send the order via email.

Always confirm with the salesperson before sending an order. Be concise and helpful.\
"""


def _build_options() -> ClaudeAgentOptions:
    server = create_sdk_mcp_server(
        name="sales",
        version="1.0.0",
        tools=ALL_TOOLS,
    )

    return ClaudeAgentOptions(
        system_prompt=SYSTEM_PROMPT,
        mcp_servers={"sales": server},
        allowed_tools=[
            "mcp__sales__query_inventory",
            "mcp__sales__create_sales_order",
            "mcp__sales__send_order_to_csr",
        ],
        permission_mode="acceptEdits",
    )


async def run_agent() -> None:
    options = _build_options()

    async with ClaudeSDKClient(options=options) as client:
        print("Sales Agent ready. Type your request (or 'exit' to quit).\n")

        first = True
        while True:
            try:
                prompt = input("You: ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nGoodbye!")
                break

            if not prompt:
                continue
            if prompt.lower() in ("exit", "quit"):
                print("Goodbye!")
                break

            if first:
                await client.query(prompt)
                first = False
            else:
                await client.query(prompt)

            async for message in client.receive_response():
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            print(f"\nAgent: {block.text}")
                        elif isinstance(block, ToolUseBlock):
                            print(f"\n  [using {block.name}...]")
                elif isinstance(message, ResultMessage):
                    if message.is_error:
                        print(f"\n  [error: {message.result}]")

            print()  # blank line between turns


def main() -> None:
    load_dotenv()

    required_vars = ["ANTHROPIC_API_KEY", "PG_HOST", "PG_DATABASE", "PG_USER", "PG_PASSWORD"]
    missing = [v for v in required_vars if not os.environ.get(v)]
    if missing:
        print(f"Missing required environment variables: {', '.join(missing)}", file=sys.stderr)
        print("Copy .env.example to .env and fill in the values.", file=sys.stderr)
        sys.exit(1)

    asyncio.run(run_agent())


if __name__ == "__main__":
    main()
