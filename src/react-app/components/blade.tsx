import type { ReactNode } from "react";

/**
 * Street Blade primitives — the pieces every screen is built from.
 * Each maps to one element of Australian street signage.
 */

/**
 * Horizontal rhythm for the whole site. Bands run full-bleed so the colour
 * reaches both edges; their contents stay inside this so lines of text never
 * run the width of a desktop monitor.
 */
export function Container({
  children,
  className = "",
  width = "wide",
}: {
  children: ReactNode;
  className?: string;
  width?: "wide" | "text";
}) {
  const max = width === "text" ? "max-w-[820px]" : "max-w-[1180px]";
  return (
    <div className={`mx-auto w-full ${max} px-4 sm:px-6 lg:px-8 ${className}`}>{children}</div>
  );
}

/** The site mark: a green blade plate with a yellow locality dot. */
export function Mark({ size = 28 }: { size?: number }) {
  const s = size / 28;
  return (
    <span
      aria-hidden
      className="relative inline-block shrink-0 rounded-[8px] bg-blade"
      style={{ width: size, height: size, boxShadow: "0 2px 0 rgba(11,60,44,0.55)" }}
    >
      <span className="absolute rounded-[5px] border-[1.5px] border-white" style={{ inset: 3 * s }} />
      <span className="absolute bg-white" style={{ left: 8 * s, top: 9 * s, width: 9 * s, height: 2 * s }} />
      <span className="absolute bg-white" style={{ left: 8 * s, top: 14 * s, width: 5 * s, height: 2 * s }} />
      <span
        className="absolute rounded-full bg-signal"
        style={{ right: 6.5 * s, bottom: 6.5 * s, width: 4 * s, height: 4 * s }}
      />
    </span>
  );
}

/**
 * The headline blade: green enamel, white keyline, an eyebrow of context above
 * the address itself. This is the one loud element on any screen.
 */
export function Blade({
  context,
  children,
  size = "lg",
}: {
  context?: ReactNode;
  children: ReactNode;
  size?: "lg" | "md";
}) {
  return (
    <div className="blade-plate inline-block max-w-full">
      <div className={`blade-face ${size === "lg" ? "px-5 pt-2.5 pb-3 sm:px-6" : "px-4 pt-2 pb-2.5"}`}>
        {context && (
          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-mint">{context}</div>
        )}
        <div
          className={`font-black uppercase leading-[1.05] tracking-[-0.015em] text-white ${
            size === "lg" ? "text-[26px] sm:text-[34px]" : "text-[20px] sm:text-[24px]"
          }`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** A metadata pill. `tone` carries meaning, not decoration. */
export function Pill({
  tone = "line",
  children,
}: {
  tone?: "line" | "ink" | "signal" | "mono";
  children: ReactNode;
}) {
  const tones = {
    line: "border-[1.5px] border-hairline text-ink-soft",
    ink: "bg-ink text-cream",
    signal: "bg-signal text-ink font-bold",
    mono: "bg-ink text-cream font-mono",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-[5px] text-[11px] font-semibold whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** A white plate with an optional ruled header strip. */
export function Plate({
  title,
  children,
  className = "",
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`plate overflow-hidden ${className}`}>
      {title && (
        <div className="border-b-[2.5px] border-ink bg-cream-panel px-3.5 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.12em]">
          {title}
        </div>
      )}
      <div className={title ? "" : "p-0"}>{children}</div>
    </div>
  );
}

/** Label/value rows inside a Plate. */
export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-mute">{label}</dt>
      <dd className="m-0 text-[13.5px] font-bold">{children}</dd>
    </>
  );
}

/** The three states the routes actually render, as small signed panels. */
export function StatePanel({
  kind,
  heading,
  children,
  detail,
}: {
  kind: "loading" | "error" | "empty";
  heading: string;
  children?: ReactNode;
  detail?: ReactNode;
}) {
  const bars = {
    loading: "Looking up",
    error: "Lookup failed",
    empty: "Nothing found",
  };
  return (
    <div className="mx-auto w-full max-w-[320px] border border-hairline bg-cream">
      <div className="bg-ink px-4 py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-cream">
        {bars[kind]}
      </div>
      <div className="flex flex-col items-center gap-3.5 px-5 py-8 text-center">
        {kind === "loading" && (
          <span
            role="status"
            aria-label="Loading"
            className="h-11 w-11 rounded-full border-[5px] border-[#e2ded1] border-t-blade"
            style={{ animation: "ringSpin 0.9s linear infinite" }}
          />
        )}
        {kind === "error" && (
          <span className="flex h-[62px] w-[62px] rotate-45 items-center justify-center rounded-[10px] border-4 border-ink bg-alarm">
            <span className="-rotate-45 text-[30px] font-black leading-none text-white">!</span>
          </span>
        )}
        {kind === "empty" && (
          <span className="relative inline-block h-[52px] w-[74px] rounded-lg border-[3px] border-dashed border-[#b9b3a2] bg-[#e6e2d6]">
            <span className="absolute left-4 top-[18px] h-[3px] w-6 bg-[#b9b3a2]" />
            <span className="absolute left-4 top-7 h-[3px] w-3.5 bg-[#b9b3a2]" />
          </span>
        )}
        <div>
          <div className="text-[15px] font-extrabold uppercase tracking-[0.04em]">{heading}</div>
          {children && (
            <div className="mt-1.5 text-[12.5px] font-semibold leading-relaxed text-ink-soft">{children}</div>
          )}
          {detail && (
            <div className="mt-2.5 inline-block rounded-md border-2 border-ink bg-white px-2.5 py-[5px] font-mono text-[11.5px] font-bold">
              {detail}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
