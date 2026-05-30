# Export Mailchimp Campaign Openers via API

## Summary

Yes. Mailchimp’s Marketing API provides a direct way to export the email addresses of contacts who opened a specific campaign.

Use the Campaign Open Reports endpoint:

```http
GET /reports/{campaign_id}/open-details
```

This endpoint returns detailed information about list members who opened a campaign email.

---

## Endpoint

```http
GET https://<dc>.api.mailchimp.com/3.0/reports/{campaign_id}/open-details
```

Where:

- `<dc>` is your Mailchimp data center, such as `us6`
- `{campaign_id}` is the Mailchimp campaign ID

Example:

```http
GET https://us6.api.mailchimp.com/3.0/reports/CAMPAIGN_ID/open-details
```

---

## How to Find the Data Center

Your Mailchimp API key usually ends with a suffix like:

```text
xxxxxxxxxxxxxxxxxxxxxxxx-us6
```

The suffix after the dash is the data center.

For example:

```text
API key: abc123abc123-us6
Data center: us6
Base URL: https://us6.api.mailchimp.com/3.0/
```

---

## Authentication

For an internal tool, the simplest approach is API key authentication using Basic Auth.

The username can be any string. The password is your Mailchimp API key.

Example using `curl`:

```bash
curl --request GET \
  --url "https://us6.api.mailchimp.com/3.0/reports/CAMPAIGN_ID/open-details?count=1000&offset=0" \
  --user "anystring:YOUR_API_KEY"
```

---

## Pagination

Mailchimp uses `count` and `offset` for pagination.

Recommended settings:

```text
count=1000
offset=0
```

Then continue increasing the offset:

```http
GET /reports/{campaign_id}/open-details?count=1000&offset=0
GET /reports/{campaign_id}/open-details?count=1000&offset=1000
GET /reports/{campaign_id}/open-details?count=1000&offset=2000
```

Continue until the returned `open_details` array is empty or has fewer than `count` records.

---

## Fields to Export

From each item in `open_details`, export:

```text
email_address
opens_count
campaign_id
list_id
subscriber_hash
```

The most important field is:

```text
email_address
```

---

## Recommended API Call

```http
GET https://<dc>.api.mailchimp.com/3.0/reports/{campaign_id}/open-details?count=1000&offset=0
```

Optional optimized version using partial fields:

```http
GET https://<dc>.api.mailchimp.com/3.0/reports/{campaign_id}/open-details?count=1000&offset=0&fields=open_details.email_address,open_details.opens_count,open_details.subscriber_hash,total_items
```

---

## Minimal Node.js Example

```js
import fs from "fs";

const API_KEY = process.env.MAILCHIMP_API_KEY;
const CAMPAIGN_ID = process.env.MAILCHIMP_CAMPAIGN_ID;

// API key format is usually: xxxxxxxxxxxxxxxxx-us6
const dc = API_KEY.split("-").pop();

async function mailchimpGet(path) {
  const url = `https://${dc}.api.mailchimp.com/3.0${path}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization:
        "Basic " + Buffer.from(`anystring:${API_KEY}`).toString("base64"),
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mailchimp error ${res.status}: ${text}`);
  }

  return res.json();
}

async function exportOpeners() {
  const count = 1000;
  let offset = 0;
  const rows = [];

  while (true) {
    const data = await mailchimpGet(
      `/reports/${CAMPAIGN_ID}/open-details?count=${count}&offset=${offset}`
    );

    const openDetails = data.open_details || [];

    for (const item of openDetails) {
      rows.push({
        email: item.email_address,
        opens_count: item.opens_count,
        campaign_id: item.campaign_id,
        list_id: item.list_id,
        subscriber_hash: item.subscriber_hash,
      });
    }

    if (openDetails.length < count) break;

    offset += count;
  }

  const csv = [
    "email,opens_count,campaign_id,list_id,subscriber_hash",
    ...rows.map((r) =>
      [
        r.email,
        r.opens_count,
        r.campaign_id,
        r.list_id,
        r.subscriber_hash,
      ]
        .map((v) => `"${String(v ?? "").replaceAll('"', '""')}"`)
        .join(",")
    ),
  ].join("\n");

  fs.writeFileSync("mailchimp_openers.csv", csv);
  console.log(`Exported ${rows.length} openers`);
}

exportOpeners().catch(console.error);
```

---

## Implementation Flow

1. Store `MAILCHIMP_API_KEY` securely on the server.
2. Derive the data center from the API key suffix.
3. Store or retrieve the Mailchimp `campaign_id`.
4. Call:

   ```http
   GET https://<dc>.api.mailchimp.com/3.0/reports/{campaign_id}/open-details?count=1000&offset=0
   ```

5. Read the `open_details` array from the response.
6. Extract `email_address` from each record.
7. Increment `offset` by 1000 and repeat until all records are retrieved.
8. Export the results to CSV, database, or CRM.

---

## Important Caveat

Email open tracking is not perfect. Opens are usually tracked through image loading / tracking pixels, so privacy tools and email clients may undercount or overcount opens.

This API gives you Mailchimp’s reported open data, not a guaranteed record of every human who viewed the email.

---

## Final Answer

To export email addresses of contacts who opened a Mailchimp campaign, use:

```http
GET /reports/{campaign_id}/open-details
```

Then page through the `open_details` response and extract:

```text
email_address
```
