# Store listing assets

The images the Chrome Web Store asks for when you publish. They are **not** part of the extension
package (`visualiza.zip`) — the store takes them in the listing form, not the uploaded item — so they
live here instead. The release workflow zips this folder into `visualiza-store-assets.zip` and attaches
it to the release, so everything you need to publish is in one place.

Drop the images in, keeping the names below (the names are only for you; the store doesn't read them).

## What to add

| File                   | Size (px) | Required | What it is                                                                    |
| ---------------------- | --------- | -------- | ----------------------------------------------------------------------------- |
| `screenshots/1-*.png`  | 1280×800  | yes (≥1) | Up to 5 screenshots of the panel. 1280×800 or 640×400, PNG or JPEG, no alpha. |
| `store-icon-128.png`   | 128×128   | yes      | The store icon. Same art as `extension/icons/icon128.png` is fine.            |
| `promo/small-tile.png` | 440×280   | no       | Small promo tile, used if the extension is featured.                          |
| `promo/marquee.png`    | 1400×560  | no       | Marquee promo tile, for the store's featured banners.                         |

Notes:

- Screenshots must be exactly 1280×800 or 640×400; the store rejects other sizes.
- PNG or JPEG only, 24-bit (no alpha channel) for promo tiles.
- See the current rules: https://developer.chrome.com/docs/webstore/images

## Publishing

1. Download `visualiza.zip` from the GitHub release and upload it as the item in the
   [Chrome Web Store dashboard](https://chrome.google.com/webstore/devconsole).
2. Download `visualiza-store-assets.zip`, unzip it, and upload these images in the listing form.
