import * as v from "valibot";

/** PostgreSQL UTC microseconds and era stay separate from selected JavaScript Date values. */
export const exactSearchTimestamp = v.strictObject({
  timestamp: v.pipe(
    v.string(),
    v.check((value) => {
      const match = /^(\d{4,6})(-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z( BC)?$/.exec(value);
      if (!match || Number(match[1]) < 1) return false;
      const year = match[3] ? 1 - Number(match[1]) : Number(match[1]);
      const isoYear =
        year >= 0 && year <= 9999
          ? String(year).padStart(4, "0")
          : `${year < 0 ? "-" : "+"}${String(Math.abs(year)).padStart(6, "0")}`;
      const iso = `${isoYear}${match[2]}Z`;
      const date = new Date(iso);
      return Number.isFinite(date.getTime()) && date.toISOString() === iso;
    }, "Unsupported timestamp boundary"),
  ),
});
