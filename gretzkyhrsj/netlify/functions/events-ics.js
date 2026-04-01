export async function handler() {
  try {
    const company = "sharks";
    const productId = "963";
    const facilityId = "1";

    const today = new Date();
    const todayFloor = new Date(today);
    todayFloor.setHours(0, 0, 0, 0);

    const endOfYear = new Date(today.getFullYear(), 11, 31);

    function formatDateTime(d, endOfDay) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day} ${endOfDay ? "23:59:59" : "00:00:00"}`;
    }

    function toICSDateUTC(dateString) {
      const d = new Date(dateString);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      const ss = String(d.getUTCSeconds()).padStart(2, "0");
      return `${y}${m}${day}T${hh}${mm}${ss}Z`;
    }

    function escapeICS(text) {
      return String(text || "")
        .replace(/\\/g, "\\\\")
        .replace(/\r?\n/g, "\\n")
        .replace(/,/g, "\\,")
        .replace(/;/g, "\\;");
    }

    function foldLine(line) {
      const max = 74;
      if (line.length <= max) return line;
      let out = "";
      let remaining = line;
      while (remaining.length > max) {
        out += remaining.slice(0, max) + "\r\n ";
        remaining = remaining.slice(max);
      }
      out += remaining;
      return out;
    }

    async function fetchJson(url) {
      const resp = await fetch(url, {
        headers: {
          "Accept": "application/vnd.api+json, application/json;q=0.9, */*;q=0.8"
        }
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${url}`);
      }

      return await resp.json();
    }

    function indexIncluded(included) {
      const map = new Map();
      if (!Array.isArray(included)) return map;
      for (const item of included) {
        map.set(`${item.type}:${item.id}`, item);
      }
      return map;
    }

    function getRelData(obj, relName) {
      if (!obj || !obj.relationships) return null;
      const rel = obj.relationships[relName];
      if (!rel) return null;
      return rel.data || null;
    }

    function getIncludedName(includedMap, relData) {
      if (!relData || !relData.type || !relData.id) return "";
      const item = includedMap.get(`${relData.type}:${relData.id}`);
      if (!item || !item.attributes) return "";
      return item.attributes.name || "";
    }

    function pickSummary(eventItem, includedMap) {
      const rel = getRelData(eventItem, "summary");
      if (!rel) return null;
      return includedMap.get(`${rel.type}:${rel.id}`) || null;
    }

    function getResourceName(eventItem, includedMap) {
      let name = getIncludedName(includedMap, getRelData(eventItem, "resource"));
      if (name) return name;

      name = getIncludedName(includedMap, getRelData(eventItem, "resourceArea"));
      if (name) return name;

      return "";
    }

    const teamsUrl =
      "https://apps.daysmartrecreation.com/dash/jsonapi/api/v1/teams" +
      `?company=${encodeURIComponent(company)}` +
      "&type=teams" +
      "&page[size]=1000" +
      `&filter[product_id]=${encodeURIComponent(productId)}`;

    const teamsObj = await fetchJson(teamsUrl);
    const teams = Array.isArray(teamsObj.data) ? teamsObj.data : [];

    const upcomingTeams = teams
      .filter((team) => {
        const a = team.attributes || {};
        if (!a.start_date) return false;
        return new Date(a.start_date) >= todayFloor;
      })
      .sort((a, b) => {
        return new Date(a.attributes.start_date) - new Date(b.attributes.start_date);
      });

    if (!upcomingTeams.length) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: "No upcoming team found."
      };
    }

    const currentTeamId = upcomingTeams[0].id;

    const eventsUrl =
      "https://apps.daysmartrecreation.com/dash/jsonapi/api/v1/events" +
      "?cache[save]=false" +
      "&page[size]=250" +
      "&sort=start" +
      `&company=${encodeURIComponent(company)}` +
      `&filter[start__gte]=${encodeURIComponent(formatDateTime(todayFloor, false))}` +
      `&filter[start__lte]=${encodeURIComponent(formatDateTime(endOfYear, true))}` +
      "&filter[resource.facility.my_sam_visible]=true" +
      "&filter[eventType.code__not]=L" +
      "&filter[eventType.code]=k" +
      `&filter[resource.facility.id]=${encodeURIComponent(facilityId)}` +
      "&filterRelations[comments.comment_type]=public" +
      "&include=homeTeam.league.programType,visitingTeam.league.programType,summary,resource.facility,resourceArea,comments,eventType" +
      `&filter[hteam_id]=${encodeURIComponent(currentTeamId)}`;

    const eventsObj = await fetchJson(eventsUrl);
    const events = Array.isArray(eventsObj.data) ? eventsObj.data : [];
    const includedMap = indexIncluded(eventsObj.included);

    const nowStamp = toICSDateUTC(new Date().toISOString());
    const vevents = [];

    for (const eventItem of events) {
      const a = eventItem.attributes || {};
      const summary = pickSummary(eventItem, includedMap);
      const sa = summary && summary.attributes ? summary.attributes : {};

      const startGmt = a.start_gmt;
      const endGmt = a.end_gmt;
      if (!startGmt || !endGmt) continue;

      const startDate = new Date(startGmt);
      if (startDate < todayFloor) continue;

      const title = sa.name || "Event";
      const rink = getResourceName(eventItem, includedMap);
      const description = a.best_description
        ? a.best_description.replace(/<[^>]+>/g, "").trim()
        : "";

      const lines = [
        "BEGIN:VEVENT",
        `UID:daysmart-${eventItem.id}@${company}`,
        `DTSTAMP:${nowStamp}`,
        `DTSTART:${toICSDateUTC(startGmt)}`,
        `DTEND:${toICSDateUTC(endGmt)}`,
        foldLine(`SUMMARY:${escapeICS(title)}`),
        foldLine(`LOCATION:${escapeICS(rink)}`),
        foldLine(`DESCRIPTION:${escapeICS(description)}`),
        "END:VEVENT"
      ];

      vevents.push(lines.join("\r\n"));
    }

    const calendar = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//OpenAI//DaySmart Netlify Feed//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Gretzky Hour",
      "X-WR-TIMEZONE:America/Los_Angeles",
      ...vevents,
      "END:VCALENDAR"
    ].join("\r\n");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "public, max-age=300"
      },
      body: calendar
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: `ICS generation failed: ${err.message}`
    };
  }
}
