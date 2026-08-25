# PW-Warehouse

Internal warehouse inventory tool. A static Vue 3 + TypeScript app backed by
Firebase Realtime Database. No picture/image support — see "Pictures are
out of scope" below.

## How it works

- On load, the app subscribes to the whole `/items`, `/itemStacks`,
  `/containerTypes`, and `/containers` paths in the Realtime Database and
  keeps a live, reactive copy in memory — see
  [src/store/warehouse.ts](src/store/warehouse.ts). Changes from any client
  (including other people's edits) sync in automatically, no refresh needed.
- **Search** works two ways. Typing text matches Container labels and the
  names of Items inside them. Typing a shelf address — `SL1`, `SL1-M`,
  `SL1-M-A`, `SR3-M2` — switches to a positional view listing everything at
  or under that address, grouped by exact position. A query counts as an
  address only if it both looks like one and prefixes a real location, so a
  label that happens to resemble an address still searches as text.
- **Add** covers full CRUD for Containers, Items, and Container Types,
  including managing a Container's contents (ItemStacks), and a bulk
  "assign every container on shelf X to type Y" tool.
- **Scan Shelf** photographs one shelf and uses Gemini to read the labels
  and work out where each box sits — see below.
- **Logs** is an append-only record of every database change, with who made
  it and when.
- **Deleted** is a recoverable trash can for containers.
- The sidebar footer holds a username, stored in `localStorage`, used to
  attribute log entries. There is no real authentication — it's a label, not
  a login.
- **Print Label** prints free-form text — bold, italic, underline, and a
  quantity — in Segoe UI, sized as large as the loaded label allows.
- **Label printing** to a Phomemo D520BT over USB — see
  [backend/README.md](backend/README.md). Creating or renaming a container by
  hand prompts to print 2 labels (one per side), and every container has a
  "Print label" button for reprints. Scan-applied changes deliberately do not
  prompt, so a shelf scan can't kick off a bulk print job.
- Every write is a direct, atomic path-level Firebase operation
  (`set`/`update`/`remove`) — e.g. adding an item to a container is one
  multi-path `update()` that writes the new ItemStack and links it into the
  container's `contents` map in a single atomic call. There's no
  "rewrite-the-whole-table" step and no window where a slow/interrupted
  write could wipe existing data.
- `contents` (a Container's ItemStacks) and `flags` are stored as
  `{ id: true }` maps rather than arrays — the RTDB-idiomatic way to
  represent a set, and what makes single-item add/remove an atomic
  single-key write instead of a read-modify-write of a whole list.

## Why Realtime Database over Firestore

Both were viable; RTDB fit better here:

- It was already provisioned (`pw-warehouse-c203e-default-rtdb`) — no new
  database to create.
- The app's whole model is "load everything into memory, filter/search
  client-side" (inherited from the original spreadsheet version) — that's
  exactly RTDB's `once`/`onValue`-the-whole-tree usage pattern, and avoids
  Firestore's per-document-read billing for a load-it-all-up-front app.
- The data is a handful of small flat collections with no need for
  compound queries or indexes, so Firestore's main advantages over RTDB
  don't apply much here.

## Setup

```bash
npm install
npm run dev
```

For label printing, also start the local print service — double-click
`backend\start-printer-server.bat` and leave it running. The app works fine
without it; only printing is unavailable.

### Using it from a phone

Both servers bind to all network interfaces, so any device on the same
network can use the app — including printing, since the print request is sent
to the laptop and the laptop drives the USB printer.

1. **Once only:** right-click `allow-lan-access.bat` → *Run as administrator*.
   This opens ports 5173 and 8765 to local-subnet addresses. Without it
   Windows Firewall silently drops the connection and the phone just hangs.
2. Start both servers on the laptop (`npm run dev`, plus
   `backend\start-printer-server.bat`).
3. On the phone, open `http://<laptop-ip>:5173` — `npm run dev` prints the
   address on its "Network:" line.

The app works out the print service's address from whatever host served the
page, so nothing needs configuring when the laptop's IP changes. Hardcoding
`127.0.0.1` would make the phone try to reach *itself*.

The laptop must stay awake and on the same network, and the printer stays
plugged into it over USB.

`.env.local` (gitignored, already populated) holds the Firebase Web App
config (`VITE_FIREBASE_*`) — these are **not secrets**; Firebase's own docs
are explicit that the client config is safe to expose and security is
enforced entirely by Realtime Database / Storage rules, not by hiding it.

## Security rules

The Realtime Database is set to fully open read/write, with no
authentication required — the same "internal-network-only, never public
facing" trust model you chose for the previous Sheets-backed version.
**This is a materially bigger exposure than the old model**: there, an
attacker needed to extract an embedded key first; here, anyone who
discovers the database URL can read, write, or delete everything with no
secret at all. Do not host this anywhere reachable from the public
internet. If that ever changes, add Firebase Authentication (e.g. Google
Sign-In restricted to `@pixw.us`) and tighten the rules to require
`auth != null` — ask and I can wire that up.

## Shelf scanning (Gemini)

Set `VITE_GEMINI_API_KEY` in `.env.local` (get one at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey)) and restart
the dev server. Until it's set, the Scan tab explains what's missing instead
of failing. `VITE_GEMINI_MODEL` defaults to `gemini-2.5-flash`.

How a scan works:

1. Pick the shelf you're photographing from the dropdown. This is what tells
   Gemini to ignore neighbouring shelving units that get caught at the edge
   of the frame.
2. Take one photo of the whole unit. It's downscaled to 1600px in the browser
   before upload and **never stored anywhere** — it goes to Gemini in memory
   and is discarded.
3. Gemini returns each box's label, level, column, and (from its appearance
   in the photo) its container type. The prompt spells out the addressing
   scheme, including that `M1` is the tier directly above `L` and that plain
   `M` means the shelf has only one middle tier.
4. You get a **review screen** listing every proposed change — moves, newly
   discovered boxes, and boxes the photo didn't show — with checkboxes.
   Nothing is written until you hit Apply. Low/medium-confidence readings are
   marked so you can spot them.
5. Applying writes every change and its log entries in a single atomic
   Firebase update.

Details worth knowing:

- **Matching is by label**, compared case- and whitespace-insensitively. The
  prompt includes the list of existing labels and asks Gemini to reproduce
  them exactly when a box matches, which keeps OCR drift from creating
  duplicates.
- **Labels must be unique.** If two containers share a label the scan can't
  tell them apart, so it skips them and lists them as "ambiguous" rather than
  guessing. The Scan tab warns about any duplicates it finds up front.
- **A box the photo didn't show** gets proposed for the trash, not deleted —
  it's recoverable from the Deleted tab. This is deliberate: a box can be
  missed because it's obscured or blurry, not because it's gone.
- Boxes recorded on a *different* shelf that show up in this photo are moved
  here, which is the point of the feature.

## Pictures are out of scope

There's no picture/image support anywhere in the app (Item, ContainerType —
neither has a picture field). Two paths were tried and both hit a wall:

1. **Firebase Storage** requires the project to be on the paid Blaze plan —
   ruled out.
2. **Google Drive** (the approach the old Sheets version used) doesn't
   work either: uploading needs a Shared Drive, because service accounts
   have zero Drive storage quota of their own — sharing a regular folder
   with Editor access isn't enough, confirmed by an actual failed test
   upload (`storageQuotaExceeded`). A Shared Drive would fix it, but that
   was decided to be out of scope too.

If this changes later (Blaze plan, or converting a folder to a real Shared
Drive), picture fields can be added back to `Item` and `ContainerType` in
[src/lib/types.ts](src/lib/types.ts) and wired into the Add forms.

## Migrating from the old Google Sheet

[scripts/migrate-sheets-to-firebase.mjs](scripts/migrate-sheets-to-firebase.mjs)
is the one-time script that moved the real container data (175 containers)
out of the retired "Pixel Wall Warehouse Locations" spreadsheet and into
this Realtime Database. It's kept for reference; the app itself no longer
talks to Google Sheets or Drive at all.
