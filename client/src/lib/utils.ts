import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Parse a date for display. A plain calendar date ("2026-09-29", as stored
 * for report_date from the workbook's D3 cell) is built in LOCAL time so it
 * never slides back a day in US time zones (new Date("2026-09-29") is UTC
 * midnight, which renders as 9/28 in Central). Full timestamps pass through.
 */
export function parseDisplayDate(d: string | null | undefined): Date {
  const s = String(d ?? "");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(s);
}
