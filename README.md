# Exo-mind

A personal knowledge engine. Add a video to a YouTube playlist and Exo-mind will:

1. notice it (it checks the playlist every 15 minutes, or when you click **Check playlist now**)
2. fetch the metadata and captions with **yt-dlp**
3. have a language model (GPT-6 Luna by default, or Claude) write a structured note: gist, summary, key ideas, timestamped quotes, people and works, and questions
4. find **connections** to what's already in your library, with one line on *why* each one connects
5. save it all as **plain markdown** in your vault folder

You can also paste a link into the box at top left: a video, or a **web article**.

> **Status: a personal project, shared as is.** It's in daily use by one person, on a Mac. The server and web UI should run anywhere Node does, but only macOS has been tried, and the desktop app is Mac-only (Apple Silicon). Expect rough edges, and check what it costs you in API calls (the **Usage** page tracks it, and there's a monthly budget in Settings).

To flag something before it's finished, click the star on its row in **Queue**. The note is starred as soon as it's written, and shows under **Starred** in the sidebar. Starring a finished row stars its note directly.

## Articles

Paste an article link (an essay, blog post, Substack, news story…) and it goes through the same pipeline as a video. The readable text is pulled out of the page with Mozilla's Readability (the engine behind Firefox Reader View) and saved in place of a transcript, as numbered paragraphs (¶1, ¶2…). The note gets the same sections, with the author recorded in place of speakers, and the quotes are tagged with paragraph numbers instead of timestamps. Clicking a ¶ number, in a quote or in the **Article text** tab, opens the original page scrolled to that passage (in Chrome, Edge and Safari; other browsers open the page at the top).

If the author was picked up wrongly, or writes under a pseudonym you'd rather resolve, click their name under the title to correct it (separate several authors with commas). The people graph, the note's **Author** line and the quote attributions all follow. People quoted in an article count as *mentioned*, not as speaking alongside the author.

Links to known video sites go straight to yt-dlp. Any other link is tried as an article first. If the page has too little text to be an article, it's handed to yt-dlp in case it's a video.

If a site blocks automated readers (a 401, 403, 429 or 503, or a Cloudflare-style "Just a moment…" check), Exo-mind fetches the latest **Wayback Machine** snapshot instead. The note keeps the original link, records the snapshot in `archived` / `archived_date`, and the **Article text** tab shows *from archive (date)*. If there's no archived copy either, click **Paste text** on the failed item in **Queue**: open the page in your browser, copy the article (⌘A is fine; menus and footers are mostly stripped out), paste it in, add the title, and Exo-mind summarises it like any other article, keeping the original link.

Limits: pages that need a login, sit behind a paywall or build their text with JavaScript may come through short or fail with a clear error in **Queue**. PDFs aren't supported yet.

## Your own tags

The model tags every note as it summarises it. You can add tags of your own as well: click **+ tag** under a note's title and type one ("inspiring", say); tags you've used before are offered as you type. Your tags are kept apart from the model's, in a `my_tags:` list in the note's frontmatter, so re-summarising never changes them and the model is never taught to use them.

Your tags are drawn on a yellow ground, and they come first wherever tags are listed: in the note, in the sidebar (under **My tags**, above **Frequent tags**), on the **Tags** page, in the library's tag filter and in the graph's tag highlight. Adding one of the model's tags (say "christianity") by hand moves it into your list on that note, but elsewhere it stays one of the model's, so a single hand-added tag can't turn a hundred notes yellow. Shared pages show only the model's tags.

**investment** is one of your tags too: put it on anything worth weighing when buying or selling shares. In **Queue**, the trend-line button beside a row's star tags the note "investment" as soon as it's written. (It replaced an earlier Investment flag; notes that had the flag were given the tag.) Once a tag is yours the model stops using it, so "investment" only ever means what you've chosen.

## Setup (once)

You need Node 22 or later and [yt-dlp](https://github.com/yt-dlp/yt-dlp).

```bash
brew install yt-dlp        # the only external tool
git clone <this repository> exo-mind
cd exo-mind
npm install
npm start                  # builds the UI and starts the server
```

Open **http://localhost:4747**, go to **Settings** and fill in:

- **Playlist link.** Create a playlist such as "To synthesise" and set it to **Unlisted**, which lets yt-dlp read it without signing in. Private playlists also work if you choose a browser under *Use cookies from browser*.
- **An API key.** OpenAI for GPT-6 Luna (the default), or Anthropic if you pick a Claude model. You can use one model for summaries and another for connections.
- *(optional)* **About you.** A sentence or two that helps the model judge what's worth noticing.

For development, `npm run dev` serves the live source with hot reload on the same address, http://localhost:4747.

## The Mac app

Exo-mind also runs as a Mac app: a small Electron process starts the server on a private loopback port and opens a window on it. Closing the window leaves the app running in the Dock, so the playlist is still checked on schedule; **Cmd+Q** stops it. Build it on the Mac you'll run it on:

```bash
npm install
npm run app:install        # build the UI and server, make Exo-mind.app, put it in ~/Applications
```

`npm run app:install` replaces the copy in ~/Applications each time, so run it again after changing the app (quit the app first). The other steps on their own:

| Command | What it does |
| --- | --- |
| `npm run app:build` | Builds the UI and bundles the server into one file, into `app-server/` |
| `npm run app` | Runs the app from the checkout, using `app-server/` |
| `npm run app:dist` | Makes `dist-app/mac-arm64/Exo-mind.app` and a .dmg |

The app is unsigned. Installed with `app:install` it opens straight away; a copy from the .dmg needs right-click → **Open** the first time.

The app menu has **Settings…** (Cmd+,), **Open at Login** (opened at login, it starts in the background without a window), and shortcuts to the vault, the data folder and the server log. **Go** has the views on Cmd+1 to Cmd+5 and **Check Playlist Now** (Cmd+Shift+R). Links to videos and articles open in your browser.

Don't run `npm start` or `npm run dev` while the app is open: two servers would both process each new playlist item into the same vault. The app refuses a second copy of itself, but it can't see a server in a terminal.

## Where things live

```
vault/                     ← your knowledge (the folder can be moved in Settings, e.g. into iCloud Drive)
  notes/<slug>.md          one note per source: YAML frontmatter + markdown body
  transcripts/<slug>.md    full timestamped transcript, or an article's numbered paragraphs
  people.md                the people you've starred
  .exo/state.json          queue and which playlist items have been seen
  .trash/                  deleted notes are moved here, not destroyed
```

Settings (including your API keys), the usage log and the list of shared notes live outside both the vault and the checkout, in `~/Library/Application Support/exo-mind/`, so the Mac app and `npm run dev` use the same ones. Before 0.4 they were in the checkout's `data/` folder; the first run of 0.4 copies them across and leaves the old folder alone. `EXO_DATA_DIR` overrides the location.

Notes are ordinary markdown, so you can edit them in the app, in VS Code or in Obsidian. External edits show up in the app straight away.

- The **My notes** section is yours. Re-summarising replaces everything else in the body but keeps it.
- **Connections** are stored in the frontmatter (`connections:`). A readable `## Connections` list with `[[wikilinks]]` is regenerated at the bottom of each file. Add or remove links in the app's side panel rather than editing that list by hand.
- Backlinks ("links here") are worked out automatically from other notes' connections.

## How connections are found

When a note is added, Exo-mind builds a shortlist of related notes:

- **Up to 40 notes:** every existing note is on the shortlist.
- **More than 40 notes:** a local keyword index (BM25 over notes and transcripts) picks the 30 most relevant.

The model then gets the new note plus the shortlist, keeps only the links worth having (usually 0–6) and explains each one. Use **⋯ → Find connections again** on older notes as the library grows.

## People graph

**Graph → People** shows the people named in your notes, linked when they share a note. The notes are carried on the links:

- **Talk together**: both speak in the same note (host and guest, panellists).
- **Talks about**: one speaks and the other is discussed.
- **Mentioned together** (off by default): both are only discussed, in at least two of the same notes.

Hover over a person to name everyone they're linked to. Click a person to list their notes and make their links pointable: hover over a line to see the notes behind it, or click it to keep that list open. People who are only mentioned are included once they come up in at least 2 notes (adjustable).

**Correcting speakers.** Under each video's title, **Speaking** shows who the graph counts as speaking; click it to fix the names (separate several with commas). For an article, click the author's name. The note's People & works lines, quotes credited to a first name alone ("Iain" → "Iain McGilchrist") and the graph all follow. A list set by hand is final: no more speakers are guessed from quotes or the title.

**Starring people.** Click the star beside a name, either under **Speaking** (or an article's author) or among a note's **People** in the side panel, to mark that person as worth paying attention to. You can also star someone from their card in the people graph. Starred people are listed in the sidebar under **Starred people**. Click a name to see the notes they speak in or are mentioned in (mentions are labelled). In the people graph their dot is buttercup yellow (the same size it would otherwise be) and they are named first. The list is kept in `vault/people.md`, one `- name:` per person, and can be edited by hand. Spellings are matched as in the graph, so "Jordan B. Peterson" and "Jordan Peterson" are the same person.

**Merging people.** The graph joins spellings of one name by itself ("Jordan B. Peterson" / "Jordan Peterson"), but not different names for one person ("Jesus" / "Jesus Christ"). To merge them, click the person, choose **Merge into…** on their card and pick the name to keep. Their notes, links, star and dates all join that person. Merged names are listed on the card as *Also called*; click the × beside one to make them separate again. **Possible duplicates** in the toolbar lists pairs that are probably one person, for you to confirm: one name that is the other with words left out and with matching dates ("Augustine" / "Augustine of Hippo"), or two names with the same firmly known birth and death years ("C. S. Lewis" / "Clive Staples Lewis"). Choose which name to keep, or **Different people** to stop suggesting the pair. Your notes are never rewritten: merges are kept in `vault/people.md` under `merged:` (dismissed pairs under `not_same:`), which you can also edit by hand.

**By era.** Turn on **By era** to nudge people down the graph by when they lived: the present day at the top, then down through the centuries, so Shakespeare sits above Jesus, who sits above Aristotle. Faint lines on the right mark the years. Time runs on a compressed scale (square root of years ago), so recent centuries, where most people are, get room and antiquity still separates clearly. Links between people far apart in time are still drawn but don't pull, so a podcaster discussing Aristotle can't drag him out of his era, and people of the same period push each other sideways so the page's width is used and more names fit. The **Width** slider stretches the people graph sideways (from half to three times as wide; double-click it to reset), so names have more room; dots and labels keep their size. Each note's **People** panel has its own **By era** switch (beside the legend): the same arrangement for just that note's people, fitted to their span, with the years down the right-hand side. Clicking a person there shows their dates too. People without dates, gods and fictional characters float freely.

The first time it's turned on, Exo-mind asks the connections model (or the summary model) when each person lived, in batches, most-mentioned first; the graph rearranges as answers arrive, and later visits only date newcomers. The note titles each person appears in are sent with their name so the right person of that name is picked. Dating ~3,000 people cost about $0.08 with GPT-6 Luna. Dates are kept in `vault/.exo/people-dates.json`. A person's card shows their dates (*c.* when approximate, *a guess* when the model wasn't sure); click **Correct** to fix them. Hand-corrected dates are never overwritten.

New notes record who speaks in a `speakers:` frontmatter list. For older notes this is inferred from quote speakers and from names in the title or channel, so re-summarising is optional. A person spelled two ways (e.g. "Ian" and "Iain McGilchrist") shows as two people until the spelling is fixed in the note.

## Troubleshooting

- **"yt-dlp not found".** Run `brew install yt-dlp`, or set the full path in Settings.
- **"Sign in to confirm you're not a bot".** Set *Use cookies from browser* to Chrome or Safari. Also keep yt-dlp current with `brew upgrade yt-dlp`, because YouTube changes often.
- **No captions.** The note is still created from the title and description, and flagged as having no transcript.
- **A failed item.** Open **Queue**, read the error and click **Retry**.

## Road map

- Google Takeout import of watch history, to pick older items from
- Email-in address for links
- Local Whisper transcription for videos without captions
- PDF links (papers, reports) as a third source type
- "Ask your library" chat with citations
- Embedding-based similarity as a second opinion alongside keyword search

## Sharing notes

A note's **Share** button publishes a read-only public page of it, at
`https://<your domain>/s/<random id>`. You choose what it shows (people graph,
tags, works, transcript, your own "My notes", titles of your other notes); the title, source,
speakers and summary are always included. Only that snapshot leaves your machine. The page doesn't
follow later edits: press **Update** in the Share panel to republish at the same address, or
**Unshare** to delete it. Shared notes are listed in `shares.json` in the app's data folder.

The pages are served by a small Cloudflare Pages site in `cloudflare/` (free plan is plenty), with
the snapshots stored in Workers KV.

One-off setup:

1. **KV namespace.** In the Cloudflare dashboard, Storage & databases → Workers KV → Create, name it
   `exo-mind-shares`. Copy `cloudflare/wrangler.example.toml` to `cloudflare/wrangler.toml` (git
   ignores it) and put the namespace's ID in place of `PUT-YOUR-KV-NAMESPACE-ID-HERE`.
   Optionally, copy `.env.example` to `.env.local` and put your name (and a link) in it: the shared
   pages then say "*name*'s shared notes".
2. **Deploy the site.** `npx wrangler login`, then `npm run share:deploy`. The first deploy offers to
   create the Pages project `exo-mind-share`; say yes. Run `npm run share:deploy` again whenever the
   viewer's code changes (not needed for sharing or updating notes).
3. **Custom domain** (optional; the site also works at `exo-mind-share.pages.dev`). Pages project →
   Custom domains → add, say, `notes.example.com`. At your DNS provider, add a CNAME record:
   `notes` → `exo-mind-share.pages.dev`. Cloudflare issues the certificate once it sees the record.
4. **API token for publishing.** My Profile → API Tokens → Create token → Custom: permission
   *Account · Workers KV Storage · Edit*, for your account. In Exo-mind's **Settings → Sharing**,
   paste the token, your account ID (on the dashboard's account home page), the KV namespace ID and
   the site's address.

## Licence

[PolyForm Shield 1.0.0](LICENSE): you may use, change and share Exo-mind, but not to offer a product that competes with it.
