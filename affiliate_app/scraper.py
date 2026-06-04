import re
import requests
from bs4 import BeautifulSoup
from dataclasses import dataclass, field


@dataclass
class ProductInfo:
    title: str = ""
    price: str = ""
    description: str = ""
    features: list[str] = field(default_factory=list)
    image_url: str = ""
    asin: str = ""
    url: str = ""
    error: str = ""


HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def _extract_asin(url: str) -> str:
    match = re.search(r"/dp/([A-Z0-9]{10})", url)
    if match:
        return match.group(1)
    match = re.search(r"[?&]asin=([A-Z0-9]{10})", url)
    return match.group(1) if match else ""


def _resolve_url(url: str) -> str:
    """Follow redirects and return the final URL (handles short affiliate links)."""
    try:
        r = requests.head(url, headers=HEADERS, allow_redirects=True, timeout=10)
        return r.url
    except Exception:
        return url


def scrape_product(url: str) -> ProductInfo:
    info = ProductInfo(url=url)

    try:
        final_url = _resolve_url(url)
        info.url = final_url
        info.asin = _extract_asin(final_url)

        resp = requests.get(final_url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        # Title
        title_el = soup.select_one("#productTitle")
        if title_el:
            info.title = title_el.get_text(strip=True)

        # Price
        for selector in [
            "span.a-price .a-offscreen",
            "#priceblock_ourprice",
            "#priceblock_dealprice",
            ".a-price .a-offscreen",
        ]:
            price_el = soup.select_one(selector)
            if price_el:
                info.price = price_el.get_text(strip=True)
                break

        # Main image
        img_el = soup.select_one("#landingImage, #imgBlkFront, #main-image")
        if img_el:
            info.image_url = img_el.get("src") or img_el.get("data-src", "")

        # Feature bullets
        bullets = soup.select("#feature-bullets .a-list-item")
        info.features = [b.get_text(strip=True) for b in bullets if b.get_text(strip=True)][:6]

        # Short description fallback
        desc_el = soup.select_one("#productDescription p, #productDescription")
        if desc_el:
            info.description = desc_el.get_text(strip=True)[:500]

        if not info.title:
            info.error = "Could not extract product title — Amazon may have blocked the request."

    except requests.HTTPError as e:
        info.error = f"HTTP error fetching product page: {e}"
    except Exception as e:
        info.error = f"Unexpected error: {e}"

    return info
