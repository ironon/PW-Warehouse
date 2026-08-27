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
- **AI Work** is a conversation with an agent that can change the inventory:
  reorganise a shelf, bulk-add items, find containers worth merging. Every
  plan goes through a review screen, and anything that means physically
  carrying a box becomes a *proposal* rather than a change — see below.
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

## AI Work and pending moves

Set `VITE_GEMINI_API_KEY` (below) and the **AI Work** tab opens a chat with an
agent that has the whole inventory in front of it — every container, address,
type and its contents. Ask it for changes in plain English:

> take all the screws in a yellow or blue container under BR1 and organise
> them so metric is on the left and imperial on the right; keep metric in blue
> containers, imperial in anything else

It replies with a plan. Every operation is a checkbox; nothing is written
until you hit Apply. It asks clarifying questions rather than guessing, and
you can keep talking to refine a plan before applying it.

### Nothing moves a box on its own

Bookkeeping changes (labels, types, notes, item counts, new containers) are
written straight away. Anything that requires a person to physically pick a
box up — a **move**, a **swap**, or a **merge** — is only *proposed*:

- The container keeps reporting the address it is actually at. That address is
  what Search shows, because that is where the box really is.
- Alongside it, everywhere the container appears (Search, Add, AI Work), you
  get `SL4-L-A → SL3-M-B` with a green ✓ and a red ✗. ✓ records that the work
  was done and commits the new address; ✗ throws the proposal away.
- A **swap** is two halves of one job, so its two containers accept and deny
  together — carrying box A into box B's slot without moving B just puts two
  boxes in one place.
- A **shelf scan can tick a proposal off for you**: photograph the shelf, and
  if Gemini finds the box at exactly the address that was proposed, the review
  screen offers it as a "Confirm" row. A box with an outstanding proposal is
  also never proposed for the trash when a photo doesn't find it — it is
  *expected* to be leaving.
- The AI Work tab lists everything outstanding, with a "Reject all" for when a
  whole plan turns out to be wrong after the fact.

### Placement rules

The agent works to a set of standing rules — middle levels for tools and
equipment that get used often, top for customer spare parts and cardboard
boxes, bottom for things that matter but are needed less often; shelves are
full so prefer swaps; every move is labour, so don't move things for no
reason. These live in the database (`settings/placementRules`), not in code,
and are editable from **AI Work → Placement rules**, because they are a
business rule that changes without a rebuild. The seed text is
`DEFAULT_PLACEMENT_RULES` in [src/store/warehouse.ts](src/store/warehouse.ts).

### What the agent may do

`container.move`, `container.swap`, `container.merge`, `container.create`,
`container.update`, `container.trash`, `item.create`, `itemstack.add`,
`itemstack.update`, `itemstack.remove`, `containertype.create`. It cannot
purge anything permanently, and it cannot change an address through an edit —
`container.update` rejects a location outright, so relocating always goes
through the confirmation path. Every applied plan lands as one atomic
multi-path write, so a reorganisation never half-happens.

An unrecognised or impossible operation (a container id that no longer exists,
an invalid address, a duplicate item name) shows on the review screen as
"can't apply" with the reason, rather than failing at write time.

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

### Deploying to pw-warehouse.local

The app is served on this network as `http://pw-warehouse.local` (port 80) from
a built bundle, so deploying a change is:

```bash
npm run build          # writes dist/
```

then point the web server on port 80 at `dist/`. It is a plain static
directory — no server-side rendering, no API to proxy. The only routing
requirement is that unknown paths fall back to `index.html`.

Two things depend on that hostname and are already configured for it:

- **The print service** accepts requests from any `*.local` name, any
  single-label intranet name, and any RFC1918 address, on any port. Neither
  kind of name can be registered on the public internet, so no outside site
  can forge one — see `ALLOWED_ORIGIN_REGEX` in
  [backend/label_printer/config.py](backend/label_printer/config.py).
- **The app finds the print service** by taking the hostname the page was
  served from and adding port 8765, always over plain `http`. So
  `http://pw-warehouse.local` calls `http://pw-warehouse.local:8765`, and
  nothing needs reconfiguring when the machine's IP changes. It deliberately
  does not inherit the page's protocol: behind a TLS proxy every print would
  silently die on mixed-content blocking instead.

The print service must run on the same machine that serves the site, since
that is the machine with the printer on USB. Start it with
`backend\start-printer-server.bat` and leave it running.

`npm run dev` also accepts the `pw-warehouse.local` hostname (Vite otherwise
rejects unrecognised `Host` headers as DNS-rebinding protection) — see
`allowedHosts` in [vite.config.ts](vite.config.ts).

### Firewall

**Once only:** right-click `allow-lan-access.bat` → *Run as administrator*. It
opens ports 80, 5173 and 8765 to local-subnet addresses. Without it Windows
Firewall silently drops inbound connections and a phone just hangs.

### Using it from a phone

Any device on the same network can use the app at `http://pw-warehouse.local`,
printing included: the print request goes to the host machine, and that
machine drives the USB printer.

The host machine must stay awake and on the same network, and the printer
stays plugged into it over USB.

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
[aistudio.google.com/apikey](https://aistudio.google.com/apikey)) and rebuild.
Until it's set, the Scan and AI Work tabs explain what's missing instead of
failing. The same key drives both.

`VITE_GEMINI_MODEL` (shelf scanning) and `VITE_GEMINI_PLANNING_MODEL` (AI
Work) both default to `gemini-3.6-flash`. They are separate settings because
planning a reorganisation is a reasoning job rather than an OCR one — point
the planning one at something stronger (`gemini-3.1-pro-preview`) if plans
come out sloppy.

### When Gemini isn't working

Run the standalone checker — stdlib only, no venv needed:

```bash
python scripts/check-gemini.py
```

It reads `.env.local` and makes the same requests the app makes, printing the
raw HTTP status and Google's own error text, then what to actually do about
it. It tells apart the three failures that look identical from the app:

- **429 "prepayment credits are depleted"** — the key is fine, the AI Studio
  project has no credit. Top it up at
  [ai.studio/projects](https://ai.studio/projects). No code change helps.
- **404 "no longer available to new users"** — the model name is retired for
  keys as new as yours, and Google's message names the replacement. This is
  what killed `gemini-2.5-flash` and `gemini-2.5-pro` here. **Watch out:
  ListModels still advertises retired models**, so a model appearing in the
  listing does not mean it can be used.
- **401/403** — the key itself is rejected, or the Generative Language API
  isn't enabled on its project.

If every check passes but the app still fails, it's the browser, not the key:
`.env.local` is read at **build** time, so `npm run build` and redeploy (or
restart `npm run dev`) after changing it.

How a scan works:

1. Pick the shelf you're photographing from the dropdown. This is what tells
   Gemini to ignore neighbouring shelving units that get caught at the edge
   of the frame.
2. Optionally add a note for this photo — "the boxes on the floor aren't
   shelved yet, ignore them", "the third tier is being rebuilt". It's appended
   to the prompt and takes precedence over the general guidance, except for
   the scoping rule (never report a box that isn't on this shelf), which always
   wins. It's remembered for your next scan, since the same caveat usually
   applies all the way down an aisle.
3. Take one photo of the whole unit. It's downscaled to 1600px in the browser
   before upload and **never stored anywhere** — it goes to Gemini in memory
   and is discarded.
4. Gemini returns each box's label, level, column, and (from its appearance
   in the photo) its container type. The prompt spells out the addressing
   scheme, including that `M1` is the tier directly above `L` and that plain
   `M` means the shelf has only one middle tier.
5. You get a **review screen** listing every proposed change — moves, newly
   discovered boxes, and boxes the photo didn't show — with checkboxes.
   Nothing is written until you hit Apply. Low/medium-confidence readings are
   marked so you can spot them.
6. Applying writes every change and its log entries in a single atomic
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
- **A scan settles pending moves.** If a box is found at exactly the address
  somebody proposed moving it to, the review screen offers a "Confirm" row that
  commits the move. Conversely a box with an outstanding proposal is never
  proposed for the trash when the photo doesn't find it — it is supposed to be
  leaving. See "AI Work and pending moves" above.

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
