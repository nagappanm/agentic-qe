# Tracker adapters

How a canonical defect report (`schemas/defect-report.json`) maps onto each tracker's fields, and the exact MCP calls to make. Filing happens through MCP tools, not a hand-rolled REST client — there is no HTTP code in this skill and no credentials for it to hold.

**Verification status.** The Jira and GitHub mappings below are derived from the MCP tool schemas, which are authoritative for the parameters those tools accept. They were **not** exercised against a live Jira during development: the Atlassian site connected to this workspace carries Confluence scopes only (`read:page:confluence`, `search:confluence`, …) and no Jira scopes, so `getVisibleJiraProjects` returns 404. Before the first real filing, run the discovery step below — it is cheap, read-only, and catches a project whose Bug type demands fields this table does not set.

---

## Jira (Atlassian Rovo MCP)

### Discovery — always run before the first filing into a new project

```
getAccessibleAtlassianResources()                    → cloudId
getVisibleJiraProjects(cloudId, action: "create")    → projectKey, available issue types
getJiraProjectIssueTypesMetadata(cloudId, projectIdOrKey) → required fields per issue type
```

The third call is the one that matters: a project can mark Components, Affects Version, or a custom "Environment" field as required, and `createJiraIssue` fails the whole call if any is missing. Read the metadata, then extend `additional_fields` to cover whatever it marks required.

### Field mapping

| Report path | Jira field | Notes |
|---|---|---|
| `title` | `summary` | Already in `[Component] fails [Condition] causing [Impact]` form |
| rendered `jira-adf` | `description` | Pass with `contentFormat: "adf"`. **32000 character cap** — `render.js` warns above that threshold |
| — | `issueTypeName` | `"Bug"` for defects. Confirm it exists via discovery; some projects rename it (`Defect`, `Fault`) |
| — | `projectKey` | Required. Never guess it — take it from discovery or from the user |
| `classification.priority` | `additional_fields.priority` | `{"priority": {"name": "High"}}`. Jira priority names are per-instance; map P0→Highest, P1→High, P2→Medium, P3/P4→Low only after confirming those names exist |
| `triage.labels` + `classification.defect_type` | `additional_fields.labels` | `{"labels": ["checkout", "integration-contract"]}`. Jira labels may not contain spaces |
| `triage.suggested_team` | `additional_fields.components` | `{"components": [{"name": "Checkout"}]}`. The component must already exist in the project or the call fails |
| `environment.app_version` | `additional_fields.versions` | Affects Version. Same pre-existence constraint |
| `triage.suggested_assignee` | `assignee_account_id` | Needs an account ID, not a name — resolve with `lookupJiraAccountId`. **Leave unset by default**: a wrong auto-assignment costs a triager more time than an empty field |
| `fingerprint` | a label, or a custom field | Store it somewhere queryable so the dedupe search below works. `additional_fields.labels` with `fp-<fingerprint>` works without any project configuration |

`additional_fields` is the **only** route for priority, labels, components, versions, and custom fields — they have no dedicated parameters.

### Dedupe before filing

```
searchJiraIssuesUsingJql(cloudId, jql: 'project = PROJ AND labels = "fp-07c87d4cef395d6f" ORDER BY created DESC')
```

A hit means this defect is already filed. Add a comment with the new occurrence via `addCommentToJiraIssue` instead of creating a second ticket — duplicate defects split the evidence across two threads, which is precisely what the fingerprint exists to prevent.

### Create

```
createJiraIssue(
  cloudId, projectKey, issueTypeName: "Bug",
  summary: <report.title>,
  description: <ADF document object from render.js --format jira-adf>,
  contentFormat: "adf",
  additional_fields: { labels: [...], priority: {name: ...}, components: [...] }
)
```

Attachments are not part of `createJiraIssue`. Upload them after creation, and only after `redact.js` has cleared the report — a HAR file is the single most likely place for a session cookie to escape.

---

## GitHub Issues (github MCP)

### Field mapping

| Report path | GitHub field | Notes |
|---|---|---|
| `title` | `title` | |
| rendered `github-body` | `body` | Markdown plus the full JSON in a collapsed `<details>` block, so a human reads the summary and an agent parses the exact same facts. **65536 character cap** — `render.js` warns above 60000 |
| `triage.labels` | `labels` | Created on demand if missing, unlike Jira components |
| `classification.severity` | `labels` | Add as `severity:critical` — GitHub has no severity field |
| `fingerprint` | `labels` | `fp-<fingerprint>`, same rationale as Jira |
| `triage.suggested_assignee` | `assignees` | Usernames. Same default-off posture as Jira |
| `classification.defect_type` | `type` | Only where repository issue types are enabled — check `list_issue_types` first, and omit the parameter entirely if unsupported |

### Dedupe

```
search_issues(owner, repo, query: "<report.title>")     # semantic match
list_issues(owner, repo, labels: ["fp-07c87d4cef395d6f"])  # exact fingerprint match
```

Prefer the label search for a definitive answer; the semantic search is a useful second pass for a defect filed before fingerprinting was in use.

### Create

```
issue_write(method: "create", owner, repo,
            title: <report.title>,
            body: <github-body from render.js>,
            labels: [...])
```

---

## Local file (default)

No tracker, no network. `build-report.js --out .aqe/defect-reports/<fingerprint>.json` plus `render.js --out .aqe/defect-reports/<fingerprint>.md` gives a reviewable pair on disk. This is the default for a reason: a report is worth reviewing before it is published, and publishing is the step that cannot be undone.

---

## Azure DevOps and Linear — not implemented

Both are straightforward to add, and neither needs a schema change. They are absent because they could not be verified in development, and an unverified adapter inside a Tier 3 skill is worse than an honest gap.

**Azure DevOps** — `POST /{org}/{project}/_apis/wit/workitems/${Bug}?api-version=7.0` with a JSON-Patch body. Notable mismatches: the description belongs in `Microsoft.VSTS.TCM.ReproSteps` rather than `System.Description` for Bug work items; `Microsoft.VSTS.Common.Severity` uses the literal strings `"1 - Critical"` … `"4 - Low"`; and the body must be HTML, so a Markdown→HTML step is required (ADF does not apply).

**Linear** — GraphQL `issueCreate` mutation. `description` takes Markdown directly, so the `markdown` rendering is usable as-is. Priority is an integer 0–4 (0 = none, 1 = urgent), and labels must be resolved to label IDs before the mutation.

For either, add a row-for-row mapping table here first, then verify against a real instance before claiming support.
