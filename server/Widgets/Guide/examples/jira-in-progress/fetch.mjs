// Input on stdin: { params, secrets, context }. The secrets are the ones widget.json lists, entered by
// the user in Hangar; never print them. Output: the data, as JSON. Anything on stderr is the error.
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const { secrets } = JSON.parse(raw);

const base = secrets.JIRA_BASE_URL.replace(/\/+$/, "");
const auth = Buffer.from(`${secrets.JIRA_EMAIL}:${secrets.JIRA_API_TOKEN}`).toString("base64");

const res = await fetch(`${base}/rest/api/3/search/jql`, {
  method: "POST",
  headers: { Authorization: `Basic ${auth}`, Accept: "application/json", "Content-Type": "application/json" },
  body: JSON.stringify({
    jql: 'assignee = currentUser() AND statusCategory = "In Progress" ORDER BY updated DESC',
    fields: ["summary", "status", "priority"],
    maxResults: 50,
  }),
});
if (!res.ok) {
  console.error(`Jira answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}

const body = await res.json();
const issues = (body.issues ?? []).map((i) => ({
  key: i.key,
  summary: i.fields.summary,
  status: i.fields.status?.name ?? "",
  priority: i.fields.priority?.name ?? "",
  url: `${base}/browse/${i.key}`,
}));

process.stdout.write(JSON.stringify({ count: issues.length, issues }));
