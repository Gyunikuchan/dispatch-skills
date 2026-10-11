# Dispatch diagnostics

Review before sharing. This report holds dispatch-owned data only: no user source, objective, repository paths, or identities. Proposed fixes are unverified.

`—` marks an unavailable value; `~` marks an estimate excluded from measured totals.

## Summary

- Build: dispatch 0.7.0 · build 206cfb13ec7c
- Host: claude · OS: win32
- Runs: 1 · wall time: 2m 53s
- Measured tokens: 681,930 (input 107,894 · cache read 572,459 · cache write — · output 1,577) · coverage 1/1
- Estimated, excluded from measured totals: native and write — · orchestrator ~711
- Host retro: 1 accepted · 0 rejected

Top findings:

1. Instruction clarity · `references/templates/plan.md` · Template marks Test rationale optional-looking and Parent spec format implicit; first AUTHORED drew 9 lint defects (rationale on every criterion, Parent sha256… (host retro)

## Overview

| Run | Phase | Outcome | Wall | Driver | Host | User wait | Invocations | Input | Cache read | Cache write | Output | Coverage |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 · plan · medium | plan | complete | 1m 38s | <1s | 1m 38s | <1s | 0 | — | — | — | — | — |
| 1 · plan · medium | plan review | complete | 1m 14s | 1m 3s | 10s | <1s | 1 | 107,894 | 572,459 | — | 1,577 | 1/1 |
| 1 · plan · medium | all phases | complete | 2m 53s | 1m 3s | 1m 49s | <1s | 1 | 107,894 | 572,459 | — | 1,577 | 1/1 |

### Tokens by provider and model

| Provider | Model | Input | Cache read | Cache write | Output | Coverage |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| agy | all models | 107,894 | 572,459 | — | 1,577 | 1/1 |
| agy | gemini-3.8-flash (configured) | 107,894 | 572,459 | — | 1,577 | — |

## Findings

### 1. Instruction clarity · `references/templates/plan.md`

- Source: host retro `lint-test-rationale-verify` · run 1
- Evidence: Template marks Test rationale optional-looking and Parent spec format implicit; first AUTHORED drew 9 lint defects (rationale on every criterion, Parent sha256, Integration vs task mapping).
- Impact: One extra author round trip before review.
- Proposed fix (unverified): State in the template field notes that every criterion needs Test rationale and a spec Parent needs sha256; or render these as required fields.

## Appendix

<details>
<summary>Invocations and configuration</summary>

| Run | Phase | Provider | Model | Effort | Duration | Input | Cache read | Cache write | Output | Total | Outcome |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | plan review | agy | gemini-3.8-flash | low | 1m 3s | 107,894 | 572,459 | — | 1,577 | 681,930 | ok |

Run 1: verb plan, level medium, pins —, outcome complete.

```json
{
  "diagnostics": true,
  "write-concurrency": 3,
  "read-delegates": {
    "claude": {
      "sandbox": false,
      "targets": [
        {
          "low": {
            "model": "claude-opus-5-5",
            "effort": "low"
          },
          "max": {
            "model": "claude-opus-5-5",
            "effort": "medium"
          }
        }
      ]
    },
    "agy": {
      "targets": [
        {
          "low": {
            "model": "gemini-3.8-flash",
            "effort": "low"
          },
          "high": {
            "model": "gemini-3.8-flash",
            "effort": "medium"
          }
        }
      ]
    },
    "codex": {
      "sandbox": false,
      "targets": [
        {
          "low": {
            "model": "gpt-6.1-sol",
            "effort": "low"
          },
          "max": {
            "model": "gpt-6.1-sol",
            "effort": "medium"
          }
        }
      ]
    },
    "opencode": {
      "sandbox": false,
      "targets": [
        {
          "low": {
            "model": "opencode-go/muse-spark-1.3-contributor",
            "effort": "xhigh"
          }
        },
        {
          "low": {
            "model": "opencode-go/deepseek-v4.1-flash",
            "effort": "high"
          },
          "max": {
            "model": "opencode-go/deepseek-v4.1-flash",
            "effort": "max"
          }
        }
      ]
    }
  },
  "write-subagents": {
    "claude": {
      "low": {
        "model": "claude-haiku-5-5",
        "effort": "high"
      },
      "high": {
        "model": "claude-sonnet-5-5",
        "effort": "medium"
      },
      "max": {
        "model": "claude-opus-5-5",
        "effort": "medium"
      }
    },
    "agy": {
      "low": {
        "model": "gemini-3.8-flash",
        "effort": "medium"
      }
    },
    "codex": {
      "low": {
        "model": "gpt-6-luna",
        "effort": "max"
      },
      "high": {
        "model": "gpt-6.1-sol",
        "effort": "low"
      },
      "max": {
        "model": "gpt-6.1-sol",
        "effort": "medium"
      }
    },
    "opencode": {
      "low": {
        "model": "opencode-go/muse-spark-1.3-contributor",
        "effort": "xhigh"
      }
    }
  },
  "phases": {
    "plan-review": {
      "targets": {
        "low": 0,
        "medium": 1,
        "high": 2,
        "xhigh": 3,
        "max": "all"
      },
      "rounds": {
        "low": 0,
        "medium": 2,
        "high": 3,
        "max": 5
      }
    },
    "code-review": {
      "targets": {
        "low": 1,
        "medium": 2,
        "high": 3,
        "xhigh": 4,
        "max": "all"
      },
      "rounds": {
        "low": 1,
        "medium": 3,
        "max": 5
      }
    }
  }
}
```

</details>
