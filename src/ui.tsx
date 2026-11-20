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
