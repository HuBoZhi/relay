# Trajectory: Fix automatic group-chat callback refresh

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** November 6, 2026 at 09:59 PM
> **Completed:** November 6, 2026 at 10:02 PM

---

## Summary

Fixed callback-driven group refresh, stream reconciliation and refresh races; 203 tests and 2 browser checks pass; built and deployed locally with data preserved.

**Approach:** Standard approach

---

## Key Decisions

### Refresh group views on callback, stage and task SSE events; reconcile on stream open and retain refreshes received in flight
- **Chose:** Refresh group views on callback, stage and task SSE events; reconcile on stream open and retain refreshes received in flight
- **Reasoning:** The bridge appends group replies while emitting callback.delivered, which the group-only frontend filter dropped.

---

## Chapters

### 1. Work
*Agent: default*

- Refresh group views on callback, stage and task SSE events; reconcile on stream open and retain refreshes received in flight: Refresh group views on callback, stage and task SSE events; reconcile on stream open and retain refreshes received in flight
