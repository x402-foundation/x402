#!/usr/bin/env python3
"""
Injects JSON-LD schema into <head> of an HTML file.
Usage: python inject_schema.py <html_file> <schema_json_file>
"""
import sys, json, re

html_file = sys.argv[1]
schema_file = sys.argv[2]

with open(html_file, 'r', encoding='utf-8') as f:
    html = f.read()

with open(schema_file, 'r') as f:
    schema = json.load(f)

schema_tag = f'<script type="application/ld+json">\n{json.dumps(schema, indent=2)}\n</script>'

# Remove any existing ld+json blocks first
html = re.sub(r'<script type="application/ld\+json">.*?</script>', '', html, flags=re.DOTALL)

# Inject before </head>
if '</head>' in html:
    html = html.replace('</head>', f'{schema_tag}\n</head>', 1)
    with open(html_file, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"✅ Schema injected into {html_file}")
else:
    print(f"⚠️  No </head> found in {html_file} — appending at top")
    html = schema_tag + '\n' + html
    with open(html_file, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"✅ Schema prepended to {html_file}")
