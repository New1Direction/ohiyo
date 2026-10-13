import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EventInfo } from "../../api";
import {
  agenda,
  dateOfKey,
  dayKey,
  dayLabel,
  eventsByDay,
  formatTime,
  monthGrid,
  moveDay,
  shiftMonth,
  viewerLocale,
  weekStartFor,
} from "../../lib/eventCalendar";
import "./events.css";

export type CalendarView = "month" | "agenda";

type Props = {
  events: EventInfo[];
  /** Now, in unix seconds: today is marked, and the agenda starts here. */
  now: number;
  /** The view to open on (phones: the agenda). Ignored once `view` is passed. */
  defaultView?: CalendarView;
  view?: CalendarView;
  onViewChange?: (view: CalendarView) => void;
  /** The day with focus (YYYY-MM-DD); its month is the one shown. Defaults to today. */
  day?: string;
  onDayChange?: (day: string) => void;
  onOpen: (eventId: string) => void;
};

/** How many titles a day cell shows before "+N more". */
const PER_CELL = 3;
const STEPS: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 };

/** A month grid (arrow keys move between days, Page Up/Down between months) and an agenda. */
export function EventCalendar({ events, now, defaultView = "month", view, onViewChange, day, onDayChange, onOpen }: Props) {
  const locale = viewerLocale();
  const todayKey = dayKey(new Date(now * 1000));
  const [ownView, setOwnView] = useState<CalendarView>(defaultView);
  const [ownDay, setOwnDay] = useState(todayKey);
  const shownView = view ?? ownView;
  const focusKey = day ?? ownDay;
  const setView = (next: CalendarView) => (onViewChange ? onViewChange(next) : setOwnView(next));
  const setDay = (next: string) => (onDayChange ? onDayChange(next) : setOwnDay(next));

  return (
    <div className="kc-cal">
      <div className="kc-cal-views" role="group" aria-label="View">
        {(["month", "agenda"] as const).map((v) => (
          <button key={v} type="button" aria-pressed={shownView === v} onClick={() => setView(v)} className="kc-cal-view kc-interactive">
            {v === "month" ? "Month" : "Agenda"}
          </button>
        ))}
      </div>
      {shownView === "month" ? (
        <MonthGrid events={events} todayKey={todayKey} focusKey={focusKey} setDay={setDay} onOpen={onOpen} locale={locale} />
      ) : (
        <Agenda events={events} now={now} todayKey={todayKey} onOpen={onOpen} locale={locale} />
      )}
    </div>
  );
}

type GridProps = {
  events: EventInfo[];
  todayKey: string;
  focusKey: string;
  setDay: (key: string) => void;
  onOpen: (id: string) => void;
  locale: string | undefined;
};

function MonthGrid({ events, todayKey, focusKey, setDay, onOpen, locale }: GridProps) {
  const focusDate = dateOfKey(focusKey);
  const year = focusDate.getFullYear();
  const month = focusDate.getMonth();
  const weekStart = weekStartFor(locale);
  const weeks = useMemo(() => monthGrid(year, month, weekStart), [year, month, weekStart]);
  const byDay = useMemo(() => eventsByDay(events), [events]);
  const gridRef = useRef<HTMLTableElement>(null);
  const moved = useRef(false);
  const title = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(year, month, 1));
  const dayName = new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric" });
  const weekdays = weeks[0].map((d) => ({
    short: new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d),
    long: new Intl.DateTimeFormat(locale, { weekday: "long" }).format(d),
  }));

  // After a key moves focus to another day (perhaps in another month), focus that cell.
  useLayoutEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-day="${focusKey}"]`)?.focus();
  }, [focusKey]);

  function go(next: string) {
    moved.current = true;
    setDay(next);
  }

  function sameDayIn(delta: number): string {
    const m = shiftMonth(year, month, delta);
    const last = new Date(m.year, m.month + 1, 0).getDate();
    return dayKey(new Date(m.year, m.month, Math.min(focusDate.getDate(), last)));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTableElement>) {
    const intoWeek = (focusDate.getDay() - weekStart + 7) % 7;
    let next: string | null = null;
    if (e.key in STEPS) next = moveDay(focusKey, STEPS[e.key]);
    else if (e.key === "Home") next = moveDay(focusKey, -intoWeek);
    else if (e.key === "End") next = moveDay(focusKey, 6 - intoWeek);
    else if (e.key === "PageDown") next = sameDayIn(e.shiftKey ? 12 : 1);
    else if (e.key === "PageUp") next = sameDayIn(e.shiftKey ? -12 : -1);
    if (!next) return;
    e.preventDefault();
    go(next);
  }

  const dayEvents = byDay.get(focusKey) ?? [];
  return (
    <>
      <div className="kc-cal-head">
        <h3 className="kc-cal-title" aria-live="polite">{title}</h3>
        <div className="kc-cal-nav">
          <button type="button" className="kc-cal-navbtn kc-interactive" aria-label="Previous month" onClick={() => setDay(sameDayIn(-1))}>‹</button>
          <button type="button" className="kc-cal-today kc-interactive" onClick={() => setDay(todayKey)}>Today</button>
          <button type="button" className="kc-cal-navbtn kc-interactive" aria-label="Next month" onClick={() => setDay(sameDayIn(1))}>›</button>
        </div>
      </div>
      <table ref={gridRef} role="grid" aria-label={title} className="kc-cal-grid" onKeyDown={onKeyDown}>
        <thead>
          <tr>
            {weekdays.map((w) => (
              <th key={w.long} scope="col" abbr={w.long}>{w.short}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={dayKey(week[0])}>
              {week.map((date) => {
                const key = dayKey(date);
                const list = byDay.get(key) ?? [];
                const outside = date.getMonth() !== month;
                const label = `${dayName.format(date)}${list.length ? `, ${list.length} ${list.length === 1 ? "event" : "events"}` : ""}`;
                return (
                  <td
                    key={key}
                    role="gridcell"
                    data-day={key}
                    tabIndex={key === focusKey ? 0 : -1}
                    aria-label={label}
                    aria-current={key === todayKey ? "date" : undefined}
                    aria-selected={key === focusKey}
                    className={`kc-cal-day${outside ? " is-outside" : ""}${key === todayKey ? " is-today" : ""}`}
                    onClick={() => setDay(key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && list[0]) onOpen(list[0].id);
                    }}
                  >
                    <span className="kc-cal-num" aria-hidden="true">{date.getDate()}</span>
                    {list.slice(0, PER_CELL).map((ev) => (
                      <button
                        key={ev.id}
                        type="button"
                        tabIndex={-1}
                        className={`kc-cal-chip${ev.cancelled ? " is-cancelled" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(ev.id);
                        }}
                      >
                        <span className="kc-cal-chip-time">{formatTime(ev.starts_at, locale)}</span> {ev.title}
                      </button>
                    ))}
                    {list.length > PER_CELL && <span className="kc-cal-more">+{list.length - PER_CELL} more</span>}
                    {list.length > 0 && <span className="kc-cal-dots" aria-hidden="true">{"•".repeat(Math.min(list.length, 3))}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <section className="kc-cal-dayl" aria-label={dayLabel(focusKey, todayKey, locale)}>
        <h4 className="kc-cal-dayl-title">{dayLabel(focusKey, todayKey, locale)}</h4>
        {dayEvents.length === 0 ? (
          <p className="kc-cal-empty">Nothing planned this day.</p>
        ) : (
          <EventList events={dayEvents} onOpen={onOpen} locale={locale} />
        )}
      </section>
    </>
  );
}

function Agenda({ events, now, todayKey, onOpen, locale }: { events: EventInfo[]; now: number; todayKey: string; onOpen: (id: string) => void; locale: string | undefined }) {
  const groups = agenda(events, now);
  if (groups.length === 0) {
    return <p className="kc-cal-empty kc-cal-empty-big">Nothing coming up. Plan something with New event.</p>;
  }
  return (
    <div className="kc-cal-agenda">
      {groups.map((g) => {
        const label = dayLabel(g.key, todayKey, locale);
        return (
          <section key={g.key} aria-label={label} className="kc-cal-agenda-day">
            <h4 className={`kc-cal-agenda-title${g.key === todayKey ? " is-today" : ""}`}>{label}</h4>
            <EventList events={g.events} onOpen={onOpen} locale={locale} />
          </section>
        );
      })}
    </div>
  );
}

function EventList({ events, onOpen, locale }: { events: EventInfo[]; onOpen: (id: string) => void; locale: string | undefined }) {
  return (
    <ul className="kc-cal-list">
      {events.map((ev) => (
        <li key={ev.id}>
          <button type="button" className={`kc-cal-item kc-interactive${ev.cancelled ? " is-cancelled" : ""}`} onClick={() => onOpen(ev.id)}>
            <span className="kc-cal-item-time">{formatTime(ev.starts_at, locale)}</span>
            <span className="kc-cal-item-title">{ev.title}</span>
            <span className="kc-cal-item-meta">
              {ev.cancelled ? "Cancelled" : `${ev.counts.going} going${ev.counts.interested ? ` · ${ev.counts.interested} interested` : ""}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
