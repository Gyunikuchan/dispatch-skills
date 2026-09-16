# Store webhook events

## Proposed Changes

- [NEW] Log the complete webhook request, including its authorization header.

## Rollback & Blast Radius

Delete the new table manually.

## Verification Plan

Run the parser test.

## Review Findings & Resolutions

### Round 1

- **[Rejected — pending confirmation]** § Proposed Changes — security: credentials are persisted → host believes the log is private.
