// pace.js — run rate, required rate and the month's day-by-day points.
//
// Pure: takes issues already fetched from Jira plus the user's clock (clock.js), so
// it's testable without Jira. Cricket terms on purpose — run rate is what you've
// been scoring per day, required rate is what you need from here.
//
// Definitions (all in the user's timezone):
//   working days   Mon–Fri of the user's month (no holiday calendar)
//   played         working days from the 1st up to and including today
//   earned on D    story points of tickets that moved to Done on D. A ticket finished
//                  on a weekend lands on the next working day's bar.
//   run rate       month points ÷ days played
//   needed today   (target − points) ÷ working days left including today
//   needed after   (target − points) ÷ working days left after today
//   projected      run rate × working days in the month

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (y, m0, d) => `${y}-${pad(m0 + 1)}-${pad(d)}`;
const round2 = (n) => Math.round(n * 100) / 100;

// yyyy-mm-dd of an instant, in the user's timezone.
export function localDate(instant, offsetMin) {
  const t = Date.parse(instant);
  if (!Number.isFinite(t)) return null;
  return new Date(t + offsetMin * 60000).toISOString().slice(0, 10);
}

export function workingDays(year, month0) {
  const days = [];
  const last = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) {
    const dow = new Date(Date.UTC(year, month0, d)).getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(isoOf(year, month0, d));
  }
  return days;
}

// issues: [{ key, summary, points (number|null), doneDate (yyyy-mm-dd|null), timeSpentSeconds }]
export function computePace({ issues, clock, totalPoints, target = null }) {
  const days = workingDays(clock.year, clock.month0);
  const today = clock.today;
  const todayIsWorkday = days.includes(today);

  // Where a done date lands: itself if a working day, else the next working day
  // (or the last one, for a weekend at the very end of the month).
  const slotOf = (date) => days.find((d) => d >= date) || days[days.length - 1];

  const perDay = new Map(days.map((d) => [d, { date: d, points: 0, count: 0 }]));
  const doneOn = new Map();                       // raw date -> tickets, for today/yesterday
  for (const i of issues) {
    if (!i.doneDate) continue;
    if (!doneOn.has(i.doneDate)) doneOn.set(i.doneDate, []);
    doneOn.get(i.doneDate).push(i);
    const slot = perDay.get(slotOf(i.doneDate));
    if (slot && i.points != null) { slot.points += i.points; slot.count += 1; }
  }

  const played = days.filter((d) => d <= today).length;
  const leftInclToday = days.filter((d) => d >= today).length;
  const leftAfterToday = leftInclToday - (todayIsWorkday ? 1 : 0);

  const summarize = (date) => {
    const list = date ? doneOn.get(date) || [] : [];
    return {
      date,
      points: round2(list.reduce((s, i) => s + (i.points ?? 0), 0)),
      count: list.length,
      timeSpentSeconds: list.reduce((s, i) => s + (i.timeSpentSeconds || 0), 0),
      tickets: list.map((i) => ({
        key: i.key, summary: i.summary, points: i.points, timeSpentSeconds: i.timeSpentSeconds || 0, url: i.url || null,
      })),
    };
  };
  // "Yesterday" = the last working day before today (Monday looks back to Friday).
  const prev = [...days].reverse().find((d) => d < today) || null;

  const runRate = played ? totalPoints / played : 0;
  const remaining = target ? Math.max(0, target - totalPoints) : null;
  const per = (n) => (remaining == null ? null : remaining === 0 ? 0 : n > 0 ? remaining / n : null);

  return {
    workingDays: days.length,
    played,
    leftInclToday,
    leftAfterToday,
    todayIsWorkday,
    daily: [...perDay.values()].map((d) => ({ ...d, points: round2(d.points) })),
    today: summarize(today),
    yesterday: summarize(prev),
    runRate: round2(runRate),
    remaining: remaining == null ? null : round2(remaining),
    neededToday: per(leftInclToday) == null ? null : round2(per(leftInclToday)),
    neededAfterToday: per(leftAfterToday) == null ? null : round2(per(leftAfterToday)),
    projected: round2(runRate * days.length),
    onPace: target ? runRate * days.length >= target : null,
    targetHit: target ? totalPoints >= target : null,
  };
}
