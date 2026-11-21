/* Cut-off titles slide sideways while hovered so you can read the whole thing. */
import type { MouseEvent } from "react";

const SPEED = 50; // px per second
const PAUSE = 900; // ms held at each end

const runs = new WeakMap<HTMLElement, number>();

function stop(el: HTMLElement) {
  cancelAnimationFrame(runs.get(el) ?? 0);
  runs.delete(el);
}

function start(e: MouseEvent<HTMLElement>) {
  const el = e.currentTarget;
  if (document.activeElement === el) return; // typing in it: leave it alone
  const max = el.scrollWidth - el.clientWidth;
  if (max < 4) return;
  stop(el);
  el.classList.add("marquee-on");
  let dir = 1;
  let wait = performance.now() + 350;
  let last = performance.now();
  const step = (now: number) => {
    const dt = (now - last) / 1000;
    last = now;
    if (now >= wait) {
      el.scrollLeft = Math.max(0, Math.min(max, el.scrollLeft + dir * SPEED * dt));
      if ((dir > 0 && el.scrollLeft >= max - 0.5) || (dir < 0 && el.scrollLeft <= 0.5)) {
        dir = -dir;
        wait = now + PAUSE;
      }
    }
    runs.set(el, requestAnimationFrame(step));
  };
  runs.set(el, requestAnimationFrame(step));
}

function end(e: MouseEvent<HTMLElement>) {
  const el = e.currentTarget;
  stop(el);
  el.classList.remove("marquee-on");
  if (document.activeElement !== el) el.scrollTo({ left: 0, behavior: "smooth" });
}

/** Spread onto any single-line element with overflow hidden (or a text input). */
export const marquee = { onMouseEnter: start, onMouseLeave: end, onFocus: (e: { currentTarget: HTMLElement }) => stop(e.currentTarget) };
