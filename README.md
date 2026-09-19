# CommitStory — Codebase Description (for everyone, 
no tech background needed)

## 1. The one-paragraph version

**CommitStory is a storyteller for software changes.** Whenever programmers modify a project, their edits are normally visible only as grey, cryptic lines of code that non-programmers can't read. CommitStory takes those edits, hands them to Google's AI (Gemini), and produces two human-friendly things: (a) a **visual map** — boxes and arrows showing which parts of the system were touched and how they connect, and (b) **release notes in plain English** — "what changed for users and why it matters," with zero jargon. It works in three ways: a command for programmers' terminals, a beautiful website anyone can use, and a robot that automatically posts these stories on proposed changes.

## 2. The big idea, step by step

Imagine a restaurant kitchen. Cooks (developers) change recipes (code) every day. The manager and customers (stakeholders) just want to know: *what's new on the menu and is it safe?* But all they get is the cooks' scribbled shorthand. CommitStory stands between the kitchen and the dining room:

1. **It collects the scribbles** — the exact list of what was added, removed, or edited (programmers call this a "diff").
2. **It asks an expert reader (Google's Gemini AI)** to study those scribbles and answer three questions: *summarize it briefly*, *draw me a map of the affected parts*, *explain it like I'm not a cook*.
3. **It forces the AI to answer in a strict form** (a "schema" — like a fill-in-the-blanks worksheet with exactly three blanks: summary, map code, release notes), so the answer is always usable and never rambling prose.
4. **It displays the answer beautifully** — the map is drawn in the browser with a diagram tool called Mermaid, and the notes are shown as clean bullet points.

If the AI is temporarily too busy (an "I'm overloaded" error) it politely waits and retries; if one AI model has been retired by Google, it automatically switches to a backup model. Nothing the user sees breaks.

## 3. The three doors into CommitStory

**Door 1 — The terminal command (for developers).** A programmer types something like `commitstory --compare main..feature` ("show me the story of everything different between the main recipe book and my new experimental chapter"). The tool reads the local edits, asks the AI, prints a neat report in the terminal, and can save it to a file (`-o story.md`). There are optional dials: use a different AI model, use a different key, or limit how much text gets sent (`--max-files`, `--max-lines-per-file`, `--max-chars`; zero means "no limit").

**Door 2 — The website dashboard (for everyone).** Anyone opens the page, pastes a GitHub link — either a whole project (`github.com/owner/project`) or one specific proposal (`.../pull/123`) — and presses **Analyze**. A three-stage progress display walks through *Fetching diff → Analyzing → Rendering*, and then the screen fills with: a metadata strip (project name, proposal number, how many files changed, lines added/removed, which AI model answered, how long it took), the **architecture map** (zoomable, downloadable as a picture, expandable to fullscreen, with its source code viewable and copyable), and the **release notes** (a highlighted summary plus stakeholder bullets). Recent analyses are remembered for quick re-runs. No account, no code knowledge needed.

**Door 3 — The robot (automatic, for teams).** When a developer proposes a change on GitHub (a "pull request"), a robot wakes up automatically, does the whole analysis by itself, and posts (or updates) a comment on that proposal containing the summary, the map, and the release notes. Every new push refreshes the comment. Reviewers and managers get the story without asking anyone.

## 4. File-by-file tour (the whole project is ~1,700 lines)

```
commitstory/
├── package.json                 (37 lines)   — the ID card + shopping list
├── .env.example                 (19 lines)   — the blank settings form
├── .env                         (private!)   — the filled-in secrets (never shared)
├── .gitignore                   (6 lines)    — "don't share secrets or clutter"
├── bin/index.js                 (~400 lines) — Door 1: the terminal command
├── server.js                    (~440 lines) — Door 2's engine: the website's brain
├── public/index.html            (~580 lines) — Door 2's face: the beautiful website
└── .github/workflows/
    └── commitstory.yml          (~210 lines) — Door 3: the robot's instruction sheet
```

**`package.json` — the ID card and shopping list.** Says: this project is named CommitStory, speaks modern JavaScript, and needs six outside ingredients: the Google AI connector, the command-line parser, the web server, the GitHub connector, and two utilities. It also registers the magic word `commitstory` as a runnable command and defines `npm start` (launch the website).

**`.env` / `.env.example` — secrets, handled responsibly.** The AI and GitHub demand private passwords ("keys"). The real keys live in `.env`, which is **never committed or shared** (the `.gitignore` file enforces this). `.env.example` is a blank copy of the form showing which settings exist: the AI key (two accepted spellings), an optional GitHub token (unlocks private projects and faster access), the website port, and three optional "how much text may be sent" dials for the server.

**`bin/index.js` — the terminal command (Door 1).** In plain terms it: checks you gave it a comparison range and an AI key; confirms you're inside a project; asks Git for the change-statistics and the full edit text; trims the text only if you set limits (default: no trimming, your machine, your key); refuses politely if the text is absurdly huge (a safety ceiling just below the AI's memory limit, with advice); sends it to the AI with the strict three-blank form; cleans up the map code; prints a markdown report and optionally saves it. It also contains the resilience logic: wait-and-retry when the AI is busy (up to 3 tries with growing pauses), switch to the backup model if the main one is gone or stays busy, and a final friendly message if all else fails.

**`server.js` — the website's brain (Door 2's engine).** A web server that: shows the website files; offers a health check (`/api/health` — "are you awake, which AI model, what limits, is a key installed?"); and offers the analysis service (`POST /api/analyze` — send it a GitHub link, get back the story as data). For a proposal link it downloads the proposal's file changes from GitHub; for a plain project link it analyzes the latest change on the main line. It understands many link spellings, explains bad links/unknown projects/rate limits in plain errors, applies the server's protective size dials (generous but bounded, since this endpoint is public), enforces the same safety ceiling (answer: error 413, "too large"), and returns everything the page needs: summary, map, notes, file/line counts, model used, and whether trimming happened. Same retry-and-backup-model resilience as the terminal command.

**`public/index.html` — the beautiful face (Door 2, the biggest file).** A single self-contained page (dark, premium look: glowing gradient background, frosted-glass cards). It contains: the hero header with live status badges; the big link-input bar with example shortcuts and remembered recents; the three-stage animated loader with skeletons and a timer; an error card with a Retry button; and the results — metadata chips (project, proposal number, file counts, additions/deletions, model, timing, trimmed-warning), the zoomable/downloadable/fullscreenable map with viewable source, and the release notes rendered as real formatted text (a tiny built-in formatter that only allows safe formatting — bold, bullets, headings, code — so hostile content can never inject anything dangerous). All map drawing happens in the visitor's browser.

**`.github/workflows/commitstory.yml` — the robot's instruction sheet (Door 3).** A recipe GitHub follows on every new or updated proposal: fetch the full history, install the AI connector, compute the change range, trim only per its (generous, adjustable) dials, ask the AI with retries and model fallback, then post the story as a proposal comment — or update the existing story comment (recognized by a hidden marker) so there's never a pile of duplicates. Its size dials can be tuned without editing code, via repository settings.

**`node_modules/` + `package-lock.json` — the pantry.** The downloaded third-party ingredients plus the exact receipt of versions, so every install is identical. Never edited by hand, never described further.

## 5. A concrete journey (follow one proposal)

Developer Ana proposes 12 file changes to an online shop → the robot wakes, downloads the 12 edits, trims nothing (limits are high), asks Gemini (primary model; if busy, waits ~1.5s, 3s, 6s, then tries the backup) → receives the three blanks → posts a comment: *"Summary: checkout now validates discount codes server-side…; [map: Cart → Discounts → Orders]; Release notes: shoppers will no longer see invalid codes accepted…"* → Ana pushes a fix → the robot updates the same comment. Meanwhile manager Ben pastes the proposal link into the dashboard and sees the same story with a zoomable map — no programmer involved.

## 6. Safety and reliability, in plain terms

- **Secrets never travel**: keys live in one ignored file; the example settings file contains no real secrets.
- **The AI can't ramble**: the strict three-blank form guarantees machine-usable answers every time.
- **Busy AI? Wait, don't crash**: automatic retries with growing pauses for "overloaded" errors.
- **Retired AI model? Switch**: primary `gemini-3.5-flash`, automatic fallback to `gemini-2.5-flash` (this already saved the project once when `gemini-1.5-flash` was discontinued).
- **Absurdly giant changes? Refuse gracefully**: a safety ceiling with actionable advice instead of a cryptic failure.
- **Public website can't be abused into bankruptcy**: the server's size dials default high but bounded; only the terminal command (your own key) defaults to unlimited.
- **Website can't be hacked through notes**: release notes are rendered through an escape-first formatter — formatting without executable content.
- **No duplicate robot comments**: a hidden marker lets the robot find and update its own comment.

## 7. Mini-glossary

- **Diff** — the exact added/removed/edited lines between two versions. The raw material.
- **Mermaid** — a tool that turns typed text instructions into diagrams (boxes/arrows) right in the browser.
- **Gemini / LLM / model** — Google's AI text-understanding service; a "model" is a specific version of it.
- **Schema** — a strict answer form (here: exactly summary + map + notes).
- **Truncation/limits** — trimming giant texts before sending (per-file caps); `0` means "don't trim."
- **Retry with backoff** — on "I'm busy," wait 1.5s, then 3s, then 6s, then give up gracefully.
- **API / endpoint** — a URL that programs (not humans) talk to; `/api/analyze` is CommitStory's.
- **Pull request** — a formal proposal: "please merge my changes," with discussion attached.
- **GitHub Actions / workflow** — GitHub's built-in robots; the YAML file is their instruction sheet.

## 8. How to run it (quick reference)

```bash
cp .env.example .env        # then fill in your Gemini API key
npm install                 # download the ingredients
npm start                   # open http://localhost:3000 for the dashboard
node bin/index.js --compare HEAD~1..HEAD   # or: commitstory --compare main..feature
```

Get a free Gemini key at <https://aistudio.google.com/app/apikey>. For the robot (Door 3), add the key as a `GEMINI_API_KEY` repository secret on GitHub.
