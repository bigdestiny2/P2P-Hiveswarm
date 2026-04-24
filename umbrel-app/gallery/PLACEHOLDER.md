# Gallery placeholder

Per Umbrel App Store spec:
- **3 to 5 high-quality gallery images** required
- **Size**: 1440×900 px
- **Format**: PNG
- Replace this file (and add the JPGs/PNGs) before opening the App Store
  submission PR

Suggested screenshots for Blindspark:

1. **`1.png`** — the earnings dashboard (the headline view; "X sats earned this month")
2. **`2.png`** — the 5-step setup wizard mid-flow (e.g. step 3, LNbits connect)
3. **`3.png`** — the federation tab or the seed-request review queue
4. **`4.png`** (optional) — the welcome step of the wizard
5. **`5.png`** (optional) — settings / accept-mode configuration

## Note on filenames

The Umbrel README specifies JPEGs in their template (`1.jpg, 2.jpg, 3.jpg`)
but their actual spec says **PNG**. We'll submit as PNG and let the
Umbrel reviewers tell us if they want JPGs. Both are common across
existing apps in the store.

The `umbrel-app.yml` `gallery:` array references whichever filenames you
end up using:

```yaml
gallery:
  - 1.png
  - 2.png
  - 3.png
```

(Currently set to `.jpg` — update once we have the actual screenshots.)

## How to capture them

Take screenshots from a real Umbrel device for authenticity. The
Umbrel reviewers explicitly note: "or just upload 3 to 5 screenshots
of your app and we'll help you design the gallery images."

So if pixel-perfect 1440×900 isn't feasible from a development setup,
take clean screenshots of the dashboard at any size and let the
reviewers help with the final gallery design.
