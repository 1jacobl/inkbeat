# Inkbeat — lyric pad

Write lyrics to a YouTube beat, pin them to timestamps, and record flows over each spot.

## Run it

```bash
cd ~/Downloads/lyric-writer
npm install   # first time only
npm run dev
```

Open http://localhost:5190 (Chrome works best for mic recording).

## How to use

1. **Paste a YouTube link** to the beat. The song takes the video's title; click it to rename.
2. **Drop markers.** Play the beat and hit **M** (or the yellow button) where a verse/hook/bar lands,
   or type a time like `1:23` and press Add. While you're typing lyrics, **⌘/Ctrl+Enter** drops one.
3. **Write.** Each marker has a section name and its own lyric page. Click the time chip to play from
   there; double-click it to edit the time; "now" moves the marker to the playhead.
4. **Record flows.** Hit **Record flow** on a marker: the mic starts, the beat plays from that marker,
   and you rap. Hit Stop (or Space/Esc). Keep as many takes as you want per marker; rename, download
   or delete them. Press ▶ on a take to hear it over the beat from the same spot (untick "with beat"
   to hear just your voice).
5. **Lead-in** gives you 2–8 seconds of beat before the marker. **Sync** (ms) shifts takes earlier/later
   if they ever sound off against the beat (e.g. with Bluetooth headphones).

Use wired headphones while recording so the beat doesn't bleed into your vocal.

Everything saves automatically in this browser (IndexedDB). Clearing site data deletes it, so
download takes you want to keep.

## Keys

Space play/pause · M marker · ⌘/Ctrl+Enter marker while typing · R record at current marker ·
←/→ skip 5s · Esc stop recording / leave a text box
