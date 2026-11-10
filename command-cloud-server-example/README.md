# Command Cloud to Dividia: an example of your server

A working example of the Command Cloud side of the integration: sending a ticket to Dividia and
getting its PDF back. One file, `server.js`. Node.js 18 or later. No packages.

It is built to show three rules:

1. **Dividia gives you two values for each customer:** a Customer ID and a customer secret.
2. **You store them on your servers.** Never on the customer's computer. The customer does not need them.
3. **Your servers make every call to Dividia.** The customer's computer never calls Dividia.

## Run it

```bash
export DIVIDIA_CUSTOMER_ID='the Customer ID Dividia gave you'
export DIVIDIA_SECRET='whsec_...'     # the customer secret Dividia gave you
node server.js --location '<location.id>' --scale '<scaleId>'
```

The four values are the ones Dividia gave you for the customer and its site. None of them is
written in the file.

Open <http://localhost:8787>. Press **Send a ticket**, then **Get the PDF**.

The page shows each step as it happens: what the browser asked your server, what your server looked
up, the request your server made to Dividia, and Dividia's answer. Sending a ticket is real: the
site's cameras photograph the scale.

## How to read `server.js`

| Part | What it is | In your system |
|---|---|---|
| **1. Your records** | One customer with its Customer ID and secret, one site with its `location.id`, one scale with its `scaleId`. | Your customer, site and scale records. |
| **2. Your two calls** | `sendTicket()` and `getTicketPdf()`. The only code that talks to Dividia. Both send the same two headers. | The same two calls, in your language. |
| **3. Your endpoints** | What the page calls. It sends your own keys for the customer, site and scale, and never a Dividia value. | Your own application's endpoints, behind your sign-in. |

The sample record in Part 1 takes its `location.id` and `scaleId` from the `--location` and
`--scale` options, and its Customer ID and secret from the two variables. In your system all four
come from your own records.

## The two requests your server makes

Send a ticket:

```
POST https://api.cloud.dividia.net/sw/webhooks/cc
Authorization: Bearer whsec_...
Dividia-Customer-Id: <Customer ID>
Content-Type: application/json

{ the ticket, in the approved payload schema }
```

Get a ticket's PDF:

```
GET https://api.cloud.dividia.net/sw/api/tickets/pdf?locationId=<location.id>&ticket=<ticket number>
Authorization: Bearer whsec_...
Dividia-Customer-Id: <Customer ID>
```

Dividia's answers and what to do with each are in the comments above `sendTicket()` and
`getTicketPdf()`.

## Check it yourself

Open the browser's network view while you press the buttons. The page calls only
`localhost:8787/your-app/...`. No request goes to Dividia from the browser, and the secret is in no
request or response.

## Notes

- The example listens on your own computer only (`127.0.0.1`) and has no sign-in. It is an example,
  not something to deploy.
- It sends a temporary failure (`429`, `5xx`, no answer) again three times. A real system keeps the
  ticket in a queue and retries for longer. The same `uniqueId` never creates a second ticket.
- The secret does not expire. Dividia can replace it (the old one works for 24 more hours) or stop
  it immediately.
