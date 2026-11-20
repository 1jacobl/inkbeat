import { useEffect, useRef, useState } from "react";
/* Small custom controls so settings match the app instead of the OS defaults. */

export function Switch({
  on,
  onChange,
  label,
  tone = "desk",
  title,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  tone?: "desk" | "paper";
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch ${tone} ${on ? "on" : ""}`}
      onClick={() => onChange(!on)}
      title={title}
    >
      <span className="switch-track" aria-hidden>
        <span className="switch-knob" />
      </span>
      <span className="switch-label">{label}</span>
    </button>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className="seg" role="radiogroup" aria-label={label} style={{ ["--n" as any]: options.length, ["--i" as any]: idx }}>
      <span className="seg-thumb" aria-hidden />
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper({
  value,
  onChange,
  step,
  format,
  label,
  title,
  disabled,
}: {
  disabled?: boolean;
  value: number;
  onChange: (v: number) => void;
  step: number;
  format: (v: number) => string;
  label: string;
  title?: string;
}) {
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return (
    <div className={`stepper ${disabled ? "disabled" : ""}`} aria-label={label} title={title}>
      <button type="button" disabled={disabled} onClick={() => onChange(round(value - step))} aria-label={`${label} down`}>
        −
      </button>
      <button
        type="button"
        className={`stepper-val ${value !== 0 ? "set" : ""}`}
        disabled={disabled}
        onClick={() => onChange(0)}
        title="Reset to 0"
      >
        {format(value)}
      </button>
      <button type="button" disabled={disabled} onClick={() => onChange(round(value + step))} aria-label={`${label} up`}>
        +
      </button>
    </div>
  );
}

const NOTE_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Key picker: a button that opens a small grid of the 12 notes plus major/minor. */
export function KeyPicker({
  value,
  label,
  disabled,
  onChange,
}: {
  value: { tonic: number; mode: "major" | "minor" } | null;
  label: string;
  disabled?: boolean;
  onChange: (k: { tonic: number; mode: "major" | "minor" } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const mode = value?.mode ?? "minor";
  return (
    <div className="keypick" ref={ref}>
      <button type="button" className="keypick-btn" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {label}
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="keypick-pop" role="dialog" aria-label="Choose key">
          <Segmented
            label="Major or minor"
            value={mode}
            options={[
              { value: "major", label: "Major" },
              { value: "minor", label: "Minor" },
            ]}
            onChange={(m) => onChange({ tonic: value?.tonic ?? 0, mode: m })}
          />
          <div className="keypick-grid">
            {NOTE_SHARP.map((n, i) => (
              <button
                key={n}
                type="button"
                className={value?.tonic === i ? "on" : ""}
                onClick={() => {
                  onChange({ tonic: i, mode });
                  setOpen(false);
                }}
              >
                {n}
                {mode === "minor" ? "m" : ""}
              </button>
            ))}
          </div>
          {value && (
            <button
              type="button"
              className="keypick-clear"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              Clear key
            </button>
          )}
        </div>
      )}
    </div>
  );
}
