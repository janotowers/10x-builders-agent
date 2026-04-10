/** Calendar ID in path: `primary` or URL-encoded email/id. */
export function calendarIdPathSegment(calendarId: string): string {
  if (calendarId === "primary") return "primary";
  return encodeURIComponent(calendarId);
}

export async function googleCalendarJson(
  accessToken: string,
  pathOrUrl: string,
  init?: RequestInit
): Promise<{ status: number; data: unknown }> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://www.googleapis.com/calendar/v3${pathOrUrl}`;
  const headers: HeadersInit = {
    Authorization: `Bearer ${accessToken}`,
    ...(init?.headers ?? {}),
  };
  const body = init?.body;
  const hdrObj = headers as Record<string, string>;
  if (body && !hdrObj["Content-Type"]) {
    hdrObj["Content-Type"] = "application/json";
  }
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { status: res.status, data };
}

export function calendarEventsPath(calendarId: string, query: string): string {
  return `/calendars/${calendarIdPathSegment(calendarId)}/events${query}`;
}

export async function calendarFreeBusyQuery(
  accessToken: string,
  payload: {
    timeMin: string;
    timeMax: string;
    items: Array<{ id: string }>;
  }
) {
  return googleCalendarJson(
    accessToken,
    "https://www.googleapis.com/calendar/v3/freeBusy",
    { method: "POST", body: JSON.stringify(payload) }
  );
}

export function buildEventResource(args: {
  summary: string;
  start_datetime: string;
  end_datetime: string;
  timezone: string;
  description?: string;
}): Record<string, unknown> {
  return {
    summary: args.summary,
    description: args.description ?? "",
    start: {
      dateTime: args.start_datetime,
      timeZone: args.timezone,
    },
    end: {
      dateTime: args.end_datetime,
      timeZone: args.timezone,
    },
  };
}

export async function executeCalendarCreateEvent(
  accessToken: string,
  calendarId: string,
  body: Record<string, unknown>
) {
  return googleCalendarJson(
    accessToken,
    `/calendars/${calendarIdPathSegment(calendarId)}/events`,
    { method: "POST", body: JSON.stringify(body) }
  );
}

export async function executeCalendarPatchEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  body: Record<string, unknown>
) {
  const eid = encodeURIComponent(eventId);
  return googleCalendarJson(
    accessToken,
    `/calendars/${calendarIdPathSegment(calendarId)}/events/${eid}`,
    { method: "PATCH", body: JSON.stringify(body) }
  );
}

export async function executeCalendarDeleteEvent(
  accessToken: string,
  calendarId: string,
  eventId: string
) {
  const eid = encodeURIComponent(eventId);
  return googleCalendarJson(
    accessToken,
    `/calendars/${calendarIdPathSegment(calendarId)}/events/${eid}`,
    { method: "DELETE" }
  );
}
