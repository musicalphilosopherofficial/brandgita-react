# Instagram collaborator invites on scheduled posts. Approved by the founder in plain language (2026-11-28).
# No BDD runner is wired in this repo; the scenarios are covered by shared/collaborators.test.js,
# functions/api/schedule.collaborators.test.js and cron-worker/collaborators.publish.test.js.
Feature: Invite collaborators on a scheduled Instagram post

  Scenario: Name collaborators when scheduling
    Given a creator is scheduling a reel or a carousel
    When they name up to 3 collaborators
    Then the post is scheduled with those names
    And a leading "@" is removed and a repeated name counts once

  Scenario: Names that cannot be invited are refused
    When a creator names a 4th person, an impossible username, or any collaborator on a Story
    Then nothing is scheduled and they are told why

  Scenario: Change collaborators on a post that has not gone out
    Given a post is still scheduled
    When the creator adds, changes or removes collaborators
    Then nothing is uploaded again
    And the time, caption and media are unchanged

  Scenario: A post already going out cannot be changed
    Given a post is posting or already published
    When the creator tries to change its collaborators
    Then they are refused

  Scenario: See who is invited
    When the creator looks at their schedule
    Then each post shows its collaborators

  Scenario: The invites go with the post
    When a scheduled reel or carousel with collaborators is published
    Then the invitation is sent with the reel, or with the carousel as a whole

  Scenario: Instagram will not accept the collaborators
    Given a scheduled post has collaborators
    When Instagram refuses the post
    Then nothing is published without them
    And the post is shown as failed with a plain-language reason including Instagram's own words

  Scenario: A temporary fault is not a refusal
    Given a scheduled post has collaborators
    When the network or Instagram fails temporarily
    Then it is tried again, still with the collaborators

  Scenario: Posts without collaborators are unaffected
    When a post has no collaborators
    Then it is published exactly as before
