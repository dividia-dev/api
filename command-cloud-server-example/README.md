# Command Cloud to Dividia: an example of your server

A working example of the Command Cloud side of the integration: sending a ticket to Dividia and
getting its PDF back. One file, `server.js`. Node.js 18 or later. No packages.

**The page is only a tester.** Its buttons stand in for something happening in your system, such as
a ticket being printed. In your real system no browser takes part: the ticket and your records are
already on your server, and your server does all the work.

**`server.js` is test code that stands in for your backend service.** It is not something to
deploy. The real integration is the same two calls, `sendTicket()` and `getTicketPdf()`, written
inside your own backend.

It is built to show three rules:

1. **Dividia gives you two values for each customer:** a Customer ID and a customer secret. Dividia
   sends them to Command when the customer is set up in ScaleWatcher Cloud. They are not given to
   the customer.
2. **You store them on your servers before you send that customer's first ticket.** Your server looks
   them up for every request. Never on the customer's computer: the customer does not need them.
3. **Your servers make every call to Dividia.** The customer's computer never calls Dividia.

## Run it

```bash
export DIVIDIA_CUSTOMER_ID='the Customer ID Dividia gave you'
export DIVIDIA_SECRET='whsec_...'     # the customer secret Dividia gave you
node server.js --location '<location.id>' --location-name '<location.name>' --scale '<scaleId>'
```

The values are the ones Dividia gave you for the customer and its site. None of them is written in
the file.

Open <http://localhost:8787>. The page is served by `server.js`. `server.js` is "your server": it
holds every value and makes the calls to Dividia. The page holds nothing.

The page has three parts:

1. **The values, in `server.js`.** Each value, how you set it, how it is sent to Dividia, and where
   it comes from in your system:

   | Value | Set with | Sent to Dividia as | In your system it comes from |
   |---|---|---|---|
   | Customer ID | `DIVIDIA_CUSTOMER_ID` | header `Dividia-Customer-Id` | your record of the customer |
   | Customer secret | `DIVIDIA_SECRET` | header `Authorization: Bearer` | your record of the customer |
   | Site id | `--location` | body `location.id` | the ticket |
   | Site name | `--location-name` | body `location.name` | the ticket |
   | Scale id | `--scale` | body `scaleId` | the ticket |

   The page cannot change them. To use other values, stop `server.js` and start it again.
2. **The two requests `server.js` sends to Dividia**, with the values in place.
3. **Try it.** Press **Send a ticket**, then **Get the PDF**. The page lists each step: what it asked
   `server.js`, the request `server.js` made to Dividia, and Dividia's answer. Sending a ticket is
   real: the site's cameras photograph the scale.

## How to read `server.js`

| Part | What it is | In your system |
|---|---|---|
| **1. The values** | The Customer ID, the secret, and the ticket's `location.id`, `location.name` and `scaleId`. All on the server. | The Customer ID and secret are in your database. The site and scale come with each ticket. |
| **2. Your two calls** | `sendTicket()` and `getTicketPdf()`. The only code that talks to Dividia. Both send the same two headers. | The same two calls, in your language. |
| **3. The tester** | What the page's two buttons call. The page sends nothing but "send a ticket" and a ticket number. | Nothing. Your own code calls the two functions. |

## The two requests your server makes

Send a ticket:

```
POST https://api.cloud.dividia.net/sw/webhooks/cc
Authorization: Bearer whsec_...
Dividia-Customer-Id: <Customer ID>
Content-Type: application/json

{
  "uniqueId": "...",                 new for every ticket
  "ticketNumber": "...",
  "ticketDateTime": "...",
  "vehicle": {...}, "carrier": {...}, "customer": {...},
  "project": {...}, "product": {...}, "orderId": "...",
  "location": { "id": "<location.id>", "name": "<location.name>" },     picks the site
  "scaleId": "<scaleId>"                                                picks the scale
}
```

Get a ticket's PDF:

```
GET https://api.cloud.dividia.net/sw/api/tickets/pdf?locationId=<location.id>&ticket=<ticket number>
Authorization: Bearer whsec_...
Dividia-Customer-Id: <Customer ID>
```

Dividia's answers and what to do with each are in the comments above `sendTicket()` and
`getTicketPdf()`.

### The PDF's file name

Dividia names the file in the `Content-Disposition` header of its answer:
`<Dividia site number>-<location.id>-ticket_<ticket number>.pdf`, for example
`1234-PLANT-7-ticket_70421.pdf`. The example passes that name on to the browser. You can keep
it or give the file your own name; if your server sends no name, the browser makes one up.

## Check it yourself

Open the browser's network view while you press the buttons. The page calls only
`localhost:8787/tester/...`. No request goes to Dividia from the browser, and neither the Customer ID
nor the secret is in any request or response.

## If it does not work

| What you see | Cause | What to do |
|---|---|---|
| The page shows **No answer from Dividia** | Your server cannot reach Dividia. | Allow outbound HTTPS (port 443) from your server to `api.cloud.dividia.net`. Check with `curl -i https://api.cloud.dividia.net/sw/api/tickets/pdf`: a `401` means the network path is good. |
| An error about `fetch`, `AbortSignal.timeout` or `Object.hasOwn` when starting or sending | Node.js is older than 18. | Run `node --version` and use Node.js 18 or later. |
| **429**, "Too many requests" | A rate limit. Sending tickets: 6,000 per 15 minutes from one server address. PDFs: 60 per minute, one at a time. | Wait for the time in the `Retry-After` header, then send the same request again. |
| **401** | The Customer ID or the secret is wrong. | Check both values on your server. Copy them with no spaces or line breaks. |
| **403** on the PDF | The `location.id` is not one of this customer's sites. | Check the `location.id`. |
| The port is in use when starting | Another program has port 8787. | Start with `--port <another port>`. |

CORS does not apply. Your server calls Dividia, not the browser, and CORS is a browser rule. A call
made to Dividia straight from a web page is blocked by the browser, by design.

## Notes

- The example listens on your own computer only (`127.0.0.1`) and has no sign-in. It answers only
  its own page on `localhost`, refuses a page on any other site, and never follows a redirect with
  your headers. It is an example, not something to deploy.
- It will not start without `--location` and `--scale`, so a made-up value is never sent to Dividia.
- On a temporary failure (`429`, `5xx`, no answer) it tries up to three times in all. A real system keeps the
  ticket in a queue and retries for longer. The same `uniqueId` never creates a second ticket.
- The secret does not expire. Dividia can replace it (the old one works for 24 more hours) or stop
  it immediately.
