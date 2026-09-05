# Incident response

What Mendr does if something goes wrong with the hosted GitHub App — the piece
that holds customer data. It is written against the system that actually exists
(see [TRUST.md](TRUST.md)), not a generic template. Scope: a suspected or
confirmed compromise, data exposure, or abuse of the App, its database, or its
credentials.

This is an alpha service. The plan is deliberately small and concrete; it grows
as the service does.

## 1. Detection

An incident is suspected from any of:

- an alert from the host (unusual egress, CPU, or a crash loop);
- the App's own error monitoring and structured logs (which never contain
  secrets or source — see below);
- the **audit log** (`audit_log`): unexpected installations, deletions, or a
  burst of ingests can be reconstructed event by event;
- a report through the vulnerability process ([SECURITY.md](SECURITY.md));
- a provider notice (GitHub, the database host, a dependency advisory).

## 2. Internal ownership

One responder owns each incident end to end: triage, decisions, comms, and the
write-up. Until the team is larger, that is the maintainer. The responder may
pull in others but stays accountable for closure. Start an incident note (time,
what was seen, actions taken) at the first sign — it becomes the post-incident
record.

## 3. Credential revocation

Every secret the App holds can be rotated, and none of them is stored in the
database, so revocation is fast and total:

- **GitHub App private key** — generate a new key in the App settings, deploy
  it, delete the old one. In-flight installation tokens (minted in memory, ≤1h)
  expire on their own.
- **Webhook secret** — regenerate in the App settings and in the environment;
  unsigned or wrongly-signed webhooks are already rejected.
- **OAuth client secret** — regenerate in the App settings and the environment.
- **`MENDR_DATA_KEY`** (report encryption) — rotate by prepending a new primary
  key and keeping the old one for existing rows (no migration; see TRUST.md
  "Encryption at rest"). If the key itself is believed exposed, re-encrypt: read
  each row and re-save under the new primary, then drop the old key.
- **`SESSION_SECRET`** — rotate to invalidate every existing sign-in cookie at
  once (signs everyone out).

If GitHub credentials are compromised and cannot be trusted, **suspend or delete
the App installation from GitHub** to cut its access immediately.

## 4. Containment

- Take the App offline or into read-only if active exploitation is suspected —
  the scanner in customers' CI keeps working; only the hosted view/ingest pause.
- Rotate the affected credential(s) per section 3.
- If specific customer data is implicated, use the deletion controls (TRUST.md
  section 5b) to remove it, and record the deletion in the audit log.
- Preserve evidence: snapshot logs and the audit log before any cleanup that
  would erase the trail.

## 5. Customer notification

If a customer's data was or may have been exposed, notify the affected
installation owners directly and promptly, with: what happened, what data was
involved (recall the inventory — installation/repo metadata, and the encrypted
`report`), what we have done, and what they should do (e.g. rotate a provider
key if one could ever have been implicated — though Mendr stores none). Do not
wait for full root cause to send a first honest notice. Follow any breach-
notification obligations that apply.

## 6. Recovery

- Confirm the vulnerability is closed (the fix is deployed, credentials rotated).
- Restore service from a known-good deploy; roll back the release if the
  incident was introduced by one.
- Restore data from backup only from a point known to precede the incident.
- Watch the audit log and monitoring closely for recurrence.

## 7. Post-incident review

Within a week of closure, write a blameless review: timeline, root cause, what
detection or control should have caught it sooner, and concrete follow-ups with
owners. If the incident showed a claim in TRUST.md to be wrong, correct TRUST.md
in the same cycle. Track the follow-ups to done.

## What our logs never contain

Application logs and the audit log are structured and scrubbed: an event name,
ids, a login, counts, a conclusion. They never carry a secret, a token, or
repository source — so sharing a log during an incident does not itself leak
customer content.
