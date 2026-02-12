#!/usr/bin/env python3
"""One-time Etsy listing sync helper.

Pulls latest items from the shop RSS feed and prints HTML snippets
for rightcolumn.html manual paste/update.
"""

from urllib.request import urlopen
import xml.etree.ElementTree as ET

RSS_URL = "https://www.etsy.com/shop/florencemaegifts/rss"


def main() -> None:
    data = urlopen(RSS_URL).read()
    root = ET.fromstring(data)
    items = root.find("channel").findall("item")[:3]

    print("Latest Etsy listings (top 3):\n")
    for idx, item in enumerate(items, start=1):
        title = (item.findtext("title") or "").replace(" by FlorenceMaeGifts", "")
        link = item.findtext("link") or ""
        desc = item.findtext("description") or ""

        # image URL is present in the description HTML as src="..."
        img = ""
        marker = 'src="'
        if marker in desc:
            img = desc.split(marker, 1)[1].split('"', 1)[0]

        print(f"{idx}. {title}")
        print(f"   link: {link}")
        if img:
            print(f"   img:  {img}")
        print()


if __name__ == "__main__":
    main()
