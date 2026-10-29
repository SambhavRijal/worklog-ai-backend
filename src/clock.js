// clock.js — "today" and "this month" in the USER's timezone, not the server's.
//
// The backend runs wherever it's deployed (Vercel is UTC), so new Date() there says
// nothing about the user's day: at 5am in Kathmandu it's still yesterday in UTC. The
// extension sends its UTC offset on every request (X-TZ-Offset, minutes east of UTC)
// and every date decision goes through the clock built from it.
//
// Without the header we fall back to UTC — the old behaviour — so an outdated
// extension keeps working, just on server time.

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m0, d) => {
  const t = new Date(Date.UTC(y, m0, d));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

export function clockFromRequest(req, now = new Date()) {
  const raw = Number(req.get?.('X-TZ-Offset') ?? req.query?.tz);
  // Real offsets run from -12:00 to +14:00.
  const offsetMin = Number.isFinite(raw) && Math.abs(raw) <= 14 * 60 ? Math.round(raw) : 0;
  return clockAt(now, offsetMin);
}

export function clockAt(now, offsetMin = 0) {
  const local = new Date(now.getTime() + offsetMin * 60000);
  const y = local.getUTCFullYear();
  const m0 = local.getUTCMonth();
  const d = local.getUTCDate();
  return {
    offsetMin,
    today: iso(y, m0, d),                                                   // yyyy-mm-dd, user's date
    startOfDayEpoch: Math.floor((Date.UTC(y, m0, d) - offsetMin * 60000) / 1000), // user's midnight, epoch s
    minutesSinceMidnight: local.getUTCHours() * 60 + local.getUTCMinutes(),
    year: y,
    month0: m0,
    monthStart: iso(y, m0, 1),                                              // yyyy-mm-01
    nextMonthStart: iso(y, m0 + 1, 1),
  };
}
