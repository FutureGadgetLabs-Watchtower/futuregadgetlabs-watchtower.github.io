# Brand assets

The icons in `public/` come from the Future Gadget Labs brand kit (Google Drive, `tools/fglbrand.py`),
the same generator that made the PolyEdge and FG-Collect sets. Watchtower is an internal site, so it
follows the kit's rule for those: the FG slab stays navy and white, and only the label band changes.

- Band colour: `#A21CAF` (magenta). White contrast 6.3:1; picked to stay clear of the other bands
  (Collectibles blue, Crypto teal, Services violet, Admin amber, Support green, PolyEdge rose,
  CryptoLabs indigo) at 16 px in a tab strip.
- On navy, the kit uses the band's tint, `#C572CD`. That is `--color-band` in `src/index.css`
  (the strip along the top of the header) and the band in `public/mark-dark.svg`.

To regenerate or change the colour, from the brand kit folder:

```bash
pip install -r tools/requirements.txt
python tools/fglbrand.py env --slug watchtower --name "Watchtower" --color "#A21CAF"
```

Then copy `3-admin-support/watchtower/*` into `public/` except `head-snippet.html`, and in
`site.webmanifest` make the icon `src` paths relative (drop the leading `/`) so the site works
under a Pages base path. `mark-dark.svg` is the kit's `mark("dark", band)` with viewBox `12 2 40 60`.
