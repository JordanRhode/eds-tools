# find-replace-da-docs

Finds and replaces text in DA (da.live) documents for the paths listed in
`find-replace.config.json`.

## Setup

```
npm install
```

Create a `.env` alongside the script (same shape as the other tools here):

```
ORG=evidentscientific
REPO=evident-website-eds
TOKEN=<da.live bearer token>
```

## Run

```
npm start          # dry run - reports matches, changes nothing
npm run apply      # performs the replacements
```

Every run writes a timestamped `output-<timestamp>.log` next to the script.

## Config

`find-replace.config.json`:

- `paths` — documents and/or folders to process. Each entry is either a string
  path or `{ "path": "...", "recursive": true }`.
  - Paths ending in `.html` are treated as single documents.
  - Anything else is treated as a folder and expanded via the DA list API.
    Folders recurse by default; set `"recursive": false` to only touch the
    documents directly inside the folder.
  - Paths may be repo-relative (`/en/products`) or include the org/repo prefix
    (`/evidentscientific/evident-website-eds/en/products`).
- `replacements` — applied in order to each document's HTML source.
  - `find` (required) — literal text, or a regex pattern when `isRegex` is true.
  - `replace` — replacement text. Regex rules can use `$1` style backreferences.
  - `isRegex` — treat `find` as a regular expression. Default `false`.
  - `caseSensitive` — set to `false` for a case-insensitive match. Default `true`.
  - `flags` — regex flags to use instead of the defaults (e.g. `"gis"`). The
    global flag is always added.

Example:

```json
{
  "paths": [
    "/en/downloads/brochures/files",
    { "path": "/en/products", "recursive": false },
    "/en/about/contact-us.html"
  ],
  "replacements": [
    { "find": "Olympus IMS", "replace": "Evident" },
    {
      "find": "https://www\\.olympus-ims\\.com/",
      "replace": "https://www.evidentscientific.com/",
      "isRegex": true
    }
  ]
}
```

## Notes

- Replacement runs against the raw document HTML, so it matches both visible
  text and markup (hrefs, attributes). Keep `find` values specific.
- Changes land in DA source only. Publish the affected pages afterwards for them
  to appear on the live site.
