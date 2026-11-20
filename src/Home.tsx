import logo from "./logo.svg";

interface Props {
  currentTitle: string | null;
  songCount: number;
  onOpen: () => void;
  onNew: () => void;
}

/** The home page behind the logo: what Inkbeat does, with a way back into your songs. */
export default function Home({ currentTitle, songCount, onOpen, onNew }: Props) {
  return (
    <div className="home">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Inkbeat · lyric pad</p>
          <h1>
            Write to the beat.
            <br />
            <span className="hl">Record the flow.</span>
          </h1>
          <p className="lede">
            Paste a YouTube beat, pin your bars to the exact second they land, and record takes right on top. Everything
            stays in your browser.
          </p>
          <div className="hero-ctas">
            {currentTitle && songCount > 0 ? (
              <button className="cta" onClick={onOpen}>
                Open “{currentTitle.length > 28 ? currentTitle.slice(0, 27) + "…" : currentTitle}”
              </button>
            ) : null}
            <button className={currentTitle && songCount > 0 ? "cta ghost" : "cta"} onClick={onNew}>
              + New song
            </button>
          </div>
        </div>
        <div className="hero-art" aria-hidden>
          <img src={logo} alt="" className="hero-logo" />
          <div className="hero-lines">
            <span style={{ width: "86%" }} />
            <span className="mark" style={{ width: "72%" }} />
            <span style={{ width: "64%" }} />
          </div>
        </div>
      </section>

      <section className="how" aria-label="How it works">
        {[
          ["01", "Drop a beat", "Paste any YouTube link. It plays right here."],
          ["02", "Stamp your bars", "Hit M where a verse or hook lands. Each marker gets its own page."],
          ["03", "Record flows", "Rap over the beat from any marker. Keep every take."],
        ].map(([n, t, d]) => (
          <div key={n} className="how-step">
            <span className="how-n">{n}</span>
            <h3>{t}</h3>
            <p>{d}</p>
          </div>
        ))}
      </section>

      <section className="features" aria-label="Features">
        <article className="feat">
          <div className="feat-art tape-art" aria-hidden>
            <div className="mini-tape">
              <i style={{ left: "14%" }}>1</i>
              <i style={{ left: "42%" }} className="on">
                2
              </i>
              <i style={{ left: "71%" }}>3</i>
              <b />
            </div>
          </div>
          <h3>Timestamped markers</h3>
          <p>Every section sits at the second it starts. Click one to jump the beat there.</p>
        </article>

        <article className="feat">
          <div className="feat-art" aria-hidden>
            <div className="mini-rec">
              <span className="dot" /> Record flow
            </div>
            <div className="mini-takes">
              <span>▶ Take 1</span>
              <span className="star">▶ Take 2 ★</span>
            </div>
          </div>
          <h3>Record flows</h3>
          <p>Takes line up with the beat. Star your keeper, rename, download, or hear it without the beat.</p>
        </article>

        <article className="feat">
          <div className="feat-art paper" aria-hidden>
            <div className="mini-lines">
              <p>
                grinding all the <mark className="a">time</mark>
                <em>A</em>
              </p>
              <p>
                this moment is <mark className="a">mine</mark>
                <em>A</em>
              </p>
              <p>
                out on the <mark className="b">street</mark>
                <em className="b">B</em>
              </p>
            </div>
          </div>
          <h3>Rhymes &amp; syllables</h3>
          <p>Rhyming endings light up in matching colors, with syllable counts on every line.</p>
        </article>

        <article className="feat">
          <div className="feat-art paper" aria-hidden>
            <div className="mini-duo">
              <div>
                <i>We're no strangers…</i>
                <i className="on">You know the rules…</i>
              </div>
              <div>
                <b>We're no rappers…</b>
                <b>You know the flow…</b>
              </div>
            </div>
          </div>
          <h3>Cover &amp; parody mode</h3>
          <p>Pull any song's timed lyrics, write your version line by line, and swap in a karaoke track.</p>
        </article>

        <article className="feat">
          <div className="feat-art" aria-hidden>
            <div className="mini-loop" />
            <div className="mini-song">▶ Play song · 4 takes</div>
          </div>
          <h3>Loop &amp; Play song</h3>
          <p>Loop one section to practice, then hear every keeper take in order over the full beat.</p>
        </article>

        <article className="feat">
          <div className="feat-art" aria-hidden>
            <div className="mini-file">
              <span>{"{ }"}</span>
              my-song.inkbeat.json
            </div>
          </div>
          <h3>Backup &amp; import</h3>
          <p>Export a song or everything (takes included) and move it to another device. Or grab lyrics as text.</p>
        </article>
      </section>

      <section className="keys-card" aria-label="Keyboard shortcuts">
        <h3>Shortcuts</h3>
        <div className="keys-grid">
          <span>
            <kbd>Space</kbd> play / pause
          </span>
          <span>
            <kbd>M</kbd> drop marker
          </span>
          <span>
            <kbd>⌘/Ctrl</kbd> <kbd>Enter</kbd> marker while typing
          </span>
          <span>
            <kbd>R</kbd> record current section
          </span>
          <span>
            <kbd>←</kbd> <kbd>→</kbd> skip 5s
          </span>
          <span>
            <kbd>Esc</kbd> stop / leave text
          </span>
        </div>
      </section>

      <footer className="home-foot">Your songs and recordings are saved in this browser only. Use Backup to keep a copy.</footer>
    </div>
  );
}
