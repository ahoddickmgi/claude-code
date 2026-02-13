"""Send sales orders to CSR via email."""

import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText


def send_order_email(order: dict, csr_email: str | None = None) -> str:
    """Format a sales order as an HTML email and send it to the CSR.

    Returns a confirmation message string.
    """
    csr_email = csr_email or os.environ["CSR_EMAIL"]
    sender = os.environ["SENDER_EMAIL"]

    subject = f"New Sales Order – {order.get('customer_name', 'Unknown')} ({order.get('order_id', 'N/A')})"

    rows_html = ""
    for item in order.get("line_items", []):
        rows_html += (
            f"<tr>"
            f"<td>{item.get('sku', '')}</td>"
            f"<td>{item.get('product_name', '')}</td>"
            f"<td style='text-align:right'>{item.get('quantity', 0)}</td>"
            f"<td style='text-align:right'>${item.get('unit_price', 0):.2f}</td>"
            f"<td style='text-align:right'>${item.get('line_total', 0):.2f}</td>"
            f"</tr>"
        )

    html = f"""\
<html><body>
<h2>Sales Order: {order.get('order_id', 'N/A')}</h2>
<p><strong>Customer:</strong> {order.get('customer_name', '')}<br>
<strong>Sales Rep:</strong> {order.get('sales_rep', '')}<br>
<strong>Date:</strong> {order.get('date', '')}<br>
<strong>Notes:</strong> {order.get('notes', 'None')}</p>
<table border="1" cellpadding="4" cellspacing="0">
<tr><th>SKU</th><th>Product</th><th>Qty</th><th>Unit Price</th><th>Line Total</th></tr>
{rows_html}
</table>
<p><strong>Order Total: ${order.get('order_total', 0):.2f}</strong></p>
</body></html>"""

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = csr_email
    msg.attach(MIMEText(html, "html"))

    with smtplib.SMTP(os.environ["SMTP_HOST"], int(os.environ.get("SMTP_PORT", 587))) as server:
        server.starttls()
        server.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
        server.sendmail(sender, [csr_email], msg.as_string())

    return f"Order {order.get('order_id')} emailed to {csr_email}."
