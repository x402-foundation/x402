---
"@x402/svm": patch
---

Complete SVM batch server-mode operations only after the channel charge commits, so a channel store that retries or fails a write no longer aborts a valid charge or leaves a completed operation without its charge.
