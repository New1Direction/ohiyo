"""Local, versioned layout registry. No model-backed extraction."""
from bs4 import BeautifulSoup
from crawl4ai.extraction_strategy import JsonCssExtractionStrategy, JsonXPathExtractionStrategy


FIELDS = ("name", "address", "displayed_price", "currency", "cancellation_text", "rating")
EXTRACT_FIELDS = FIELDS + ("latitude", "longitude", "room_types", "amenities")
REGISTRY = (
    ("shibuya-css-v1", "css", "[data-layout='shibuya-css-v1']", {
        "name": "Shibuya CSS", "baseSelector": "[data-layout='shibuya-css-v1']",
        "fields": [{"name": key, "selector": f"[data-field='{key}']", "type": "text"} for key in EXTRACT_FIELDS],
    }),
    ("shibuya-xpath-v1", "xpath", "#shibuya-xpath-v1", {
        "name": "Shibuya XPath", "baseSelector": "//article[@id='shibuya-xpath-v1']",
        "fields": [{"name": key, "selector": f".//*[@class='{key}']", "type": "text"} for key in EXTRACT_FIELDS],
    }),
)


def microdata_schema(root):
    # Standard schema.org fields, not unverified OTA-specific class guesses.
    # Prefer an explicit price range; do not arbitrarily select one of many rates.
    selectors = {"name": "[itemprop='name']", "address": "[itemprop='address']",
                 "displayed_price": "[itemprop='priceRange']", "currency": "[itemprop='priceCurrency']",
                 "rating": "[itemprop='ratingValue']", "latitude": "[itemprop='latitude']",
                 "longitude": "[itemprop='longitude']"}
    if not root.select(selectors["displayed_price"]) and len(root.select("[itemprop='price']")) == 1:
        selectors["displayed_price"] = "[itemprop='price']"
    fields = []
    for name, selector in selectors.items():
        node = root.select_one(selector)
        if node:
            fields.append({"name": name, "selector": selector,
                           **({"type": "attribute", "attribute": "content"} if node.has_attr("content") else {"type": "text"})})
    return {"name": "Schema.org lodging", "baseSelector": ":scope", "fields": fields}


def extract_hotel(url, html, fetched_at):
    soup = BeautifulSoup(html, "lxml")
    result, extraction = {}, {"path": "llm_required"}
    for schema_id, path, marker, schema in REGISTRY:
        if soup.select_one(marker):
            cls = JsonCssExtractionStrategy if path == "css" else JsonXPathExtractionStrategy
            rows = cls(schema).extract(url, html)
            result = rows[0] if rows else {}
            extraction = {"path": path, "schema_id": schema_id}
            break
    if extraction["path"] == "llm_required":
        for kind in ("Hotel", "LodgingBusiness"):
            roots = soup.select(f"[itemscope][itemtype='https://schema.org/{kind}'], [itemscope][itemtype='http://schema.org/{kind}']")
            if len(roots) != 1:
                continue  # A search/listing page is not a single hotel detail page.
            rows = JsonCssExtractionStrategy(microdata_schema(roots[0])).extract(url, str(roots[0]))
            candidate = rows[0] if rows else {}
            if candidate.get("name") and candidate.get("address"):
                result, extraction = candidate, {"path": "css", "schema_id": f"schema-org-{kind.lower()}-v1"}
                break
    try:
        rating = float(result["rating"])
        if not 0 <= rating <= 10:
            rating = None
    except (ValueError, KeyError, TypeError):
        rating = None
    coords = None
    try:
        lat, lon = float(result["latitude"]), float(result["longitude"])
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            coords = {"lat": lat, "lng": lon}
    except (ValueError, KeyError, TypeError):
        pass
    hotel = {key: result.get(key) or None for key in FIELDS}
    hotel.update(rating=rating, coords=coords,
                 room_types=[v.strip() for v in result.get("room_types", "").split(";") if v.strip()],
                 amenities=[v.strip() for v in result.get("amenities", "").split(";") if v.strip()],
                 source_url=url, fetched_at=fetched_at, advisory=True)
    return hotel, extraction
