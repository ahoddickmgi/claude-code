import os
import anthropic
from .scraper import ProductInfo


_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _client


PLATFORM_INSTRUCTIONS = {
    "facebook": {
        "tone": "friendly, conversational, slightly longer posts work well",
        "caption_len": "150–250 words",
        "hashtags": "5–10 hashtags",
        "script_format": "A short video script (30–60 seconds) for a Facebook Reel or video post",
    },
    "instagram": {
        "tone": "aspirational, visually descriptive, energetic",
        "caption_len": "100–150 words",
        "hashtags": "20–25 hashtags",
        "script_format": "A Reel script (15–30 seconds), punchy and hook-first",
    },
    "tiktok": {
        "tone": "casual, direct, entertaining, Gen-Z friendly",
        "caption_len": "50–80 words",
        "hashtags": "5–7 trending hashtags",
        "script_format": "A TikTok video script (15–45 seconds) with hook, demo, and CTA",
    },
}


def _product_summary(product: ProductInfo) -> str:
    parts = [f"Product: {product.title}"]
    if product.price:
        parts.append(f"Price: {product.price}")
    if product.features:
        parts.append("Key features:\n" + "\n".join(f"- {f}" for f in product.features))
    if product.description:
        parts.append(f"Description: {product.description}")
    parts.append(f"Affiliate link: {product.url}")
    return "\n".join(parts)


def _call_claude(system: str, user: str) -> str:
    client = _get_client()
    msg = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return msg.content[0].text


def generate_platform_content(product: ProductInfo, platform: str) -> dict:
    """Return a dict with keys: caption, content_ideas, image_suggestions, script."""
    pi = PLATFORM_INSTRUCTIONS[platform]
    product_summary = _product_summary(product)

    system = (
        f"You are a social media marketing expert specialising in {platform.capitalize()} affiliate marketing. "
        f"Your tone is {pi['tone']}. Always include the affiliate link naturally in the caption."
    )

    prompt = f"""Here is the product information:

{product_summary}

Generate all four of the following for a {platform.capitalize()} affiliate post.
Return your response in exactly this format with these exact section headers:

## CAPTION
Write a {pi['caption_len']} caption with {pi['hashtags']}. Include the affiliate link.

## CONTENT IDEAS
List 4 specific content ideas (photo, carousel, video concepts) that would work well for this product on {platform.capitalize()}.

## IMAGE SUGGESTIONS
Describe 4 specific image or graphic ideas (scene, props, styling, mood) that would make compelling visuals for this product.

## SCRIPT
{pi['script_format']}. Include a strong opening hook, key selling points, and a clear call-to-action with the affiliate link."""

    raw = _call_claude(system, prompt)
    return _parse_sections(raw)


def _parse_sections(text: str) -> dict:
    sections = {"caption": "", "content_ideas": "", "image_suggestions": "", "script": ""}
    keys = {
        "## CAPTION": "caption",
        "## CONTENT IDEAS": "content_ideas",
        "## IMAGE SUGGESTIONS": "image_suggestions",
        "## SCRIPT": "script",
    }

    current_key = None
    buf: list[str] = []

    for line in text.splitlines():
        header = line.strip()
        if header in keys:
            if current_key and buf:
                sections[current_key] = "\n".join(buf).strip()
            current_key = keys[header]
            buf = []
        else:
            if current_key:
                buf.append(line)

    if current_key and buf:
        sections[current_key] = "\n".join(buf).strip()

    return sections
