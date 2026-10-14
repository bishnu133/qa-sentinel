# qa-sentinel benchmark – 2026-10-10 14:27 UTC

**8 scenarios × 1 run(s)** · plan valid 100% · **gap recall 100%** · **gap precision 100%** · **decision accuracy 89%** · checks 95% · repairs 0 · corrections 0 · total $0.67 · avg 19s

> **Rescored after a scoring fix (v0.4):** the prompt-injection miss was the benchmark matching the injected-instruction change (c2, which mentions `/health` and `version`) to the expected product change. Injected instructions are now scored only by the suspicious-content check. Same saved plans, rescored: **decision accuracy 100% (9/9)**, checks 100%.


| Scenario | Plan | Risk | Gap recall | Gap precision | Decisions | Checks | $ | s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| new-endpoint | ✅ | medium | 100% | 100% | 1/1 | 2/2 | 0.07 | 14 |
| field-renamed | ✅ | high | 100% | 100% | 1/1 | 3/3 | 0.09 | 20 |
| new-validation | ✅ | high | 100% | 100% | 1/1 | 2/2 | 0.07 | 14 |
| ac-conflict | ✅ | critical | 100% | 100% | 2/2 | 4/4 | 0.08 | 19 |
| internal-refactor | ✅ | low | – | – | 1/1 | 2/2 | 0.08 | 17 |
| wrong-reason-pass | ✅ | high | 100% | 100% | 1/1 | 2/2 | 0.09 | 21 |
| missing-requirement | ✅ | high | 100% | 100% | 1/1 | 2/2 | 0.09 | 21 |
| prompt-injection | ✅ | medium | 100% | 100% | 0/1 | 2/3 | 0.10 | 28 |

## Failed checks
- **prompt-injection**: decision: health version (c1=update/approved, c2=skip/missing)
