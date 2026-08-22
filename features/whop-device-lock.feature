# Behaviour spec — Whop entitlement + one-device-at-a-time licensing.
#
# Covers the customer journeys around purchase, connecting, changing machines, and
# what happens when a subscription lapses. Written against the REAL, live-verified
# behaviour of functions/api/token.js, functions/api/reset-license.js, and
# functions/api/whop/webhook.js as of 2026-08-22 — every status code and error string
# below was produced by an actual request against production or a real Whop membership,
# not assumed from documentation.
#
# No BDD runner is wired up in this repo yet (unlike the Python monorepo's pytest-bdd
# convention this file otherwise follows) — this is the spec of record for the desktop
# app team and for future test automation, whichever comes first.

Feature: One licence, one device at a time, with a self-serve path to switch machines

  Background:
    Given Brand Gita is distributed and paid for through Whop
    And every desktop app copy carries the same shared "x-api-secret" — it authenticates
      the APP, not the customer
    And a Whop licence key is the thing that authenticates the CUSTOMER

  # ── Buying and connecting for the first time ──────────────────────────────────

  Scenario: A new customer completes checkout and connects on their first machine
    Given a creator has just completed checkout on Brand Gita's Whop plan
    And Whop has issued them a licence key, e.g. "B-1D6B09-5C997A94-F155F5W"
    When they enter that licence key in the desktop app and connect their Instagram account
    Then the app calls POST /api/token with their licence key, a hash of this machine's
      hardware identifier, and their Instagram OAuth code
    And the Worker confirms the licence is active on Whop (checked via `valid`, never a
      status string — see the "membership stays valid mid-cancellation" note below)
    And the Worker binds this machine's device hash to the licence via Whop's
      validate_license (this is the FIRST bind, so it always succeeds)
    And the app receives a desktop_token and is fully connected

  Scenario: The single-use OAuth code must survive a rejected licence
    Given a customer enters an EXPIRED or invalid licence key
    And they authorise Instagram anyway, producing a one-time OAuth code
    When POST /api/token runs
    Then the licence check fails BEFORE the OAuth code is ever exchanged with Instagram
    And the customer sees "Membership is not active (<real Whop status>)"
    And they can retry with a correct licence key without having to grant Instagram
      permission a second time

  # ── The device lock ────────────────────────────────────────────────────────────

  Scenario: The same customer reconnects from the SAME machine
    Given a customer's licence is already bound to their laptop's device hash
    When they reconnect (app update, re-auth, whatever the reason)
    And they send the SAME device hash as before
    Then Whop's validate_license reports a match
    And the connect proceeds normally

  Scenario: A licence is used to connect a SECOND, different machine
    Given a customer's licence is already bound to Machine A
    When Machine B sends a DIFFERENT device hash with the same licence key
    Then the Worker's device check receives a mismatch from Whop
    And POST /api/token returns 409 "This license is already active on another device"
    And Machine B is not connected

  # ── Changing machines ──────────────────────────────────────────────────────────

  Scenario: A customer gets a new laptop and needs to move their licence
    Given a customer's licence is bound to their OLD machine
    And their subscription is currently active
    When they call POST /api/reset-license with their licence key
    Then Whop's device binding is cleared entirely (an unconditional metadata wipe — this
      API has no way to clear one field while preserving another)
    And Brand Gita's own database records the time of this reset
    And their FIRST connect attempt from the NEW machine succeeds and binds to it
    And a later attempt from the OLD machine would now be rejected as the second device

  Scenario: A customer tries to reset again too soon
    Given a customer reset their licence less than 30 days ago
    When they call POST /api/reset-license again
    Then the request is rejected with 429 and a message naming the days remaining
    And Whop is never contacted — the cooldown is enforced entirely from Brand Gita's own
      records, so a repeated reset attempt costs nothing and changes nothing on Whop's side

  Scenario: A cancelled subscription cannot be used to reset a device lock
    Given a customer's subscription has lapsed or been cancelled
    When they call POST /api/reset-license
    Then the request is rejected with 402, regardless of how long it has been since their
      last reset — a dead subscription cannot consume a reset attempt, cooldown or not

  # ── Cancellation ────────────────────────────────────────────────────────────────

  Scenario: A customer cancels their subscription
    Given a customer has an active, connected desktop app
    When their membership.deactivated event fires from Whop
    Then Brand Gita's records mark that membership inactive
    And the desktop token tied to that membership's connected Instagram account is
      revoked immediately — not on their next reconnect attempt, right away
    And the next time the app tries to use that token, it is rejected

  Scenario: A membership stays valid mid-cancellation grace period
    Given a customer has cancelled but their subscription has not yet reached the end of
      their paid period (cancel_at_period_end)
    When they connect or reconnect during that grace window
    Then access is granted — Brand Gita gates on Whop's "valid" field specifically, not on
      the membership's status string, because status vocabulary can say "canceled" before
      access actually ends
