// SPDX-License-Identifier: AGPL-3.0-only
// Small dependency-free SVG charts. They only ever draw real API data; callers show an empty state when there is none.
import React from "react";

/** Vertical bars by day. Each bar is labelled; values are shown on hover/focus and in an accessible table. */
export function DayBars({ data, fmt, height = 160 }: { data: { label: string; value: number }[]; fmt: (n: number) => string; height?: number }) {
  const max = Math.max(1, ...data.map(d => d.value)), w = 100 / Math.max(1, data.length);
  return <figure className="chart">
    <div className="bars" style={{ height }} aria-hidden>
      {data.map((d, i) => <div key={i} className="bar-col" style={{ width: `${w}%` }} title={`${d.label}: ${fmt(d.value)}`}>
        <span className="bar-v">{d.value ? fmt(d.value) : ""}</span>
        <span className="bar-b" style={{ height: `${Math.max(d.value ? 3 : 0, d.value / max * 100)}%` }} />
        <span className="bar-l">{d.label}</span></div>)}
    </div>
    <table className="sr-only"><tbody>{data.map((d, i) => <tr key={i}><th>{d.label}</th><td>{fmt(d.value)}</td></tr>)}</tbody></table>
  </figure>;
}

/** Horizontal bars, e.g. order value by rep. */
export function HBars({ data, fmt, sub }: { data: { label: string; value: number; sub?: string }[]; fmt: (n: number) => string; sub?: boolean }) {
  const max = Math.max(1, ...data.map(d => d.value));
  return <div className="hbars">{data.map((d, i) => <div key={i} className="hbar">
    <div className="hbar-h"><span className="hbar-l">{d.label}</span><b className="num">{fmt(d.value)}</b></div>
    <div className="hbar-t"><span style={{ width: `${d.value / max * 100}%` }} /></div>
    {sub && d.sub && <span className="muted small">{d.sub}</span>}</div>)}</div>;
}

/** Thin progress bar with a label, for real completion ratios only. */
export const Progress = ({ done, total }: { done: number; total: number }) =>
  <div className="prog" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}><span style={{ width: `${total ? Math.min(100, done / total * 100) : 0}%` }} /></div>;
