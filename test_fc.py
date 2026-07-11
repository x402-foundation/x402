import json, requests, sys

resp = requests.post("https://api.firecrawl.dev/v1/scrape",
    headers={"Authorization": "Bearer ***",
             "Content-Type": "application/json"},
    json={"url": "https://wttr.in/Tokyo?format=j1", "formats": ["rawHtml"], "onlyMainContent": False})
d = resp.json()
print("success:", d.get("success"))
print("error:", d.get("error", ""))
if d.get("data"):
    print("data keys:", list(d["data"].keys()))
    print("rawHtml[:100]:", str(d["data"].get("rawHtml", ""))[:100])