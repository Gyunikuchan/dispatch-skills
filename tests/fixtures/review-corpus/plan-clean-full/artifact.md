# Add a bounded retry

## Proposed Changes

- [MODIFY] Retry one idempotent request once after a timeout.

## Rollback & Blast Radius

Revert the retry helper.

## Verification Plan

Add timeout, success, and exhausted-retry tests.
