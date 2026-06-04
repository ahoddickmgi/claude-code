import os
import webbrowser
import threading
from flask import Flask, render_template, request, jsonify
from .scraper import scrape_product
from .generator import generate_platform_content

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/generate", methods=["POST"])
def generate():
    data = request.get_json()
    url = (data or {}).get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    product = scrape_product(url)
    if product.error and not product.title:
        return jsonify({"error": product.error}), 422

    results = {
        "product": {
            "title": product.title,
            "price": product.price,
            "image_url": product.image_url,
            "url": product.url,
            "asin": product.asin,
            "scrape_warning": product.error,
        },
        "platforms": {},
    }

    for platform in ["facebook", "instagram", "tiktok"]:
        try:
            results["platforms"][platform] = generate_platform_content(product, platform)
        except Exception as e:
            results["platforms"][platform] = {"error": str(e)}

    return jsonify(results)


def _open_browser(port: int):
    webbrowser.open(f"http://127.0.0.1:{port}")


def main():
    port = int(os.environ.get("PORT", 5050))
    if os.environ.get("FLASK_ENV") != "development":
        threading.Timer(1.2, _open_browser, args=[port]).start()
    app.run(host="127.0.0.1", port=port, debug=False)


if __name__ == "__main__":
    main()
